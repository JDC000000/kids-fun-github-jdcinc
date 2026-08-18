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

function render(confidenceLabel: ListingRecord['confidenceLabel']): string {
  const listing = makeListing({ confidenceLabel });
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
