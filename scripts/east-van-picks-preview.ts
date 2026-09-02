// scripts/east-van-picks-preview.ts — render the ACTUAL weekly SMS body for a postal code.
//
// One-off internal preview (Jon, via the Operator, 2026-09-02). READ-ONLY: it loads the search
// read model and the occurrence short-ref map, then calls the SAME pure builder the Friday job
// calls. It writes nothing, queues nothing, and dispatches nothing.
//
// ═══ POSTAL-SCOPED, NOT SUBSCRIBER-SCOPED — ON PURPOSE ═══
// Jon wants to see what an East Van message looks like, not what a particular person receives.
// Keying on a postal code means this touches NO sms_consent row and NO phone number, so the PII
// question does not arise rather than being managed. The subscriber below is entirely synthetic.
//
// ═══ WHY IT CALLS buildWeeklySms RATHER THAN REBUILDING THE PIPELINE ═══
// buildWeeklySms is exported and pure, and is exactly what lib/sms/weekly-send-io.ts invokes per
// subscriber. Reimplementing selection + link-minting + rendering here would have produced a
// preview that drifts from the real job precisely when the job changes — the failure mode where
// the preview keeps looking right after it has stopped being true.
import { loadWeeklySmsDeps } from '../lib/sms/weekly-send-io';
import { buildWeeklySms } from '../lib/sms/weekly-send';
import { closePool } from '../lib/db/client';

// Overridable so whoever runs this against production can try other ages/areas without editing
// the file. Defaults are the Operator's (ages 4 and 8, two East Vancouver FSAs).
//   AGES=4,8 POSTALS="V5K 0A1,V5N 1A1" RADIUS_KM=15 npx tsx scripts/east-van-picks-preview.ts
const AGES = (process.env.AGES ?? '4,8')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0) // AGES="" must mean NO age filter, not age 0 — Number('') is 0
  .map(Number)
  .filter((n) => Number.isFinite(n));
const POSTALS = (process.env.POSTALS ?? 'V5K 0A1,V5N 1A1').split(',').map((s) => s.trim());
const RADIUS_KM = process.env.RADIUS_KM ? Number(process.env.RADIUS_KM) : undefined;

async function main(): Promise<void> {
  const now = new Date();
  const year = now.getFullYear();
  const birthYears = AGES.map((a) => year - a);

  if (!process.env.SMS_SHORT_LINK_SECRET) {
    process.env.SMS_SHORT_LINK_SECRET = 'preview-only-not-the-real-secret';
    console.log('⚠ SMS_SHORT_LINK_SECRET was unset. A placeholder was used, so the /s/ links');
    console.log('  below are STRUCTURALLY correct but will not resolve. Everything else is real.');
    console.log('');
  }

  const deps = await loadWeeklySmsDeps();

  for (const postalCode of POSTALS) {
    const plan = buildWeeklySms({
      engine: deps.engine,
      now,
      occurrenceShortRefs: deps.occurrenceShortRefs,
      subscriber: {
        id: 'PREVIEW-not-a-real-subscriber',
        shortRef: 1,
        postalCode,
        birthYears,
        ...(RADIUS_KM ? { radiusKm: RADIUS_KM } : {}),
        consecutiveEmptyWeeks: 0,
        preferencesToken: 'PREVIEWTOKEN0000',
        consentTextVersion: 'preview',
      },
    });

    console.log('═'.repeat(72));
    console.log(`POSTAL ${postalCode}   ages ${AGES.join(' and ')}   generated ${now.toISOString()}`);
    // `message` and `picks` are nullable on the plan — an out-of-area postal or a week with
    // nothing eligible is a real outcome, not an error, and the preview has to be able to show
    // that honestly rather than crash or print an empty body as though it were the message.
    console.log(
      `outcome: ${plan.outcome}   picks: ${plan.picks?.picks.length ?? 0}   ` +
        `area: ${plan.areaLabel ?? '(none)'}`
    );
    if (!plan.message) {
      console.log('NO MESSAGE — this postal/age combination produces no send this week.');
      console.log('');
      continue;
    }
    console.log(`segments: ${plan.message.segments}   characters: ${plan.message.body.length}`);
    console.log('─'.repeat(72));
    console.log(plan.message.body);
    console.log('');
  }
  await closePool();
}

main().catch(async (e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e));
  await closePool().catch(() => {});
  process.exit(1);
});
