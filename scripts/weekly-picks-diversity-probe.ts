// scripts/weekly-picks-diversity-probe.ts — READ-ONLY: what the diversity rules actually DID to a
// real subscriber's Friday picks. Internal, never a route, and it never prints a message body.
//
// WHY THIS EXISTS, AND WHY IT IS NOT scripts/friday-preview-real-subscribers.ts. That script
// answers "what will this person receive" and prints the text. This one answers "WHICH RULE moved
// their picks, and what did it cost" — the question `WeeklyPicks.diversity` was added to answer
// and which nothing could read until now. On 2026-09-15 Jon rated four real previews 2/5 to 4/5
// and the diagnosis had to be made by eye, from message text, against a cap that was working
// exactly as written. That is the gap this closes: a diversity rule nobody can observe on real
// data is a rule nobody can tune, which is the same argument `DiversitySummary` makes for itself.
//
// ═══ IT NEVER PRINTS A MESSAGE BODY, WHICH IS WHY IT NEEDS NO SECRET ═══
// friday-preview-real-subscribers.ts REFUSES to run without SMS_SHORT_LINK_SECRET, because a
// placeholder-minted /s/ link does not 404 — it fails its HMAC check and lands on
// /link-unavailable, so a preview reads as a broken product. That reasoning is entirely about
// PRINTING the body. This script reads `plan.picks` and nothing else: no body, no link, no
// preferences token, no phone number, and only the FSA of a postal code. So the refusal does not
// apply, and adding one would be cargo-culting the rule instead of its reason.
//
// ═══ IT REUSES buildWeeklySms RATHER THAN CALLING selectWeeklyPicks ITSELF ═══
// Same discipline the sibling script records: the moment a probe reimplements the geocode, the
// area label or the selection, it stops measuring the real job. Everything below reads the plan
// that the Friday job would produce.
//
// Usage — the four subscribers Jon rated:
//   DATABASE_URL=... npx tsx scripts/weekly-picks-diversity-probe.ts --short-refs 13,21,23,24
//   DATABASE_URL=... npx tsx scripts/weekly-picks-diversity-probe.ts            # every active one
//   ... --now 2026-09-18T23:00:00Z                                              # pin the clock
import { loadActiveSubscribers, loadWeeklySmsDeps } from '../lib/sms/weekly-send-io';
import { buildWeeklySms } from '../lib/sms/weekly-send';
import { closePool, query } from '../lib/db/client';
import type { SmsSubscriber } from '../lib/sms/weekly-send';

/**
 * Subscribers named by `short_ref`, whatever their status.
 *
 * DELIBERATELY NOT `loadActiveSubscribers`' definition of "active", and the difference matters:
 * short_ref 21 — one of the four rows Jon's 2026-09-15 report is about — is `pending`, so the
 * Friday job would not send to it and that function correctly will not return it. Reproducing a
 * REPORTED CASE and predicting a SEND are different questions; this override answers the first
 * and says so rather than quietly widening the second. With no --short-refs, the probe asks the
 * job's own question through the job's own loader.
 */
async function loadByShortRefs(shortRefs: number[]): Promise<SmsSubscriber[]> {
  const rows = await query<{
    id: string; short_ref: string | number; postal_code: string | null;
    birth_years: number[] | null; category_interests: string[] | null;
    consecutive_empty_weeks: number; preferences_token: string | null; consent_text_version: string;
    status: string;
  }>(
    `SELECT id, short_ref, postal_code, birth_years, category_interests,
            consecutive_empty_weeks, preferences_token, consent_text_version, status
       FROM sms_consent
      WHERE short_ref = ANY($1::bigint[])
      ORDER BY short_ref`,
    [shortRefs]
  );
  return rows.map((row) => ({
    id: row.id,
    shortRef: Number(row.short_ref),
    postalCode: row.postal_code ?? '',
    birthYears: row.birth_years ?? [],
    categoryInterests: row.category_interests ?? undefined,
    consecutiveEmptyWeeks: row.consecutive_empty_weeks,
    preferencesToken: row.preferences_token ?? '',
    consentTextVersion: row.consent_text_version,
  }));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const refsArg = arg('--short-refs');
  const nowArg = arg('--now');
  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`--now is not a date: ${nowArg}`);
    process.exit(1);
  }

  // ═══ THE PLACEHOLDER SECRET, AND WHY IT IS SAFE HERE AND NOT IN THE PREVIEW SCRIPTS ═══
  // `buildWeeklySms` mints /s/ links as part of building a plan, and throws without a secret. The
  // sibling preview scripts REFUSE rather than mint against a placeholder, because a token minted
  // with the wrong secret fails its HMAC check and lands the reader on /link-unavailable — it
  // reads as a broken product, and that has already happened once when a body was relayed onward.
  // The whole of that danger is in RELAYING A BODY. This probe never reads `plan.message`, never
  // prints a link and never prints a preferences token, so there is nothing that can be
  // copy-pasted anywhere; the same sentinel value east-van-picks-preview.ts uses is reused so the
  // string is greppable from both sides. A real secret is honoured if one is already set.
  if (!process.env.SMS_SHORT_LINK_SECRET) {
    process.env.SMS_SHORT_LINK_SECRET = 'preview-only-not-the-real-secret';
  }

  const deps = await loadWeeklySmsDeps();
  const subscribers = refsArg
    ? await loadByShortRefs(refsArg.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)))
    : (await loadActiveSubscribers()).map((a) => a.subscriber);

  console.log(`weekly-picks-diversity-probe — clock ${now.toISOString()} — ${subscribers.length} subscriber(s)`);
  if (refsArg) console.log('(--short-refs: a DIAGNOSTIC over named rows, not a prediction of what would send)');

  for (const subscriber of subscribers) {
    const plan = buildWeeklySms({ engine: deps.engine, now, occurrenceShortRefs: deps.occurrenceShortRefs, subscriber });
    // The FSA only — the full postal code is a household-level identifier and this output is
    // relayed onward. `plan.message` is never read; see the header.
    const fsa = (subscriber.postalCode ?? '').replace(/\s+/g, '').slice(0, 3).toUpperCase();
    const ages = subscriber.birthYears.map((y) => now.getFullYear() - y).join(', ');
    console.log('');
    console.log('═'.repeat(78));
    console.log(`short_ref ${subscriber.shortRef}   FSA ${fsa}   child ages ${ages || '(none)'}   ` +
      `interests ${(subscriber.categoryInterests ?? []).join(',') || '(none)'}`);
    console.log(`outcome ${plan.outcome}   picks ${plan.picks?.picks.length ?? 0}   ` +
      `bands ${plan.ageBands.join(',') || '(none)'}   degradation ${plan.picks?.degradation ?? 'n/a'}`);

    const picks = plan.picks;
    if (!picks || picks.picks.length === 0) {
      console.log('no picks — nothing for the diversity rules to have done');
      continue;
    }

    console.log('─ picks, in send order (★ = NAMED, i.e. direct-linked) ─');
    picks.picks.forEach((pick, i) => {
      const named = pick.linkOrigin === 'direct' ? '★' : ' ';
      const km = pick.item.distanceKm == null ? '  ?  ' : `${pick.item.distanceKm.toFixed(1)}km`;
      console.log(
        `${named}${String(i).padStart(2)}  ${(pick.item.listing.primaryCategoryKey || '(none)').padEnd(16)} ` +
          `${km}  ${(pick.item.listing.venueName || '(no venue)').slice(0, 30).padEnd(30)} ` +
          `${pick.item.listing.activityName.slice(0, 44)}`
      );
    });

    const namedKeys = picks.picks.filter((p) => p.linkOrigin === 'direct').map((p) => p.item.listing.primaryCategoryKey || '(none)');
    const distinctNamed = new Set(namedKeys).size;
    console.log(`named activity types: ${namedKeys.join(', ')}  → ${distinctNamed} distinct of ${namedKeys.length}`);

    const d = picks.diversity;
    console.log(
      `diversity: sameOfferingCollapsed=${d.sameOfferingCollapsed} venueCapDeferred=${d.venueCapDeferred} ` +
        `categoryCapDeferred=${d.categoryCapDeferred} dropInReordered=${d.dropInReordered} ` +
        `ageFitBlocked=${d.ageFitBlocked} namedSlotsPermuted=${d.namedSlotsPermuted}`
    );
    // The guaranteed destination slot (2026-09-23): which of its six outcomes fired, and what the
    // pick it seated cost. Printed on every send for the same reason as everything above it.
    const ds = d.destinationSlot;
    console.log(
      `destinationSlot: ${ds.outcome}${ds.reason ? ` (${ds.reason})` : ''}` +
        (ds.occurrenceId
          ? ` ${ds.occurrenceId} distance ${ds.distanceKm == null ? 'n/a' : `${ds.distanceKm.toFixed(1)}km`} ` +
            `rankDepth #${ds.rankDepth ?? '?'} radius ${ds.radiusKm}km bands ${ds.bandsCovered}` +
            (ds.displacedOccurrenceId ? ` displaced ${ds.displacedOccurrenceId} (bands ${ds.displacedBandsCovered})` : '') +
            ` bandsLost [${ds.bandsLost.join(',')}]`
          : '') +
        (ds.widenedSearch ? ' [widened search ran]' : '')
    );
    for (const p of d.promoted) {
      console.log(
        `  promoted[${p.reason}] ${p.occurrenceId} → slot ${p.toIndex} (from ${p.fromIndex}, rankDelta ${p.rankDelta}), ` +
          `displaced ${p.displacedOccurrenceId}, distanceDelta ${p.distanceDeltaKm == null ? 'n/a' : `${p.distanceDeltaKm.toFixed(2)}km`}, ` +
          `bandsGained [${p.bandsGained.join(',')}] bandsLost [${p.bandsLost.join(',')}]`
      );
    }
  }
  await closePool();
}

main().catch(async (e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e));
  await closePool().catch(() => {});
  process.exit(1);
});
