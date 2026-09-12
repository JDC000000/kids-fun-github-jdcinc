// tests/sms/preferences_form.test.tsx — what the preferences page's form actually renders.
//
// `renderToStaticMarkup`, the same idiom as tests/sms/signup_form.tsx and the rest of this repo's
// component tests. It renders the INITIAL state, which is the state both changes below are about:
// "collapsed by default" and "which wording a visitor reads without interacting" are claims about
// first paint specifically.
//
// WHY THIS FILE EXISTS AT ALL. Two changes landed on 2026-09-12 (Jon) that are each one careless
// edit away from being undone, and one of them would be undone SILENTLY and expensively:
//   1. the children copy on THIS page diverged from the signup form's on purpose;
//   2. the two danger sections' explanations moved behind a collapsed <details> — and the text
//      must still be IN the DOM, not conditionally rendered.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreferencesForm } from '@/app/u/[preferencesToken]/_components/PreferencesForm';
import {
  FIELD_COPY,
  PREFS_CHILDREN_LABEL,
  PREFS_DELETE,
  PREFS_DELETE_BODY,
  PREFS_DELETE_DETAILS_SUMMARY,
  PREFS_UNSUBSCRIBE,
  PREFS_UNSUBSCRIBE_BODY,
  PREFS_UNSUBSCRIBE_DETAILS_SUMMARY,
} from '@/lib/sms/consent-copy';
import type { PreferencesView } from '@/lib/sms/preferences';

/** react-dom/server escapes text; compare against the same escaping. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const view: PreferencesView = {
  status: 'active',
  postalCode: 'V5N 1V8',
  childAges: [9, 7],
  categoryInterests: ['swimming'],
  consecutiveEmptyWeeks: 0,
  lastWeek: { kind: 'none', picks: [], sentAt: null },
  purged: false,
};

const html = renderToStaticMarkup(
  <PreferencesForm token="kftesttoken0123456789abcdef" view={view} editable />
);

describe('the children field copy is preferences-scoped, not the signup form’s', () => {
  it('renders Jon’s wording', () => {
    expect(html).toContain(esc(PREFS_CHILDREN_LABEL));
  });

  it('uses the CURLY apostrophe in "kids’ ages" — asserted literally, not via the constant', () => {
    // Jon shipped this sentence without an apostrophe ("your kids age"), was asked, and ruled on
    // 2026-09-12: use "kids’ ages", matching the rest of the page. Asserted as a LITERAL rather
    // than through PREFS_CHILDREN_LABEL, because a test that compares the constant to itself
    // passes for any value and would not have caught the original wording either.
    //
    // The character matters: U+2019 (’), not an ASCII '. The surrounding copy is all curly, and a
    // straight quote here would render as a visibly different glyph mid-sentence. It would also
    // escape differently — react-dom/server turns ' into &#x27; and leaves ’ alone — so this
    // assertion pins the escaping too.
    expect(PREFS_CHILDREN_LABEL).toBe('We use your kids\u2019 ages to find relevant activities');
    expect(PREFS_CHILDREN_LABEL).not.toContain("'");
    expect(html).toContain('We use your kids\u2019 ages to find relevant activities');
  });

  it('does NOT render the signup form’s question or help text', () => {
    // The old copy was FIELD_COPY.childrenLabel + FIELD_COPY.childrenHelp. Both are gone from
    // THIS page and both must stay exactly as they are on the signup form.
    expect(html).not.toContain(esc(FIELD_COPY.childrenLabel));
    expect(html).not.toContain(esc(FIELD_COPY.childrenHelp));
  });

  it('is the fieldset’s <legend>, so the age inputs keep an accessible group name', () => {
    // Replacing a label with a plain <p> would read as an unlabelled group to a screen reader.
    // Asserted on the legend specifically, not merely on the string being present somewhere.
    const legend = html.match(/<legend[^>]*>([^<]*)<\/legend>/g) ?? [];
    expect(legend.some((l) => l.includes(esc(PREFS_CHILDREN_LABEL)))).toBe(true);
  });

  it('⚠ the two copies must stay SEPARATE CONSTANTS — re-unifying them changes consent wording', () => {
    // This is the expensive-to-undo one. FIELD_COPY is rendered by /sms/signup and /sms/start,
    // which ARE the consent act: editing it to match this page would silently reword the signup
    // form, require a CONSENT_TEXT_VERSION bump under consent-copy.ts's own rule, and alter the
    // pixels used as Toll-Free Verification opt-in evidence. If someone "tidies up" the
    // duplication, this fails and says why.
    expect(PREFS_CHILDREN_LABEL).not.toBe(FIELD_COPY.childrenLabel);
    expect(PREFS_CHILDREN_LABEL).not.toBe(FIELD_COPY.childrenHelp);
    expect(FIELD_COPY.childrenLabel).toBe('How old are your kids?');
    expect(FIELD_COPY.childrenHelp).toContain('age in years');
  });
});

describe('the danger sections: button visible, explanation collapsed', () => {
  it('keeps both action buttons in the markup, unconditionally', () => {
    expect(html).toContain(esc(PREFS_UNSUBSCRIBE));
    expect(html).toContain(esc(PREFS_DELETE));
  });

  it('renders each explanation inside a CLOSED <details>', () => {
    for (const [summary, body] of [
      [PREFS_UNSUBSCRIBE_DETAILS_SUMMARY, PREFS_UNSUBSCRIBE_BODY],
      [PREFS_DELETE_DETAILS_SUMMARY, PREFS_DELETE_BODY],
    ] as const) {
      const block = html.match(
        new RegExp(`<details[^>]*class="kf-prefs__section-details"[^>]*>.*?</details>`, 'g')
      );
      expect(block, 'the collapsed wrapper must exist').toBeTruthy();
      const joined = (block ?? []).join('');
      expect(joined).toContain(esc(summary));
      expect(joined).toContain(esc(body));
    }
  });

  it('⚠ the explanations are COLLAPSED, never conditionally rendered', () => {
    // The difference matters beyond tidiness: these sentences describe what unsubscribing and
    // deleting actually do. Inside a closed <details> they stay in the DOM, so curl, view-source,
    // archival tooling and assistive tech all still reach them — only the default paint changes.
    // Swapping the <details> for a useState toggle would remove them from the served HTML and
    // turn a presentational tweak into an undisclosed term.
    expect(html).toContain(esc(PREFS_UNSUBSCRIBE_BODY));
    expect(html).toContain(esc(PREFS_DELETE_BODY));
    // `open` is never set, so the UA renders them closed on first paint.
    const details = html.match(/<details[^>]*class="kf-prefs__section-details"[^>]*>/g) ?? [];
    expect(details).toHaveLength(2);
    for (const d of details) expect(d).not.toContain('open');
  });

  it('reuses the page’s existing toggle idiom rather than inventing a second one', () => {
    // The page already had one <details> (the legal block). Matching its structure is what keeps
    // the page to a single disclosure pattern; a hand-rolled button+div would drift from it.
    expect(html).toContain('<details class="kf-prefs__section-details">');
    expect(html).toContain('<summary>');
  });
});
