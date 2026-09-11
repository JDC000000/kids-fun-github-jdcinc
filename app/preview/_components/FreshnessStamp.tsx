// The freshness stamp (D9) — the product's signature component. A date-stamp-style
// chip that makes the honesty differentiator the most recognisable visual, on every
// card + detail. Text + colour + icon: never colour-only status.
//
// `hideStatusLabel` IS THE ONE EXCEPTION TO THAT "TEXT" RULE, AND IT IS NARROW ON PURPOSE.
// The invariant the rule protects is that a parent can never learn a listing's status from
// COLOUR ALONE — it is a property of the CARD FACE, not of this chip in isolation. A caller
// may therefore hide the status text here on exactly one condition: the identical status
// string is already rendered, as text, elsewhere on the same face. ActivityCard is the only
// caller that does so, and only when the booking pill directly above the stamp prints the
// same string (see the duplicate check there). In that state the card still carries all three
// channels — text (the pill), icon (this chip's ✓), colour (both) — so the status is never
// colour-only; it is simply stated once instead of twice. The icon and tone deliberately stay:
// dropping them would remove the icon channel from the card entirely, which is a bigger
// departure from this rule than the duplicate it would be tidying.
//
// Default is false. Never pass true to "clean up" a chip: with no duplicate on the face it
// silently deletes the only status text on the card, which is exactly the honesty breach
// UXR-06 / T-07 (see the statusMeta header in _data/format.ts) forbids.

import { formatChecked, statusMeta } from '../_data/format';
import type { Activity } from '../_data/types';

export function FreshnessStamp({
  activity,
  hideStatusLabel = false,
}: {
  activity: Activity;
  hideStatusLabel?: boolean;
}) {
  const meta = statusMeta(activity.status, activity.seasonLabel);
  const checked = formatChecked(activity.lastCheckedIso);
  return (
    <span className={`kf-stamp kf-stamp--${meta.tone}`}>
      <span className="kf-stamp__icon" aria-hidden="true">
        {meta.icon}
      </span>
      {!hideStatusLabel && (
        <>
          <span>{meta.label}</span>
          {/* This separator belongs to the label; drop it with the label so the chip never
              opens on an orphaned "· source". */}
          <span aria-hidden="true">·</span>
        </>
      )}
      {/* Same rule as the status label above, and the same reason its separator is bundled with
          it: with no source to name, the chip would otherwise read "Confirmed · · Checked
          today" — or, before this, name the mapper's 'fixture source' stand-in on every card in
          the results list. The last-checked stamp stands on its own. */}
      {activity.sourceName && (
        <>
          <span className="kf-stamp__src">{activity.sourceName}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span>{checked}</span>
    </span>
  );
}
