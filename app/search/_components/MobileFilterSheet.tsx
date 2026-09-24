'use client';

import Link from './SearchLink';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui';

/**
 * Mobile sticky filter bar + filter bottom sheet (Visual Blueprint v0.2 §04 / Screen 5,
 * "Filters (mobile bottom sheet / desktop left rail)"). Approved, specified, and until
 * now unbuilt: at 390x844 a parent scrolled past ~1,470px — roughly 1.7 viewport-heights
 * and 42 focusable controls — of permanently-expanded filter chrome before the first
 * result, on the surface ~70% of real users are on.
 *
 * WHAT THIS IS, STRUCTURALLY
 * The filter rail is passed in as `children` and rendered EXACTLY ONCE. This component
 * only relocates it: it is a client island that wraps a server-rendered subtree, the same
 * pattern SearchResultsView uses for the result list. That matters more than it looks —
 *   • the rail stays a Server Component, so its chips stay real <Link> anchors and the
 *     whole URL-state architecture (shareable/back-button-safe filters, the homepage
 *     quick-start deep links, `aria-current` selection — see Chip.tsx's Round-18 warning)
 *     is untouched. Setting a filter from inside the sheet is the same navigation it has
 *     always been;
 *   • there is no second copy of the rail to keep in sync, and no duplicated group ids.
 *
 * THE SAME NODE IS TWO DIFFERENT CONTROLS
 * At >=768px `.kf-msheet` is `display: contents` and the rail renders inline, exactly as it
 * does today — the desktop/tablet layer that shipped in fix/desktop-responsive-shell is
 * deliberately not touched here. At <=767px the same node is a modal bottom sheet. So the
 * dialog semantics (role/aria-modal/aria-labelledby/tabindex) are applied ONLY while the
 * sheet is actually open, never in the static markup: a `role="dialog"` baked into SSR
 * would hand every desktop visitor — and every visitor with JS off — a dialog with no way
 * to close it.
 *
 * WITHOUT JAVASCRIPT
 * Every filter on /search is a link or a native form, on purpose, so the page works with JS
 * disabled. A JS-gated sheet would silently take that away on mobile. The <noscript> block
 * un-hides the panel inline and retires the (dead) trigger bar, so a JS-off parent gets the
 * pre-existing behaviour rather than an unreachable filter set.
 *
 * ACCESSIBILITY (all of this is required, none of it is optional — see the a11y e2e spec)
 * role=dialog + aria-modal while open · focus moved into the sheet on open and returned to
 * the exact trigger on close · a real focus trap (Tab/Shift+Tab wrap, and focus dragged back
 * if a re-render drops it) · Esc closes · background scroll locked while open · every control
 * >=44px · tap-only, so WCAG 2.5.7 (dragging alternatives) can't be violated — the grip is a
 * decorative affordance and drag is never implemented as the only way to do anything ·
 * prefers-reduced-motion honoured in CSS.
 */

const PANEL_ID = 'kf-msheet-panel';
const TITLE_ID = 'kf-msheet-title';

/** Widest viewport that gets the sheet. Must match the `max-width: 767px` block in search.css. */
const MOBILE_QUERY = '(max-width: 767px)';

/** Elements a parent can reach with Tab inside the open sheet. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Restores the filters inline when scripting is off: the trigger bar would be dead
 * controls, and the panel would be a sheet nothing can open. Injected as a <noscript>
 * stylesheet rather than handled in React, because by definition React never runs.
 */
const NOSCRIPT_CSS = `@media (max-width: 767px){
.kf-mfilters{display:none!important}
.kf-msheet[data-open='false']{display:block!important;position:static!important;max-height:none!important;box-shadow:none!important;border-radius:0!important;transform:none!important}
.kf-msheet__head,.kf-msheet__foot{display:none!important}
.kf-msheet__body{overflow:visible!important;max-height:none!important;padding:0!important}
}`;

export interface MobileFilterSheetProps {
  /** Value shown on the `[ When ▾ ]` control (filter-summary.whenChipLabel). */
  whenLabel: string;
  /** Value shown on the `[ Where ▾ ]` control (filter-summary.whereChipLabel). */
  whereLabel: string;
  /** Applied filter-constraint count for the `⚙ N` badge (filter-summary.activeFilterCount). */
  activeCount: number;
  /** URL that clears every filter, preserving the query + sort (hrefFor(state, CLEARED_FILTERS)). */
  clearHref: string;
  /** Total results the CURRENT url state returns — the sheet's live count. */
  resultCount: number;
  /** Secondary applied filters, for the summary line under the controls. */
  otherChips?: string[];
  /** The server-rendered FilterRail. Rendered once, in the panel. */
  children: ReactNode;
}

export function MobileFilterSheet({
  whenLabel,
  whereLabel,
  activeCount,
  clearHref,
  resultCount,
  otherChips = [],
  children,
}: MobileFilterSheetProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** The control that opened the sheet — focus goes back to exactly this one on close. */
  const openerRef = useRef<HTMLButtonElement | null>(null);
  /** Group the opening control asked for ("When" scrolls to When), scrolled to after open. */
  const scrollTargetRef = useRef<string | null>(null);

  const close = useCallback(() => setOpen(false), []);

  const openSheet = useCallback((event: React.MouseEvent<HTMLButtonElement>, groupId: string | null) => {
    openerRef.current = event.currentTarget;
    scrollTargetRef.current = groupId;
    setOpen(true);
  }, []);

  // ── Desktop is not a sheet. If a parent rotates/resizes past the breakpoint while the
  // sheet is open, the panel becomes the inline rail again — leaving `open` true would keep
  // dialog semantics and a scroll lock on a surface that is visibly not a dialog.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const sync = () => {
      if (!mq.matches) setOpen(false);
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // ── Background scroll lock. Without it the results scroll under the parent's thumb
  // while they are choosing filters and they lose their place — the same complaint the
  // /preview sticky-filter fix was raised for.
  //
  // `overflow: hidden` alone is NOT a scroll lock. Per the CSS overflow spec a hidden
  // box is still a scroll container: it only removes the scrollbar UI, and programmatic
  // scrolling still works — which is exactly how Next's default scroll-to-top on a soft
  // navigation would yank the page every time a chip inside the sheet is tapped. Mobile
  // Safari ignores it on <body> for touch scrolling outright. Pinning the body at a
  // negative offset takes the document out of the scroll flow entirely, and restoring the
  // offset on close puts the parent back exactly where they were.
  useEffect(() => {
    if (!open) return;
    const body = document.body;
    const scrollY = window.scrollY;
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      // Instant, never smooth: this is a restore, not a journey.
      window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' as ScrollBehavior });
    };
  }, [open]);

  // ── Everything outside the sheet goes `inert` while it is open.
  //
  // `aria-modal="true"` is a HINT to assistive tech, not an enforcement: support is
  // uneven, and it does nothing at all for a screen reader's virtual cursor or for a
  // browser's own find-in-page. `inert` is the enforcement — the background stops being
  // focusable, clickable and exposed to the accessibility tree, so the trap holds even
  // where aria-modal is ignored. Walking up from the panel and inerting each level's
  // siblings covers the whole page without needing the sheet to be a direct child of
  // <body>. The scrim is skipped: it is the dismiss target, not background.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const touched: HTMLElement[] = [];
    let node: HTMLElement | null = panel;
    while (node && node !== document.body) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      for (const child of Array.from(parent.children)) {
        if (child === node || !(child instanceof HTMLElement)) continue;
        if (child.classList.contains('kf-msheet__scrim') || child.inert) continue;
        child.inert = true;
        touched.push(child);
      }
      node = parent;
    }
    return () => {
      for (const el of touched) el.inert = false;
    };
  }, [open]);

  // ── Open: move focus into the sheet and scroll to the group the trigger named.
  // Focus lands on the panel itself (tabindex=-1) rather than the first chip, so the
  // dialog's accessible name is announced before its contents, and a parent who opened
  // "When" is not silently dropped into the middle of the group list.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    panel.focus({ preventScroll: true });
    const groupId = scrollTargetRef.current;
    if (groupId) {
      const label = panel.querySelector(`#${CSS.escape(groupId)}`);
      const group = label?.closest('.kf-fgroup') ?? label;
      group?.scrollIntoView({ block: 'start', behavior: 'auto' });
    } else if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
  }, [open]);

  // ── Close: hand focus back to the control that opened the sheet (WCAG 2.4.3 focus order —
  // dumping focus on <body> would restart the parent at the top of the page).
  //
  // preventScroll is load-bearing, not defensive. focus() scrolls its target into view, and
  // `html { scroll-padding-top }` (which reserves the pinned bar's height so focus is never
  // obscured) makes the browser treat the bar's own buttons as needing that clearance too —
  // so a plain focus() nudged the whole page ~11px every single time the sheet was closed,
  // undoing the scroll restore that runs one effect earlier. The trigger lives in a bar
  // pinned at top: 0, so it is on screen by construction and never needs scrolling to.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) openerRef.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);

  // ── Esc to close + a real focus trap. The trap re-reads the focusable set on every Tab
  // because the sheet's contents are re-rendered by the server on each filter navigation.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === panel,
      );
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Selecting a filter re-renders the sheet from the server; if that drops the focused
    // anchor, focus falls to <body> and Tab would walk the page BEHIND the modal. Pull it
    // back to the panel so the trap survives a re-render.
    const onFocusIn = (event: FocusEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = event.target as Node | null;
      if (target && !panel.contains(target)) panel.focus({ preventScroll: true });
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open, close]);

  const countLabel = activeCount === 1 ? '1 filter applied' : `${activeCount} filters applied`;

  return (
    <>
      <noscript>
        <style dangerouslySetInnerHTML={{ __html: NOSCRIPT_CSS }} />
      </noscript>

      {/* ── Sticky bar: the two controls a parent changes most (when / where) plus the
          full-set trigger. Always reachable without scrolling back up — that is the whole
          point of the pattern. Hidden entirely at >=768px, where the rail is inline. */}
      <div className="kf-mfilters">
        <div className="kf-mfilters__row" role="group" aria-label="Filters">
          <button
            type="button"
            className="kf-mfilters__btn"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={PANEL_ID}
            onClick={(e) => openSheet(e, 'kf-fg-when')}
          >
            <span className="kf-mfilters__btn-text">
              <span className="kf-mfilters__btn-label">When</span>
              <span className="kf-mfilters__btn-value">{whenLabel}</span>
            </span>
            <span className="kf-mfilters__caret" aria-hidden="true">
              ▾
            </span>
          </button>

          <button
            type="button"
            className="kf-mfilters__btn"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={PANEL_ID}
            onClick={(e) => openSheet(e, 'kf-fg-areas')}
          >
            <span className="kf-mfilters__btn-text">
              <span className="kf-mfilters__btn-label">Where</span>
              <span className="kf-mfilters__btn-value">{whereLabel}</span>
            </span>
            <span className="kf-mfilters__caret" aria-hidden="true">
              ▾
            </span>
          </button>

          <button
            type="button"
            className="kf-mfilters__btn kf-mfilters__btn--all"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={PANEL_ID}
            onClick={(e) => openSheet(e, null)}
          >
            <span className="kf-mfilters__glyph" aria-hidden="true">
              ⚙
            </span>
            <span className="kf-mfilters__btn-value">Filters</span>
            {activeCount > 0 && (
              <>
                {/* Count is a number AND a phrase: a bare badge is shape-only information. */}
                <span className="kf-mfilters__count" aria-hidden="true">
                  {activeCount}
                </span>
                <span className="kf-visually-hidden">{countLabel}</span>
              </>
            )}
          </button>
        </div>

        {/* What is applied, in words — the parent cannot see the chips any more. */}
        {(activeCount > 0 || otherChips.length > 0) && (
          <p className="kf-mfilters__summary">
            {otherChips.length > 0 && <span className="kf-mfilters__summary-text">{otherChips.join(' · ')}</span>}
            <Link className="kf-mfilters__clear" href={clearHref}>
              Clear all
            </Link>
          </p>
        )}
      </div>

      {/* Scrim: mouse/touch convenience only. Esc and the Close button are the real,
          keyboard-operable exits, so this carries no role and no tab stop. */}
      {open && <div className="kf-msheet__scrim" aria-hidden="true" onClick={close} />}

      {/* ── The panel. Inline rail at >=768px; modal bottom sheet at <=767px while open. */}
      <div
        id={PANEL_ID}
        ref={panelRef}
        className="kf-msheet"
        data-open={open ? 'true' : 'false'}
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        aria-labelledby={open ? TITLE_ID : undefined}
        tabIndex={open ? -1 : undefined}
      >
        <div className="kf-msheet__head">
          {/* Decorative only. Nothing in this sheet is drag-operated, so there is no
              drag-only interaction for WCAG 2.5.7 to catch. */}
          <span className="kf-msheet__grip" aria-hidden="true" />
          <div className="kf-msheet__head-row">
            <h2 className="kf-msheet__title" id={TITLE_ID}>
              Filters
            </h2>
            {activeCount > 0 && (
              <Link className="kf-msheet__clear" href={clearHref}>
                Clear all
              </Link>
            )}
            <button type="button" className="kf-msheet__close" aria-label="Close filters" onClick={close}>
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        </div>

        <div className="kf-msheet__body" ref={bodyRef}>
          {children}
        </div>

        <div className="kf-msheet__foot">
          <p className="kf-msheet__live" role="status" aria-live="polite">
            <b>{resultCount}</b> {resultCount === 1 ? 'result' : 'results'} match these filters
          </p>
          <Button variant="primary" fullWidth onClick={close}>
            Show results
          </Button>
        </div>
      </div>
    </>
  );
}
