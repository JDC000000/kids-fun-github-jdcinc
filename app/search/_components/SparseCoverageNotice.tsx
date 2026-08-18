// SparseCoverageNotice — /search's honest "we hold almost nothing for this area" state, and the
// "tell me when it is live" capture that goes with it.
//
// A server component: it renders from the coverage measurement the search response already
// carries (lib/search/coverage.ts) and only the email field inside it is a client island
// (RegionNotifyForm). So the notice itself is in the server HTML — a parent with JavaScript off
// still reads the truth about the area, and only the capture is unavailable to them.
//
// It is a component rather than more JSX in page.tsx for one reason beyond tidiness: this is the
// join between three layers that each looked correct on their own — the engine measures, the
// derivation words it, the form captures — and the defect it closes lived precisely in a page
// presenting a thin area as an ordinary result set. A component makes that whole chain
// renderable in a test (tests/search/sparse-region-coverage.test.ts) instead of only its ends.
import type { RegionCoverage } from '@/lib/search/coverage';
import { describeSparseCoverage } from '../_lib/coverage-notice';
import { RegionNotifyForm } from './RegionNotifyForm';

interface SparseCoverageNoticeProps {
  /**
   * Per-area catalogue coverage from the search response. Optional/nullable on purpose: a
   * response that predates this field, a failed search, and a search with no area chip selected
   * are all "nothing to say", and all three must render nothing rather than guess.
   */
  coverage: RegionCoverage[] | null | undefined;
}

export function SparseCoverageNotice({ coverage }: SparseCoverageNoticeProps) {
  // Null is the ordinary case — no area chip, or every selected area is one we genuinely cover.
  // A well-covered search renders exactly nothing here, which is where "this changes behaviour
  // only for genuinely sparse areas" is actually guaranteed.
  const notice = describeSparseCoverage(coverage);
  if (!notice) return null;

  return (
    <div className="kf-coverage">
      {/* `role="status"` sits on the PROSE, not on the wrapper, matching the sibling notices —
          and here it also matters that the form is outside it: a live region wrapping the whole
          block would re-announce the explanation every time the capture below changed state, on
          top of that control's own status/alert. */}
      <p className="kf-coverage__text" role="status">
        <b className="kf-coverage__lede">{notice.lede}</b> {notice.body}
      </p>
      <RegionNotifyForm regions={notice.regions} />
    </div>
  );
}
