import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The canonical detail page (app/activity/[id] → ActivityDetail, "Source & freshness" panel)
// used to print the raw ConfidenceLabel enum value verbatim — "Confidence: candidate" — with
// zero plain-language copy. Fixed by confidenceSentence() in _data/format.ts. This file guards
// the two things that can go wrong with that fix:
//   • a raw enum value ('confirmed'/'official'/'editorial'/'candidate') leaking into the
//     rendered markup instead of prose;
//   • the sentence disagreeing with confidenceMeta's badge label about which tier a listing is in.
//
// Deliberately does NOT touch ActivityCard.tsx or its markup — that surface is out of scope
// (Jon's 2026-08-11 ruling removed the authority badge from the card face; see
// tests/ui/card-completeness.test.tsx, left untouched by this change).
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: unknown; [k: string]: unknown }) => (
    <a href={typeof href === 'string' ? href : String(href ?? '')} {...rest}>
      {children as never}
    </a>
  ),
}));

import { ActivityDetail } from '../../app/preview/_components/ActivityDetail';
import { confidenceMeta, confidenceSentence } from '../../app/preview/_data/format';
import { mapListingRecordToActivity } from '../../app/preview/_data/search-api';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import type { ListingRecord } from '../../lib/search/types';

// A source URL is load-bearing for every render in this file. The panel now drops the
// confidence sentence when a listing has NO source (see the last describe block), and
// makeListing defaults `sourceUrl` to null — so a render that forgot to pass one would be
// silently testing the source-absent case while claiming to test tiers.
const SOURCE = 'https://vancouver.ca/parks/kits-pool';

function render(
  confidenceLabel: ListingRecord['confidenceLabel'],
  overrides: Partial<ListingRecord> = {},
): string {
  const listing = makeListing({ confidenceLabel, sourceUrl: SOURCE, ...overrides });
  const activity = mapListingRecordToActivity(listing);
  return renderToStaticMarkup(
    <ActivityDetail activity={activity} occurrenceId={activity.id} backHref="/search" backLabel="Back" />
  );
}

// Every raw ListingRecord.confidenceLabel value the type declares, mapped through the same
// mapConfidence() the real search API uses — not hand-picked Activity.confidence values — so
// this exercises the actual production pipeline, not an assumption about its output.
const RAW_CONFIDENCE_LABELS: ListingRecord['confidenceLabel'][] = [
  'official_recent',
  'official',
  'editorial',
  'inferred',
  'stale',
];

describe('ActivityDetail — Source & freshness panel states confidence in plain language', () => {
  it('never renders a bare ConfidenceLabel/Activity.confidence enum token on the page', () => {
    // Raw enum values that must never appear as their own word in the rendered markup. 'official'
    // is deliberately excluded from this list: it is a real English word ("Official source",
    // "official source" appear honestly elsewhere on the page), so it cannot be used as a
    // leak-detector on its own — 'confirmed' and 'candidate' are the unambiguous tells.
    const UNAMBIGUOUS_RAW_TOKENS = ['candidate'];
    for (const raw of RAW_CONFIDENCE_LABELS) {
      const html = render(raw);
      for (const token of UNAMBIGUOUS_RAW_TOKENS) {
        expect(html, `${raw}: raw token "${token}" must not leak into markup`).not.toContain(token);
      }
      // The old literal line must be fully gone, for every tier.
      expect(html, `${raw}: old raw-value line is gone`).not.toMatch(/Confidence:\s*(confirmed|official|editorial|candidate)\b/);
    }
  });

  it('renders a real sentence, matching confidenceSentence(), for every reachable tier', () => {
    for (const raw of RAW_CONFIDENCE_LABELS) {
      const listing = makeListing({ confidenceLabel: raw });
      const activity = mapListingRecordToActivity(listing);
      const html = render(raw);
      expect(html, `${raw}: sentence present`).toContain(confidenceSentence(activity.confidence));
    }
  });

  it('the sentence never disagrees with the badge label about which tier a listing is in', () => {
    for (const raw of RAW_CONFIDENCE_LABELS) {
      const listing = makeListing({ confidenceLabel: raw });
      const activity = mapListingRecordToActivity(listing);
      const meta = confidenceMeta(activity.confidence);
      const sentence = confidenceSentence(activity.confidence);
      if (meta.label === 'Community-listed') {
        expect(sentence, `${raw}: candidate tier reads as unverified`).toContain('Not yet verified');
      }
      if (meta.label === 'Official source') {
        expect(sentence, `${raw}: official tier reads as verified`).toContain('Verified');
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// NO SOURCE ⇒ NO SENTENCE ABOUT "THE OFFICIAL SOURCE" (2026-09-11)
//
// Three of confidenceSentence()'s four outputs name "the official source" — "confirmed directly
// by the official source", "check the official source before you rely on it". `confidence` and
// `sourceUrl` are set independently (mapConfidence() reads confidence_label; the source name
// comes from readSourceUrl()), so a listing with NO source can carry any tier. Under c367a3e's
// honest "No official source listed." that read, in one paragraph:
//
//     "No official source listed. Confirmed · Checked today · Not yet verified — check the
//      official source before you rely on it."
//
// A parent cannot act on that, and it contradicts itself in the same breath. The sentence now
// leaves with the source claim — the same rule the source line itself already follows.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('ActivityDetail — with no source, the panel claims no source', () => {
  it('drops the confidence sentence entirely, for every tier', () => {
    for (const raw of RAW_CONFIDENCE_LABELS) {
      const activity = mapListingRecordToActivity(makeListing({ confidenceLabel: raw, sourceUrl: null }));
      const html = render(raw, { sourceUrl: null });
      expect(html, `${raw}: sentence is absent`).not.toContain(confidenceSentence(activity.confidence));
      // The contradiction itself, in the words a parent would have read.
      expect(html, `${raw}: nothing sends a parent to a source we do not have`)
        .not.toContain('the official source');
    }
  });

  it('keeps the facts that survive the absence, with no stray separator', () => {
    // Status and freshness do not depend on a source, so they stay; the separator that used to
    // introduce the sentence leaves with it rather than dangling at the end of the line.
    const html = render('inferred', { sourceUrl: null, lastCheckedAtUtc: '2026-07-13T16:00:00.000Z' });
    expect(html).toContain('No official source listed.');
    expect(html).toMatch(/No official source listed\.\s*Confirmed/);
    expect(html).toContain('Checked');
    expect(html).not.toMatch(/·\s*<\/p>/);
    expect(html).not.toContain('· ·');
  });

  it('does NOT over-apply — a listing WITH a source still gets its sentence, unchanged', () => {
    for (const raw of RAW_CONFIDENCE_LABELS) {
      const activity = mapListingRecordToActivity(makeListing({ confidenceLabel: raw, sourceUrl: SOURCE }));
      const html = render(raw);
      expect(html, `${raw}: sentence present`).toContain(confidenceSentence(activity.confidence));
      // …and still introduced by its separator, exactly as before.
      expect(html, `${raw}: separator kept`).toContain(` · ${confidenceSentence(activity.confidence)}`);
    }
  });
});
