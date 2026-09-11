// tests/sms/start_form_hydration.test.tsx — /sms/start must server-render the same DOM ids twice.
//
// ═══ THE BUG THIS FILE EXISTS FOR ═══
// StartForm numbered its child-age rows from a MODULE-LEVEL `let nextChildId = 1`. That counter
// lives for the life of the server process, not the life of a request, so consecutive requests
// server-rendered `kf-start-age-1`, then `-2`, then `-3`… while the client bundle always starts
// counting at 1. Those numbers are the input's `id` and its label's `htmlFor`.
//
// The page is `dynamic = 'force-dynamic'`, so EVERY request server-renders — this was not a
// cold-start edge case, it was the steady state.
//
// ⚠ SCOPE, MEASURED: hydrating the mismatched markup logs `Warning: Prop `htmlFor` did not
// match` in development; React does NOT discard the root, and since label and input carry the
// same server value they still pair, so no user lost the use of the control. This guards the
// determinism itself — mutable module state escaping across requests — not a user-facing outage.
//
// Two renders is the whole test: the second must look like the first. A test that rendered once
// could never have caught this, which is why it shipped.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StartForm } from '@/app/sms/start/_components/StartForm';
import type { CoveredRegionId } from '@/lib/geo/postal-fsa';

const SPARSE = ['wvan'] as unknown as readonly CoveredRegionId[];
const render = () => renderToStaticMarkup(<StartForm sparseRegionIds={SPARSE} />);

/** Every id/for pair the child-age rows put into the DOM. */
function childFieldIds(html: string): string[] {
  return [...html.matchAll(/(?:id|for)="([^"]*age-[^"]*)"/g)].map((m) => m[1]);
}

describe('🔴 the server renders identical child-field ids on every request', () => {
  it('does not drift between two consecutive server renders', () => {
    const first = childFieldIds(render());
    const second = childFieldIds(render());
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('still pairs each label with its own input', () => {
    // The ids may be opaque (useId produces ":r0:"-style values) — what matters is that the
    // label's `for` and the input's `id` are the SAME opaque value, or the label stops working.
    const html = render();
    const forAttr = html.match(/class="kf-start__child-label" for="([^"]+)"/)?.[1];
    const idAttr = html.match(/id="([^"]+)"[^>]*name="childAge"/)?.[1];
    expect(forAttr).toBeTruthy();
    expect(forAttr).toBe(idAttr);
  });

  it('holds after a render that added a second child row', () => {
    // Guards the other half: the "add another child" counter must also not be module-global.
    const a = childFieldIds(render());
    const b = childFieldIds(render());
    const c = childFieldIds(render());
    expect(new Set([a.join(), b.join(), c.join()]).size).toBe(1);
  });
});
