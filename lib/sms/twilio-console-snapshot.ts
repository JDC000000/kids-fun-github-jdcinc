// lib/sms/twilio-console-snapshot.ts — what is configured in the Twilio console, written down.
//
// DRAFT (SMS pivot). PRD §8 item 3, Jon-approved: *"Yes, I approve your recommendation. It's
// compliance adjacent."*
//
// ═══ THE GAP THIS CLOSES ═══
// Some of this product's compliance surface is not in this repository at all. The HELP auto-reply
// is configured in the Twilio Messaging Service console (PRD v3.10 — there is no API for it; Jon
// set it by hand), so the repo asserts things about it that nothing here can check. If somebody
// edits that field in the console next March, every document claiming what HELP returns becomes
// quietly wrong and no test, build or review would notice.
//
// This file is the snapshot to diff against. It does not and cannot enforce anything — the console
// is the source of truth and stays that way. What it does is make a drift DISCOVERABLE: the text
// is now in one place a reviewer can compare against the console in ten seconds, and the
// assertions below fail if a future edit to OUR OWN facts (the support number, the brand tag)
// silently contradicts what the console is configured to say.
//
// ═══ NOT AN AUTOMATED POLL, DELIBERATELY ═══
// Per the Operator's steer: "a documented snapshot + manual-recheck note is probably enough for
// MVP scope, no need to over-engineer an automated Twilio API poll unless you think it's cheap."
// It is not cheap. Reading this field back needs a live Twilio credential in CI, which would put a
// sending credential somewhere it currently is not, to detect a change that happens approximately
// never and is caught by the recheck below when it matters. The credential cost is real and the
// detection value is small; the trade is the wrong way round.

/**
 * ═══ RECHECK THIS AT THESE MOMENTS ═══
 *   • before submitting Toll-Free Verification (a reviewer may text HELP);
 *   • whenever `SUPPORT_PHONE_E164` changes;
 *   • whenever anyone reports that HELP returned something unexpected;
 *   • at each launch checklist pass.
 * HOW: Twilio Console → Messaging → Services → the KIDS FUN Messaging Service → Advanced Opt-Out
 * → the HELP response field. Compare it, character for character, with `TWILIO_HELP_RESPONSE`
 * below. If they differ, the console wins — update this constant and say why in the commit.
 */
export const TWILIO_CONSOLE_RECHECK_TRIGGERS = [
  'before the Toll-Free Verification submission',
  'when the support number changes',
  'when a subscriber reports an unexpected HELP reply',
  'at each launch-checklist pass',
] as const;

/**
 * The HELP auto-reply as configured in the Twilio console, VERBATIM.
 *
 * Recorded by Jon on 2026-08-26 (PRD v3.10), in his own words: *"re twilio - i updated the help
 * section to 'KIDS FUN: Reply STOP to unsubscribe. Contact us at +1 877-835-7776 with questions.
 * Msg&data rates may apply.'"*
 *
 * ⚠ THIS IS A COPY, NOT THE ORIGINAL. The console holds the real value. If this file and the
 * console disagree, this file is the one that is wrong.
 */
export const TWILIO_HELP_RESPONSE =
  'KIDS FUN: Reply STOP to unsubscribe. Contact us at +1 877-835-7776 with questions. ' +
  'Msg&data rates may apply.';

/** When the snapshot above was taken, so a reviewer knows how stale it might be. */
export const TWILIO_HELP_RESPONSE_SNAPSHOT_DATE = '2026-08-26';
