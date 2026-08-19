'use client';

// ChildProfileBar — "For a 3-year-old and a 7-year-old", plus the three controls that make that
// statement retractable: edit an age, remove a child, forget the lot (design §4e; U2).
//
// WHY IT IS IN THE GLOBAL HEADER AND NOT ON /account. /account gates on `getRequestUser`
// (app/account/page.tsx) — it is a signed-in page, and this profile belongs to an anonymous
// visitor with no login. A control a parent cannot reach is not a control. The design doc reaches
// the same conclusion by the same route (§4e) and offers "the header or the rail"; the header
// wins because the profile is not a property of /search — it is a standing statement that also
// narrows /search, and it should be visible on the page a parent is on when they wonder about it.
//
// WHY IT IS STATED AT ALL, RATHER THAN JUST OBEYED. A default that filters results while
// describing itself nowhere is the removed `cost=` param (params.ts:220-247): a filter that
// suppresses listings invisibly, with no control left to see or clear it. The applied-filter
// token on /search covers "this search is narrowed"; this bar covers the prior question, "why,
// and by what". Both, or neither — see the design's §5b(2).
//
// SHAPE OF THE CONTROLS, borrowed from ResumeSearch.tsx:76-88: the keep-and-change action and the
// erase action sit next to each other at equal visual weight, in the open. Nothing here is behind
// a settings page, a menu or a second click that a parent has to guess exists.
//
// RENDERS NOTHING WITHOUT A PROFILE. This is the whole of its "no profile" behaviour: no
// placeholder, no "add your kids" call to action, no empty chrome on every page in the product.
// Asking is the prompt's job, on the home page, once (Q7) — a header that asked on every route
// would be that ruling undone by accident.

import { useState } from 'react';
import { clearProfile, writeProfile, type ChildInput } from '@/lib/profile/child-profile';
import { describeChildAges } from '@/lib/profile/child-age-display';
import { ChildAgeForm } from './ChildAgeForm';
import { notifyChildProfileChanged, useChildProfile } from './useChildProfile';
import './child-profile.css';

export function ChildProfileBar() {
  const { profile, ready } = useChildProfile();
  const [editing, setEditing] = useState(false);

  if (!ready || !profile) return null;

  const description = describeChildAges(profile.children);
  if (!description) return null; // nothing sayable → say nothing (a tampered blob, in practice)

  const save = (children: ChildInput[]) => {
    writeProfile(children, Date.now());
    setEditing(false);
    // 'saved' is the signal /search's island treats as an EXPLICIT restatement of who the parent
    // is looking for, so an edit made on the results page takes effect there immediately instead
    // of sitting in storage until the next bare landing.
    notifyChildProfileChanged('saved');
  };

  const forget = () => {
    clearProfile();
    setEditing(false);
    notifyChildProfileChanged('cleared');
  };

  return (
    <section className="kf-cprof kf-cprof--bar" aria-label="Who you are looking for">
      <div className="kf-cprof__bar-line">
        <p className="kf-cprof__for">
          Showing activities for <b className="kf-cprof__ages">{description}</b>
        </p>
        <div className="kf-cprof__bar-actions">
          <button
            type="button"
            className="kf-cprof__btn"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
            aria-controls="kf-cprof-editor"
          >
            {editing ? 'Close' : 'Change ages'}
          </button>
          {/* Equal weight to "Change ages", never a buried setting — the erase action is the one
              a parent on a shared device most needs to find without hunting. */}
          <button type="button" className="kf-cprof__btn kf-cprof__btn--muted" onClick={forget}>
            Forget my children
          </button>
        </div>
      </div>

      {editing && (
        <div className="kf-cprof__editor" id="kf-cprof-editor">
          <ChildAgeForm
            initial={profile.children}
            idPrefix="kf-cprof-bar"
            submitLabel="Save ages"
            onSubmit={save}
          >
            <button type="button" className="kf-cprof__btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </ChildAgeForm>
          {/* Removing the LAST child is spelled as "Forget my children", not as saving an empty
              list: `writeProfile` deliberately treats "nothing valid to store" as a no-op that
              preserves the existing profile, so one eraser exists and no accidental empty save
              can wipe a parent's profile. The form enforces the same rule by keeping one row. */}
          <p className="kf-cprof__hint">
            Ages only — no names, and nothing here leaves your device. To remove your last child, use “Forget my
            children”.
          </p>
        </div>
      )}
    </section>
  );
}
