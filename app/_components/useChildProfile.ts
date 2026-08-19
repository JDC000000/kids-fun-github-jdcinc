'use client';

// useChildProfile — the client-side seam between the on-device child profile (lib/profile/
// child-profile.ts) and the three React islands that read it: the ask-once prompt on the home
// page, the header bar that displays and edits it, and /search's default-application island.
//
// It exists for two reasons, both of which are bugs if it does not:
//
//   1. THE PROFILE MUST NEVER BE READ DURING RENDER. `localStorage` does not exist on the server,
//      so a component that reads it while rendering produces different HTML on the two sides and
//      React tears the tree apart at hydration. Every consumer therefore needs the same
//      read-in-an-effect dance, and `ready` — the flag that distinguishes "we have not looked
//      yet" from "we looked and there is nothing". The prompt turns on the SECOND of those; a
//      consumer that conflated them would flash an "add your kids" panel at every parent who
//      already has, on every page load.
//
//   2. THREE ISLANDS, ONE STORE, NO SHARED TREE. The prompt is on the home page, the bar is in
//      the root layout and the /search island is deep inside the results column — there is no
//      common ancestor to hold state in, and `localStorage` fires its native `storage` event
//      only in OTHER tabs. Without a notification of our own, saving a profile in the prompt
//      would leave the header bar showing nothing until the next navigation. A window
//      CustomEvent is the whole mechanism: same tab, synchronous, no provider, no dependency.
//
// The store itself stays free of all of this on purpose — it takes an injectable `StorageLike`
// and knows nothing about React or the DOM, which is what lets it be unit-tested without one.

import { useEffect, useState } from 'react';
import { readProfile, type ChildProfile } from '@/lib/profile/child-profile';

/**
 * Why the profile changed. The /search island treats these differently and must be able to tell
 * them apart:
 *   • `saved` — the parent just stated who they are looking for. That is an EXPLICIT action in
 *     this session, so it may materialise into the URL even over an existing selection.
 *   • `cleared` — the parent forgot their children. The age filter already in the URL is left
 *     exactly where it is: it is visible, it has a "✕", and silently widening the results as a
 *     side effect of a privacy action would be a second surprise on top of the one they asked for.
 */
export type ChildProfileChange = 'saved' | 'cleared';

/** Same-tab change notification. Namespaced like every other `kf_`/`kf:` key in the product. */
const CHILD_PROFILE_EVENT = 'kf:child-profile-changed';

/** Announce that this tab just wrote or erased the profile. Safe on the server (no-op). */
export function notifyChildProfileChanged(reason: ChildProfileChange): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent<ChildProfileChange>(CHILD_PROFILE_EVENT, { detail: reason }));
  } catch {
    /* CustomEvent unavailable — the UI simply updates on the next navigation instead. */
  }
}

/** Subscribe to same-tab profile changes. Returns an unsubscribe. Safe on the server (no-op). */
export function subscribeChildProfileChanged(handler: (reason: ChildProfileChange) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => handler((event as CustomEvent<ChildProfileChange>).detail ?? 'saved');
  window.addEventListener(CHILD_PROFILE_EVENT, listener);
  return () => window.removeEventListener(CHILD_PROFILE_EVENT, listener);
}

export interface ChildProfileState {
  /** The stored profile, or `null` for "none" — which is only meaningful once `ready`. */
  profile: ChildProfile | null;
  /** Has storage actually been read yet? False during SSR and the first client render. */
  ready: boolean;
}

/** Read the on-device profile after mount and keep it in step with same-tab changes. */
export function useChildProfile(): ChildProfileState {
  const [state, setState] = useState<ChildProfileState>({ profile: null, ready: false });

  useEffect(() => {
    setState({ profile: readProfile(), ready: true });
    return subscribeChildProfileChanged(() => setState({ profile: readProfile(), ready: true }));
  }, []);

  return state;
}
