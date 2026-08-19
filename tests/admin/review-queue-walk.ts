// tests/admin/review-queue-walk.ts — test-only helper: read the ENTIRE QA review queue by
// paging through it. Not a `.test.ts` file on purpose (vitest collects only `*.test.{ts,tsx}`).
//
// listReviewQueue returns ONE PAGE. A test that seeds a row and then asserts it "is in the
// queue" therefore has to page to find it: whether a given row lands on page 1 depends
// entirely on how many OTHER rows are already queued — none on a freshly-bootstrapped CI
// database, 2590 in production (measured 2026-08-19). Suites that searched a single un-paged
// read were silently encoding "the catalogue is empty", which is why the 100-row cap this
// helper exists alongside could sit in production unnoticed while its own tests stayed green.
import { listReviewQueue, type ReviewItem } from '@/app/admin/qa-queue/_lib/data';

/** Deliberately NOT the UI page size — a walk that only works at one page size proves less. */
const WALK_PAGE_SIZE = 200;

/** Every row in the review queue, in queue order, across as many pages as it takes. */
export async function collectReviewQueue(): Promise<ReviewItem[]> {
  const all: ReviewItem[] = [];
  for (let offset = 0; ; offset += WALK_PAGE_SIZE) {
    const page = await listReviewQueue({ limit: WALK_PAGE_SIZE, offset });
    all.push(...page.items);
    // An empty page is the authoritative terminator; the total is the fast path.
    if (page.items.length === 0 || all.length >= page.total) return all;
  }
}
