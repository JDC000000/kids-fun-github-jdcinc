// lib/sms/delivery-status.ts — what Twilio tells us happened to a message we sent.
//
// DRAFT (SMS pivot). The other end of the loop lib/sms/twilio-client.ts opens: `dispatchSms`
// hands Twilio a `StatusCallback` URL, and Twilio POSTs back here each time the message changes
// state. app/api/sms/status/route.ts is the thin transport; this holds the parsing and the
// decision, so both are testable without a request.
//
// ── WHY THIS EXISTS NOW AND NOT BEFORE ──────────────────────────────────────────────────
// It was deliberately deferred as "scaffolding on top of scaffolding": there was no real send to
// report a status FROM, so a callback route would have been a webhook for messages that could not
// exist. Round 16 made the dispatch real, and the `StatusCallback` parameter it now sends needs
// somewhere to land.
//
// ── WHAT IT UPDATES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────────────
// It writes `sms_send_log.delivery_status` and NOTHING else. Migration 0035's own header already
// settled this: a row is written when we dispatch, "then again when Twilio's status-callback
// webhook reports the carrier's final verdict. That is a late-arriving fact about the same
// message, not a rewrite of history."
//
// So `outcome` is NOT touched. `outcome = 'sent'` records that WE sent it and is the CASL fact —
// what we did, when, under which consent wording. `delivery_status = 'undelivered'` records what
// the carrier then did with it. Collapsing the second into the first would destroy the first: an
// audit asking "did you text this person on this date" would start getting "no" for messages we
// demonstrably sent.
//
// ── THE CALLBACK ARRIVES MORE THAN ONCE, AND NOT IN ORDER ───────────────────────────────
// Twilio fires this webhook once per state change — `queued`, then `sent`, then `delivered` — and
// those are three independent HTTP requests over the public internet. They can arrive late, out of
// sequence, or twice. Until the guard below, the last one to LAND won, so a `queued` callback that
// took the slow path could overwrite a `delivered` already on the row and silently un-deliver a
// message that arrived. `applyDeliveryStatus` therefore compares lifecycle RANK and only ever moves
// the row forward; see `DELIVERY_STATUS_RANK` for the ordering and why it is the one it is.
//
// ── AND IT CAN ARRIVE BEFORE THE ROW IT DESCRIBES ───────────────────────────────────────
// Every caller dispatches FIRST and writes `sms_send_log` immediately after, because the SID it
// keys on does not exist until Twilio has answered (lib/sms/signup-store.ts, lib/sms/weekly-send-io.ts).
// So there is a real window — small, but two independent async operations wide — in which the
// first status callback is already being handled while the INSERT has not committed. That used to
// be a silent zero-row UPDATE: a real delivery fact, dropped, with nothing anywhere recording that
// it had been. It is now a bounded retry, and an exhausted retry is REPORTED as `no_match` rather
// than looking identical to success.
//
// ── IT ALSO DOES NOT STOP ANYONE ────────────────────────────────────────────────────────
// A delivery failure is not an opt-out. Phones are off, numbers get reassigned, carriers drop
// messages. The two paths into `status = 'stopped'` stay exactly the two PRD §2.2 step 6
// specifies: the inbound STOP webhook, and a 21610 at send time. A third path that guessed from
// undelivered receipts would unsubscribe people who never asked to be — and a `30003` (unreachable
// handset) is the most common delivery failure there is.

import { query } from '@/lib/db/client';
import { verifyTwilioSignature } from './twilio-signature';
import { statusCallbackUrl, twilioAuthToken } from './config';

/**
 * `MessageStatus` values Twilio sends. Transcribed from the SDK's own `MessageStatus` union
 * (node_modules/twilio/lib/rest/api/v2010/account/message.d.ts), not from memory.
 *
 * NOT AN ALLOWLIST THAT REJECTS. Twilio's documentation for this callback warns that the
 * properties "vary by messaging channel and event type and are subject to change" and that it
 * "occasionally adds new properties without advance notice". An unknown status is therefore
 * recorded as-is rather than dropped: `sms_send_log.delivery_status` is a plain text column with
 * no CHECK (0035), precisely so a new Twilio state does not become a failed write.
 */
export const KNOWN_DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  'accepted', 'scheduled', 'queued', 'sending', 'sent', 'receiving', 'received',
  'delivered', 'read', 'undelivered', 'failed', 'partially_delivered', 'canceled',
]);

/** Statuses that mean the carrier is done and it did not arrive. */
export const FAILED_DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  'undelivered',
  'failed',
  'canceled',
]);

/**
 * HOW FAR THROUGH THE LIFECYCLE EACH STATUS IS. The whole of the out-of-order defence.
 *
 * ═══ WHY A RANK AND NOT A TIMESTAMP ═══
 * The obvious alternative is "keep the newest callback" — but the payload carries no timestamp we
 * can trust for this, and `now()` at the receiver measures when the webhook was DELIVERED TO US,
 * which is exactly the thing that is out of order. Rank orders the statuses by what they mean, and
 * that ordering does not depend on the network.
 *
 * ═══ WHY THIS ORDERING, AND NOT ONE INVENTED HERE ═══
 * It follows how the REST OF THE CODEBASE already reasons about these values, which was read
 * before it was chosen rather than after:
 *   • lib/admin/sms-engagement.ts counts `delivery_status = 'delivered'` as the success terminal
 *     and `IN ('failed','undelivered')` as the failure terminal. Those three are the numbers on
 *     the engagement dashboard, and a late `queued` overwriting any of them silently moves a
 *     subscriber out of BOTH columns — the dashboard does not go wrong, it goes quiet.
 *   • lib/admin/sms-subscribers.ts shows the raw value per send row, so a regression there is
 *     read by a human as the carrier's current verdict.
 *   • FAILED_DELIVERY_STATUSES above already treats undelivered/failed/canceled as "the carrier is
 *     DONE and it did not arrive" — done is done, so they rank with `delivered`, not below it.
 * So the load-bearing property is narrow and stated once: A TERMINAL VERDICT IS NEVER REPLACED BY
 * AN IN-FLIGHT ONE. The graded ordering among the in-flight states is Twilio's own documented
 * progression and costs nothing extra.
 *
 * ═══ EQUAL RANK IS A NO-OP, NOT AN UPDATE ═══
 * `delivered` and `failed` share a rank, and so do two copies of the same callback. Twilio does
 * not send both verdicts for one message, so an equal-rank arrival is a DUPLICATE — no new
 * information — and applying it would let two retries of one callback race to write the same row
 * for no gain. Strictly-greater is the comparison; see `applyDeliveryStatus`.
 *
 * ═══ `receiving`/`received` ARE DELIBERATELY ABSENT ═══
 * They are in KNOWN_DELIVERY_STATUSES because that set is the SDK's `MessageStatus` union
 * transcribed whole, but they describe an INBOUND message. They cannot occur on a status callback
 * for a message we sent, so ranking them would be inventing a position for a value that never
 * arrives. They fall to UNRANKED_DELIVERY_RANK with everything else we do not recognise.
 */
export const DELIVERY_STATUS_RANK: ReadonlyMap<string, number> = new Map([
  // In flight — Twilio's documented progression for an outbound message.
  ['scheduled', 0],
  ['accepted', 1],
  ['queued', 2],
  ['sending', 3],
  ['sent', 4],
  // 5 is UNRANKED_DELIVERY_RANK. Nothing we recognise sits there, on purpose.
  // Terminal: the carrier is done, whatever the verdict was.
  ['delivered', 6],
  ['undelivered', 6],
  ['failed', 6],
  ['canceled', 6],
  ['partially_delivered', 6],
  // Strictly after `delivered`, and only on channels that report it (WhatsApp/RCS).
  ['read', 7],
]);

/**
 * Where a status we do not recognise sits: ABOVE every in-flight state, BELOW every terminal one.
 *
 * NEITHER EXTREME IS SAFE, WHICH IS WHY THIS IS ITS OWN CONSTANT.
 *   • Ranking an unknown status LOWEST would drop it whenever the row had moved past `queued` —
 *     and Twilio documents that it adds states without notice. A new TERMINAL state (WhatsApp
 *     already has one this union does not carry) would then leave the row reading `queued` for
 *     ever, which is the "silently no new information" failure this whole file is about.
 *   • Ranking it HIGHEST would let any unrecognised string displace `delivered` — including the
 *     one thing this guard exists to prevent, just spelled differently.
 * Between the two, an unknown status is recorded over anything still in flight and never over the
 * carrier's final verdict. That is the same trade this file's header already makes for the write
 * itself: record it as-is rather than drop it, but never at the cost of a fact we are sure of.
 */
export const UNRANKED_DELIVERY_RANK = 5;

/** The lifecycle position of `status`, defaulting unrecognised values per the constant above. */
export function deliveryStatusRank(status: string): number {
  return DELIVERY_STATUS_RANK.get(status) ?? UNRANKED_DELIVERY_RANK;
}

export interface DeliveryStatusReport {
  /** `MessageSid` — matches `sms_send_log.twilio_sid`, which 0035 indexes for exactly this. */
  twilioSid: string;
  /** `MessageStatus`, recorded verbatim. */
  status: string;
  /**
   * `ErrorCode`, present when the status is failed or undelivered.
   *
   * PERSISTED, as of migration 0043 — it used to be parsed here and then dropped, which left
   * `sms_send_log` able to say a message did not arrive and unable to say why. See that
   * migration for what the codes distinguish and why a log line was not good enough.
   */
  errorCode: number | null;
}

export type DeliveryStatusOutcome =
  /** Verified, parsed, and the row moved forward. */
  | 'applied'
  /**
   * Verified and parsed, and the row was found — but it already holds a status at or beyond this
   * one, so this callback carried no new information. A late `queued` behind a `delivered`, or the
   * same callback twice. NOT an error and NOT a failure: this is the guard doing its job.
   */
  | 'ignored'
  /**
   * Verified and parsed, but no `sms_send_log` row carries this SID — still not, after the retry
   * budget below. Distinct from `applied` ON PURPOSE: it used to be indistinguishable from it,
   * which is how a lost delivery receipt could look exactly like a recorded one.
   */
  | 'no_match'
  /** Verified and parsed, but nothing was written because writing is disabled. */
  | 'dry_run'
  /** The signature did not verify, or the environment is unconfigured. Nothing was read. */
  | 'unverified'
  /** Verified but missing `MessageSid` or `MessageStatus`. Nothing to record. */
  | 'malformed'
  /** The write failed. */
  | 'error';

export interface DeliveryStatusResult {
  outcome: DeliveryStatusOutcome;
  report: DeliveryStatusReport | null;
  /** Never contains a phone number or a message body. */
  error?: string;
}

/**
 * Pull the report out of a verified callback body.
 *
 * `MessageSid` FIRST, `SmsSid` AS A FALLBACK. Twilio's own example payload carries both, with
 * identical values — `SmsSid` is the legacy alias. Reading the modern name first and accepting
 * the old one costs one `??` and means a channel that only sends one of them still works.
 *
 * AN UNPARSEABLE `ErrorCode` BECOMES NULL RATHER THAN NaN. It is absent on every successful
 * status, so "not a number" is the normal case, not an exceptional one.
 */
export function parseDeliveryStatus(params: URLSearchParams): DeliveryStatusReport | null {
  const twilioSid = (params.get('MessageSid') ?? params.get('SmsSid') ?? '').trim();
  const status = (params.get('MessageStatus') ?? params.get('SmsStatus') ?? '').trim();
  if (!twilioSid || !status) return null;
  const rawCode = Number(params.get('ErrorCode'));
  return {
    twilioSid,
    status,
    errorCode: Number.isFinite(rawCode) && rawCode !== 0 ? rawCode : null,
  };
}

/** What one write attempt did. Reported all the way out, because the three differ operationally. */
export type DeliveryStatusWrite =
  /** The row moved forward to this status. */
  | 'applied'
  /** The row exists and already holds a status at or beyond this one. Nothing to do. */
  | 'ignored'
  /** No row carries this SID, and none appeared within the retry budget. */
  | 'no_match';

/**
 * Record the carrier's verdict against the send row.
 *
 * The seam, so the route is testable without a database. The single implementation below is
 * `applyDeliveryStatus`, and it carries the reasoning for the query it issues.
 */
export type DeliveryStatusWriter = (report: DeliveryStatusReport) => Promise<DeliveryStatusWrite>;

/**
 * How long to wait for a row that has not been INSERTed yet, and how many times.
 *
 * FOUR ATTEMPTS, 500ms OF WAITING IN TOTAL. The window this covers is the gap between
 * `dispatchSms` returning a SID and `recordSmsSend` committing the row that carries it — the very
 * next thing the caller does — so it closes in milliseconds. The schedule is deliberately far
 * larger than that and still far short of Twilio's webhook timeout. The delays grow rather than
 * repeat so the common case (the row landed while the first UPDATE was in flight) costs 50ms
 * rather than the whole budget.
 *
 * BOUNDED, BECAUSE THE ROW MAY GENUINELY NEVER EXIST — a send whose log write failed, or a message
 * sent from the Twilio console. Waiting longer would not conjure one; it would just hold a webhook
 * connection open. When the budget runs out the caller is TOLD (`no_match`), which is the actual
 * fix: the old code could not tell that case from success.
 */
export const DELIVERY_STATUS_RETRY_DELAYS_MS: readonly number[] = [50, 150, 300];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * THE MONOTONIC GUARD IS IN THE `WHERE` CLAUSE, NOT IN JAVASCRIPT, and that is the point.
 *
 * Reading the current status and then deciding in TS would be a check-then-act race between two
 * callbacks arriving at two serverless instances at once — precisely the shape of bug this fixes,
 * reintroduced one layer up. As a predicate on the UPDATE it is a compare-and-set: under READ
 * COMMITTED, an UPDATE that collides with a concurrent one waits for it and then RE-EVALUATES its
 * own WHERE against the row the winner left behind. So the loser of a `delivered` vs late-`queued`
 * race re-reads `delivered`, fails the predicate, and writes nothing. Same mechanism the JOIN
 * consent write uses (`applyConsentChange`'s `WHERE id = $1 AND status = $2`).
 *
 * THE RANK TABLE STAYS THE ONLY COPY. The predicate is fed the status NAMES derived from
 * `DELIVERY_STATUS_RANK` rather than a CASE expression restating the ranks in SQL — a second copy
 * of an ordering is a second thing to forget to update.
 *   $4 blocks: every ranked status at or above the incoming one (equal rank included — a duplicate
 *      carries no new information).
 *   $5/$6 block the unranked bucket: when the incoming status is itself at or below
 *      UNRANKED_DELIVERY_RANK, a stored status we do not recognise also blocks it. `<> ALL($6)` is
 *      "the stored value is not in the rank table", which is what unranked means.
 */
export const applyDeliveryStatus: DeliveryStatusWriter = async (report) => {
  const incoming = deliveryStatusRank(report.status);
  const ranked = [...DELIVERY_STATUS_RANK.keys()];
  const blocking = ranked.filter((s) => (DELIVERY_STATUS_RANK.get(s) as number) >= incoming);
  const unrankedBlocks = incoming <= UNRANKED_DELIVERY_RANK;

  for (let attempt = 0; ; attempt++) {
    // ONLY `delivery_status` and its error code. Not `outcome` — see this file's header: `outcome`
    // is the CASL record of what WE did, and the callback is a later fact about what the carrier
    // then did with it.
    //
    // KEYED ON `twilio_sid`, which is why 0035 indexes it — `idx_sms_send_log_twilio_sid` exists
    // for this callback and nothing else. NOT on the phone number: `To` is in the payload, but
    // matching on it would hold a number in a route with no need of one AND would hit the wrong
    // row for a number that has since been re-subscribed.
    //
    // `delivery_error_code` is written by the SAME statement, so the code on a row always belongs
    // to the status on that row. Assigned rather than COALESCEd: a status that advances brings its
    // own explanation, and keeping the previous code would attach a reason to a verdict it was
    // never about.
    const advanced = await query<{ id: string }>(
      `UPDATE sms_send_log
          SET delivery_status = $1,
              delivery_error_code = $2
        WHERE twilio_sid = $3
          AND (
            delivery_status IS NULL
            OR NOT (
                 delivery_status = ANY($4::text[])
                 OR ($5::boolean AND delivery_status <> ALL($6::text[]))
               )
          )
        RETURNING id`,
      [report.status, report.errorCode, report.twilioSid, blocking, unrankedBlocks, ranked]
    );
    if (advanced.length > 0) return 'applied';

    // Zero rows has TWO causes and they are not the same event. Separating them costs one indexed
    // lookup on a path that, by construction, only runs when nothing was written.
    const [existing] = await query<{ id: string }>(
      `SELECT id FROM sms_send_log WHERE twilio_sid = $1 LIMIT 1`,
      [report.twilioSid]
    );
    if (existing) return 'ignored'; // the row is there; the guard declined. Settled, not retryable.

    // NOT AN UPSERT — and this is a considered refusal, not a shortcut. A status callback carries
    // a SID and a status. It does NOT carry `phone_hash` (NOT NULL), `send_type`, `outcome` or
    // `consent_text_version` (all NOT NULL, two of them CHECK-constrained), so a row invented here
    // could only be filled with placeholders — a fabricated entry in a CASL audit trail, which is
    // the one thing migration 0035's header rules out. There is also no unique constraint on
    // `twilio_sid` (0035 creates a plain partial index), so `ON CONFLICT` is not even available to
    // keep it from duplicating the real INSERT when that lands a moment later.
    if (attempt >= DELIVERY_STATUS_RETRY_DELAYS_MS.length) return 'no_match';
    await sleep(DELIVERY_STATUS_RETRY_DELAYS_MS[attempt]);
  }
};

export interface DeliveryStatusOptions {
  /**
   * Defaults to FALSE — this write is deliberately NOT gated on `SMS_SENDING_ENABLED`, unlike
   * every other write on this branch, and the divergence is the point rather than an oversight.
   *
   * A status callback can only ever arrive for a message that was actually sent. If sending were
   * disabled, no message went out and no callback exists to receive. So the flag cannot protect
   * anything here — it can only cause harm: turning sending off would silently discard delivery
   * receipts for messages ALREADY IN FLIGHT, losing the carrier's verdict on real texts to real
   * parents. Recording what happened to a message we already sent is not sending.
   *
   * The flag remains explicit for tests, which need to exercise the parse without a writer.
   */
  dryRun?: boolean;
  /** Injected for tests; defaults to the real writer above. */
  write?: DeliveryStatusWriter;
  /** Injected for tests; defaults to reading the configured token. */
  authToken?: string | null;
  /** Injected for tests; defaults to the configured callback URL. */
  url?: string | null;
}

/**
 * Verify, parse and record one delivery-status callback. NEVER THROWS.
 *
 * THE SIGNATURE CHECK IS FIRST AND FAILS CLOSED, exactly as on the inbound message webhook. This
 * URL is public, and without it anyone who learned it could POST `MessageStatus=delivered` for
 * any SID and corrupt the delivery record — or, more cheaply, discover which SIDs exist.
 *
 * THE PARAMS ARE VERIFIED AS SENT, whatever they are. Twilio warns that it "occasionally adds new
 * properties without advance notice" and that an implementation must "accept and correctly run
 * signature validation on an evolving set of parameters". Verifying over the whole `URLSearchParams`
 * rather than a list of expected fields is what makes that true here by construction.
 */
export async function recordDeliveryStatus(
  params: URLSearchParams,
  signature: string | null,
  options: DeliveryStatusOptions = {}
): Promise<DeliveryStatusResult> {
  const verified = verifyTwilioSignature({
    authToken: options.authToken !== undefined ? options.authToken : twilioAuthToken(),
    url: options.url !== undefined ? options.url : statusCallbackUrl(),
    params,
    signature,
  });
  if (!verified) return { outcome: 'unverified', report: null };

  const report = parseDeliveryStatus(params);
  if (!report) return { outcome: 'malformed', report: null };

  if (options.dryRun) return { outcome: 'dry_run', report };

  try {
    // The writer's own verdict IS the outcome — `applied` / `ignored` / `no_match` are all members
    // of DeliveryStatusOutcome. Flattening them into one would put back exactly the ambiguity that
    // let a dropped delivery receipt read as a recorded one.
    const write = await (options.write ?? applyDeliveryStatus)(report);
    return { outcome: write, report };
  } catch (err) {
    return {
      outcome: 'error',
      report,
      error: (err as Error)?.message ?? 'unknown error',
    };
  }
}
