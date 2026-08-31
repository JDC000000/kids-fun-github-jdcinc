// lib/sms/waitlist-notify.ts — composing (and, once permitted, dispatching) the ONE waitlist text.
//
// ⛔ THE GATE IS THE FIRST THING THIS MODULE DOES, and it is NOT `smsSendingEnabled()`.
// Jon authorised building the waitlist and separately withheld authority to send from it until the
// Operator rechecks the Twilio console and filing — because this is the first message the product
// has ever sent to somebody who never opted into the weekly picks. See
// TWILIO_CONSOLE_RECHECK_TRIGGERS' fifth entry, which exists for exactly this moment.
//
// So `waitlistNotificationsEnabled()` defaults false and is the ONLY thing that may permit a send.
// With it off, everything here still runs: rows are selected, messages are composed, and the
// result says precisely what WOULD have gone out. That is the "compose and stage, do not dispatch"
// the instruction asked for — the pipeline is complete and its last step is closed.
import { query } from '@/lib/db/client';
import { REGION_LABEL, type CoveredRegionId } from '@/lib/geo/postal-fsa';
import { waitlistNotificationsEnabled } from './config';
import { signupUrl } from './config';
import { renderWaitlistNotification } from './waitlist-copy';
import { estimateSegments } from './message';
import { dispatchSms, type DispatchResult, type TwilioMessageSender } from './twilio-client';

export interface WaitlistRecipient {
  id: string;
  phoneNumber: string;
  regionChipId: string | null;
  areaFsa: string | null;
}

export interface StagedWaitlistMessage {
  id: string;
  phoneNumber: string;
  body: string;
}

/**
 * The label the notification names.
 *
 * A municipality gets its real name. An out-of-area FSA gets "your area" — deliberately, because
 * "V3S" means nothing to a parent and printing it would read as a database leaking into a text.
 * The FSA is how WE find them; it is not how they think about where they live.
 */
export function areaLabelFor(recipient: WaitlistRecipient): string {
  if (recipient.regionChipId) {
    return REGION_LABEL[recipient.regionChipId as CoveredRegionId] ?? 'your area';
  }
  return 'your area';
}

/**
 * PURE. Compose what would be sent, for review or for dispatch. No I/O, so the copy that reaches a
 * phone is testable without a database or a Twilio account.
 */
export function composeWaitlistNotifications(
  recipients: readonly WaitlistRecipient[],
  site: string
): StagedWaitlistMessage[] {
  return recipients.map((r) => ({
    id: r.id,
    phoneNumber: r.phoneNumber,
    body: renderWaitlistNotification(areaLabelFor(r), site),
  }));
}

/** Who is still waiting for an area, and has not opted out. */
export async function loadWaitingFor(areaKey: string): Promise<WaitlistRecipient[]> {
  return query<WaitlistRecipient>(
    `SELECT id, phone_number AS "phoneNumber", region_chip_id AS "regionChipId",
            area_fsa AS "areaFsa"
       FROM sms_area_waitlist
      WHERE coalesce(region_chip_id, area_fsa) = $1
        AND notified_at IS NULL
        AND unsubscribed_at IS NULL
      ORDER BY created_at`,
    [areaKey]
  );
}

export interface WaitlistNotifyResult {
  /** `false` means the gate is shut and nothing was dispatched — the default. */
  permitted: boolean;
  staged: StagedWaitlistMessage[];
  results: DispatchResult[];
}

/**
 * Send the notifications for one area — or, with the gate shut, compose them and send nothing.
 *
 * ═══ THE GATE IS EXPRESSED AS `dryRun`, WHICH IS THE POINT ═══
 * `waitlistNotificationsEnabled()` is read ONCE, here, and becomes `dryRun` on every dispatch.
 * That reuses the mechanism the rest of the product already trusts to mean "build everything,
 * send nothing", rather than inventing a second way to be off — and it means the closed state
 * exercises the SAME code path as the open one, so the pipeline cannot be complete-looking and
 * broken at the moment somebody finally opens it.
 *
 * ⚠ IT DOES NOT READ smsSendingEnabled(). That flag is already true in production; if this
 * consulted it, the gate would have been open from the moment the code merged, which is exactly
 * what Jon withheld.
 *
 * ⚠ NOTHING HERE STAMPS notified_at. Marking a row as notified is the caller's job, once it knows
 * a real send succeeded — doing it inside a dry run would tell the database we had kept a promise
 * we had not.
 */
export async function notifyWaitlistFor(
  areaKey: string,
  options: { client?: TwilioMessageSender | null } = {}
): Promise<WaitlistNotifyResult> {
  const permitted = waitlistNotificationsEnabled();
  const recipients = await loadWaitingFor(areaKey);
  const staged = composeWaitlistNotifications(recipients, signupUrl());

  const results: DispatchResult[] = [];
  for (const message of staged) {
    results.push(
      await dispatchSms(
        message.phoneNumber,
        { body: message.body, ...estimateSegments(message.body) },
        { dryRun: !permitted, ...(options.client !== undefined ? { client: options.client } : {}) }
      )
    );
  }
  return { permitted, staged, results };
}
