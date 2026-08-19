import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// ChildProfilePrompt now navigates on submit, so it calls `useRouter` during render and needs an
// app-router context that a bare `renderToStaticMarkup` does not provide. Same stub the other UI
// suites use (tests/ui/registration-and-slots.test.tsx).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));

import { ChildAgeForm } from './ChildAgeForm';
import { ChildProfileBar } from './ChildProfileBar';
import { ChildProfilePrompt, searchHrefForChildren } from './ChildProfilePrompt';
import { MAX_CHILDREN } from '@/lib/profile/child-profile';
import { MAX_AGE_YEARS } from '@/lib/profile/child-age-display';

// SERVER-RENDER CONTRACT for the two child-profile islands, plus the shape of the capture form.
//
// What is assertable here is the markup a browser receives BEFORE any JavaScript runs — which is
// exactly where this feature's two non-cosmetic failure modes live:
//
//   1. A CHILD'S AGE IN SERVER-RENDERED HTML. The whole posture approved on 2026-08-19 is that
//      this data is on-device and never reaches a server (lib/profile/child-profile.ts's header;
//      app/privacy/page.tsx's published sentence depends on it staying true). Both islands must
//      therefore render EMPTY until storage has been read in an effect. An island that read
//      storage during render would also tear the tree apart at hydration — same bug, two symptoms.
//   2. A FIELD THAT IS NOT AN AGE. Ages only is a ruling (§9-Q2), and it is enforced in the store
//      by an allowlist and a forbidden-key guard. This pins the other end of it: the form a parent
//      types into offers nowhere to put a name.
//
// Interaction (add/remove a row, submit, dismiss, the effect that reads storage at all) is NOT
// assertable in the node environment — there is no DOM and no jsdom in this suite. The logic those
// interactions carry lives in pure modules that ARE tested directly: the precedence rules in
// tests/child_profile_default.test.ts, the store in tests/child_profile.test.ts.

describe('the profile islands render NOTHING before storage is read', () => {
  it('ChildProfilePrompt ships no markup on the server (no flash at a parent who already answered)', () => {
    expect(renderToStaticMarkup(<ChildProfilePrompt />)).toBe('');
  });

  it('ChildProfileBar ships no markup on the server — no age can be in the HTML, ever', () => {
    const html = renderToStaticMarkup(<ChildProfileBar />);
    expect(html).toBe('');
    expect(html).not.toMatch(/year-old/);
  });
});

describe('"Show what fits" actually shows what fits', () => {
  // The defect: the prompt's submit wrote the profile and closed the panel, full stop. A parent
  // who answered "who are you looking for?" on the front door stayed on the front door, looking
  // at the same static tiles — with the button that promised otherwise now gone.
  //
  // This asserts the DESTINATION, which is the whole of the decision (the component's remaining
  // job is one `router.push(href)`). Firing the submit itself is not assertable here: the suite
  // runs in the node environment with no DOM and no jsdom — see this file's header.

  it('sends one child to /search filtered to that child’s band', () => {
    expect(searchHrefForChildren([{ ageMonths: 36 }])).toBe('/search?age=2-4');
  });

  it('sends siblings to the OR-set of their bands, youngest first', () => {
    expect(searchHrefForChildren([{ ageMonths: 84 }, { ageMonths: 36 }])).toBe('/search?age=2-4%2C5-9');
  });

  it('collapses two children in the same band to one band', () => {
    expect(searchHrefForChildren([{ ageMonths: 36 }, { ageMonths: 48 }])).toBe('/search?age=2-4');
  });

  it('spells every band the store can hold, including 15+ and under2', () => {
    expect(searchHrefForChildren([{ ageMonths: 6 }])).toBe('/search?age=under2');
    expect(searchHrefForChildren([{ ageMonths: 132 }])).toBe('/search?age=10-14');
    expect(searchHrefForChildren([{ ageMonths: 192 }])).toBe('/search?age=15%2B');
  });

  it('stays put rather than navigating to a bare /search when no band resolves', () => {
    // Defensive only — ChildAgeForm validates first. But a bare /search would be a navigation the
    // parent's answer did not earn, so "no bands" means "no navigation", as on the /search side
    // (app/search/_lib/profile-default.ts's null-vs-empty distinction).
    expect(searchHrefForChildren([])).toBeNull();
    expect(searchHrefForChildren([{ ageMonths: -1 }])).toBeNull();
    expect(searchHrefForChildren([{ ageMonths: 1.5 }])).toBeNull();
  });

  it('leaves the "Not now" path with nowhere to go — dismissing is not a search', () => {
    // The dismiss control is the caller's own button, rendered beside Save; it never reaches the
    // submit path, so there is no href for it. Pinned as markup: the panel offers exactly one
    // control that leads to /search, and it is the submit.
    const html = renderToStaticMarkup(
      <ChildAgeForm idPrefix="t" submitLabel="Show what fits" onSubmit={() => {}}>
        <button type="button">Not now</button>
      </ChildAgeForm>
    );
    expect(html).toContain('Not now');
    expect(html).not.toContain('/search');
  });
});

describe('ChildAgeForm — the capture surface', () => {
  const render = (props: Partial<Parameters<typeof ChildAgeForm>[0]> = {}) =>
    renderToStaticMarkup(
      <ChildAgeForm idPrefix="t" submitLabel="Save" onSubmit={() => {}} {...props} />
    );

  it('offers exactly one field per child, and it is an age', () => {
    const html = render();
    expect((html.match(/<input/g) || []).length).toBe(1);
    expect(html).toContain('type="number"');
    // No name, nickname, birth date or free text anywhere near it.
    expect(html).not.toMatch(/type="text"/);
    expect(html).not.toMatch(/name|birth|dob/i);
  });

  it('binds every input to a real label (the only handle a child has is "child N")', () => {
    const html = render({
      initial: [
        { id: 'c1', ageMonths: 36 },
        { id: 'c2', ageMonths: 84 },
      ],
    });
    const ids = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(html).toContain(`for="${id}"`);
  });

  it('pre-fills an edit in YEARS, from the months the store holds', () => {
    const html = render({ initial: [{ id: 'c1', ageMonths: 36 }] });
    expect(html).toContain('value="3"');
  });

  it('states the store’s own caps rather than a second copy of them', () => {
    expect(render()).toContain(`max="${MAX_AGE_YEARS}"`);
    // The "add another" affordance exists while under the cap, and is the only way to exceed it.
    const full = render({
      initial: Array.from({ length: MAX_CHILDREN }, (_, i) => ({ id: `c${i}`, ageMonths: 36 })),
    });
    expect(full).not.toContain('Add another child');
    expect(render()).toContain('Add another child');
  });

  it('shows a per-child Remove only once there is more than one child to tell apart', () => {
    expect(render()).not.toContain('Remove');
    expect(
      render({ initial: [{ id: 'c1', ageMonths: 36 }, { id: 'c2', ageMonths: 84 }] })
    ).toContain('aria-label="Remove child 2"');
  });
});
