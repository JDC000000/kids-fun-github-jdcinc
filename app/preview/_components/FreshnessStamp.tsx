// The freshness stamp (D9) — the product's signature component. A date-stamp-style
// chip that makes the honesty differentiator the most recognisable visual, on every
// card + detail. Text + colour + icon: never colour-only status.

import { formatChecked, statusMeta } from '../_data/format';
import type { Activity } from '../_data/types';

export function FreshnessStamp({ activity }: { activity: Activity }) {
  const meta = statusMeta(activity.status, activity.seasonLabel);
  const checked = formatChecked(activity.lastCheckedIso);
  return (
    <span className={`kf-stamp kf-stamp--${meta.tone}`}>
      <span className="kf-stamp__icon" aria-hidden="true">
        {meta.icon}
      </span>
      <span>{meta.label}</span>
      <span aria-hidden="true">·</span>
      <span className="kf-stamp__src">{activity.sourceName}</span>
      <span aria-hidden="true">·</span>
      <span>{checked}</span>
    </span>
  );
}
