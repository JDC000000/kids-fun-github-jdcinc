// scripts/friday-preview-real-subscribers.ts — the EXACT body each real active subscriber will
// receive on Friday. Internal, read-only, never a route.
//
// Jon, via the Operator, 2026-09-02. The sibling script east-van-picks-preview.ts previews a
// SYNTHETIC family for a postal code; this one previews the real ones. Same builder, same deps,
// different subscriber source — that is the only difference, and it is deliberate: the moment
// this reimplements any part of selection or rendering, it stops predicting the real job.
//
// ═══ IT REUSES loadActiveSubscribers() RATHER THAN QUERYING sms_consent ITSELF ═══
// That function is what the Friday job uses, including `AND phone_number IS NOT NULL` — a purged
// row is not a subscriber (migration 0034). A hand-written query here could quietly drift from
// the job's definition of "active" and preview a message for somebody who will not be sent one.
// Faithfulness beats a narrower SELECT.
//
// ═══ THE PHONE NUMBER IS NEVER TOUCHED ═══
// loadActiveSubscribers returns { subscriber, phoneNumber } — the number travels BESIDE the
// subscriber, never on it. This script destructures `subscriber` only. `phoneNumber` is never
// read, never logged, never formatted. Nor is the full postal code: the FSA (first three
// characters) is printed instead, which is enough for the Operator to confirm the right area
// without putting a household-level identifier in a message body that gets relayed onward.
//
// ═══ REFUSES WITHOUT THE REAL SECRET. NO ESCAPE HATCH. ═══
// east-van-picks-preview.ts has PREVIEW_ALLOW_FAKE_LINKS for previewing synthetic families.
// THIS SCRIPT DELIBERATELY HAS NO EQUIVALENT. A placeholder-minted link does not 404 — it fails
// its HMAC check and lands on FALLBACK_DESTINATION (lib/sms/click-through.ts), which since
// 2026-09-11 is /link-unavailable: a page that tells the reader their link did not work. So it
// reads as a broken product rather than a preview artifact. That already happened once with
// synthetic content. Doing it with a real subscriber's real picks is strictly worse, so the
// option to proceed anyway simply does not exist here.
import { loadActiveSubscribers, loadWeeklySmsDeps } from '../lib/sms/weekly-send-io';
import { buildWeeklySms } from '../lib/sms/weekly-send';
import { closePool } from '../lib/db/client';

async function main(): Promise<void> {
  if (!process.env.SMS_SHORT_LINK_SECRET) {
    console.error('REFUSING TO RUN: SMS_SHORT_LINK_SECRET is not set.');
    console.error('');
    console.error('Every /s/ link would be minted against a placeholder. Those links do NOT 404 —');
    console.error('they fail the HMAC check and land on /link-unavailable, which tells the reader');
    console.error('their link is broken — a broken PRODUCT, not a preview. This script has no');
    console.error('override for that, on purpose:');
    console.error('it previews a REAL subscriber, where that failure is worse than it was for the');
    console.error('synthetic East Van preview, where it already happened once.');
    process.exit(1);
  }

  const now = new Date();
  const [deps, actives] = await Promise.all([loadWeeklySmsDeps(), loadActiveSubscribers()]);

  console.log(`FRIDAY PREVIEW — real active subscribers — generated ${now.toISOString()}`);
  console.log(`active subscribers found: ${actives.length}`);
  console.log('');
  if (actives.length === 0) {
    console.log('No active subscribers. Nothing would be sent. (Not an error.)');
    await closePool();
    return;
  }

  for (const [i, active] of actives.entries()) {
    // `subscriber` ONLY. `active.phoneNumber` is deliberately never referenced.
    const { subscriber } = active;
    const plan = buildWeeklySms({
      engine: deps.engine,
      now,
      occurrenceShortRefs: deps.occurrenceShortRefs,
      subscriber,
    });

    const fsa = (subscriber.postalCode ?? '').replace(/\s+/g, '').slice(0, 3).toUpperCase();
    const ages = subscriber.birthYears.map((y) => now.getFullYear() - y).join(', ');
    console.log('═'.repeat(72));
    console.log(`SUBSCRIBER ${i + 1} of ${actives.length}   FSA ${fsa}   child ages ${ages || '(none)'}`);
    console.log(
      `outcome: ${plan.outcome}   picks: ${plan.picks?.picks.length ?? 0}   ` +
        `area: ${plan.areaLabel ?? '(none)'}`
    );
    if (!plan.message) {
      console.log('NO MESSAGE — this subscriber would receive nothing this week.');
      console.log('');
      continue;
    }
    console.log(`segments: ${plan.message.segments}   characters: ${plan.message.body.length}`);
    console.log('─'.repeat(72));
    // ═══ THE PREFERENCES TOKEN IS REDACTED. IT IS A CREDENTIAL, NOT COPY. ═══
    // The body contains this subscriber's no-login hub link. app/u/[preferencesToken] renders
    // their child's ages and household postal code, which is why that page sets noindex/nofollow
    // and no-store and its own comment calls an escaped link "the difference between a leaked
    // link and a published one". This output is relayed agent -> DO -> Operator, i.e. exactly the
    // paste-it-somewhere path that comment warns about.
    //
    // Segment count and character count above are computed on the REAL body, before redaction,
    // so the numbers Jon reviews are the true ones. Only what is printed changes, and the
    // placeholder is the same length as a real token so the line wraps as it really would.
    const token = subscriber.preferencesToken;
    const redacted = token
      ? plan.message.body.split(token).join('#'.repeat(token.length))
      : plan.message.body;
    console.log(redacted);
    if (token && redacted !== plan.message.body) {
      console.log('');
      console.log(`(the ###… above is this subscriber's live preferences token, redacted —`);
      console.log(' that URL opens their hub with no login, so it is not pasted into a relay)');
    }
    console.log('');
  }
  await closePool();
}

main().catch(async (e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e));
  await closePool().catch(() => {});
  process.exit(1);
});
