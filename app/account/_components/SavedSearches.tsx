'use client';

// SavedSearches — the "My saved searches" section of /account (Task 38, M4/G5).
//
// Lists the parent's saved searches, lets them Open one back on /search (Round 10
// / Task B) or delete it, and lets them build one here by hand from a name + a
// query + optional filter JSON. The primary way to save is now the "Save this
// search" button on /search itself; this form remains for advanced/manual entry.
// It talks to /api/saved-searches (GET/POST) and /api/saved-searches/:id (DELETE);
// every call is owner-scoped server-side via RLS, so this component only ever
// handles the current user's rows.
import { useState, type FormEvent } from 'react';
import { Button, Input } from '@/components/ui';
import { hrefForParams, parseSearchState } from '@/app/search/_lib/params';
import { searchLinkRel } from '@/app/_lib/search-link-rel';
import { activeFilterCount } from '@/app/search/_lib/filter-summary';
import { emptyStateSentence, savedSearchRawParams } from '@/lib/search/saved-search-status';

export interface SavedSearchView {
  id: string;
  name: string | null;
  params: Record<string, unknown>;
  created_at: string;
  last_run_at: string | null;
}

/** Server-computed "this saved search matches nothing right now" for one row. */
export interface SavedSearchEmptyView {
  /** Human label for the blocking constraint, e.g. "price limit". Null when none unlocks it. */
  blockingLabel: string | null;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string; signin?: boolean };

/**
 * A compact, human summary of a saved search's params for the list row.
 *
 * The filter count is read through the SAME parser that executes the search
 * (parseSearchState → activeFilterCount, what /search itself counts) rather than by
 * counting raw stored keys. A search saved before the beta removal of the price controls
 * can still carry `cost=` / `includeUnknownCost=`; those are now inert — parseSearchState
 * ignores unrecognised params, so no ceiling reaches the engine — and counting keys made
 * the row claim filters whose behaviour no longer applies. Counting parsed state instead
 * means the summary cannot outlive the behaviour again, for this param or the next one.
 */
function summarize(params: Record<string, unknown>): string {
  const q = typeof params.q === 'string' ? params.q.trim() : '';
  const filters = activeFilterCount(parseSearchState(savedSearchRawParams(params)));
  const parts: string[] = [];
  if (q) parts.push(`“${q}”`);
  if (filters > 0) parts.push(`${filters} filter${filters === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(' · ') : 'Custom search';
}

/** Best-effort local date; never throws on a bad timestamp. */
function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function SavedSearches({
  initial,
  emptyById = {},
}: {
  initial: SavedSearchView[];
  /**
   * Server-computed, keyed by saved-search id: present iff that search matches nothing
   * right now. Rows created in this session are absent and simply show no line — never a
   * guess.
   */
  emptyById?: Record<string, SavedSearchEmptyView>;
}) {
  const [items, setItems] = useState<SavedSearchView[]>(initial);
  const [name, setName] = useState('');
  const [queryText, setQueryText] = useState('');
  const [filtersText, setFiltersText] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus({ kind: 'saving' });

    // Build params from the query + optional filter JSON.
    const params: Record<string, unknown> = {};
    const q = queryText.trim();
    if (q !== '') params.q = q;

    const rawFilters = filtersText.trim();
    if (rawFilters !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawFilters);
      } catch {
        setStatus({ kind: 'error', message: 'Filters must be valid JSON (e.g. {"region":"van","sort":"soonest"}).' });
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setStatus({ kind: 'error', message: 'Filters must be a JSON object.' });
        return;
      }
      Object.assign(params, parsed as Record<string, unknown>);
    }

    if (Object.keys(params).length === 0) {
      setStatus({ kind: 'error', message: 'Add a search query or some filters to save.' });
      return;
    }

    const body = { name: name.trim() === '' ? null : name.trim(), params };

    try {
      const res = await fetch('/api/saved-searches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });

      if (res.status === 401) {
        setStatus({ kind: 'error', message: 'Your session has expired. Please sign in again.', signin: true });
        return;
      }

      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string; savedSearch?: SavedSearchView }
        | null;

      if (!res.ok || !data?.ok || !data.savedSearch) {
        setStatus({ kind: 'error', message: data?.error ?? `Could not save (${res.status}).` });
        return;
      }

      setItems((prev) => [data.savedSearch as SavedSearchView, ...prev]);
      setName('');
      setQueryText('');
      setFiltersText('');
      setStatus({ kind: 'idle' });
    } catch {
      setStatus({ kind: 'error', message: 'Network error — please try again.' });
    }
  }

  async function onDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/saved-searches/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (res.ok || res.status === 404) {
        // 404 → already gone; drop it from the list either way.
        setItems((prev) => prev.filter((s) => s.id !== id));
      } else if (res.status === 401) {
        setStatus({ kind: 'error', message: 'Your session has expired. Please sign in again.', signin: true });
      } else {
        setStatus({ kind: 'error', message: `Could not delete (${res.status}).` });
      }
    } catch {
      setStatus({ kind: 'error', message: 'Network error — please try again.' });
    } finally {
      setDeletingId(null);
    }
  }

  const saving = status.kind === 'saving';

  return (
    <section className="kf-saved" aria-labelledby="kf-saved-title">
      <h2 className="kf-saved__title" id="kf-saved-title">
        My saved searches
      </h2>

      {items.length === 0 ? (
        <p className="kf-saved__empty">You haven&apos;t saved any searches yet. Create one below.</p>
      ) : (
        <ul className="kf-saved__list">
          {items.map((s) => (
            <li className="kf-saved__item" key={s.id}>
              <div className="kf-saved__item-main">
                <span className="kf-saved__item-name">{s.name ?? summarize(s.params)}</span>
                <span className="kf-saved__item-meta">
                  {s.name ? summarize(s.params) : null}
                  {s.name ? ' · ' : ''}
                  {formatDate(s.created_at)}
                </span>
                {/* Shown here UNCONDITIONALLY. A parent whose saved searches all match
                    nothing receives no weekly email at all (lib/email/digest.ts keeps
                    shouldSend gated on genuine matches), so this page is the only place
                    that population can be told why. */}
                {emptyById[s.id] && (
                  <span className="kf-saved__item-empty">
                    {emptyStateSentence(emptyById[s.id].blockingLabel)}
                  </span>
                )}
              </div>
              <div className="kf-saved__item-actions">
                <a
                  className="kf-saved__open"
                  href={hrefForParams(s.params)}
                  rel={searchLinkRel(hrefForParams(s.params))}
                  aria-label={`Open saved search ${s.name ?? summarize(s.params)} in search`}
                >
                  Open
                </a>
                <button
                  type="button"
                  className="kf-saved__delete"
                  onClick={() => onDelete(s.id)}
                  disabled={deletingId === s.id}
                  aria-label={`Delete saved search ${s.name ?? summarize(s.params)}`}
                >
                  {deletingId === s.id ? 'Removing…' : 'Delete'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form className="kf-saved__form" onSubmit={onCreate} noValidate>
        <p className="kf-saved__form-title">Save a new search</p>

        <div className="kf-saved__field">
          <label className="kf-saved__label" htmlFor="ss-name">
            Name <span className="kf-saved__optional">(optional)</span>
          </label>
          <Input
            id="ss-name"
            type="text"
            placeholder="e.g. Toddler swim near home"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="kf-saved__field">
          <label className="kf-saved__label" htmlFor="ss-query">
            Search query
          </label>
          <Input
            id="ss-query"
            type="text"
            placeholder="e.g. open gym"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
          />
        </div>

        <div className="kf-saved__field">
          <label className="kf-saved__label" htmlFor="ss-filters">
            Filters <span className="kf-saved__optional">(optional JSON)</span>
          </label>
          <textarea
            id="ss-filters"
            className="kf-saved__input kf-saved__textarea"
            rows={2}
            placeholder='e.g. {"region":"van","sort":"soonest"}'
            value={filtersText}
            onChange={(e) => setFiltersText(e.target.value)}
          />
          <p className="kf-saved__hint">
            Advanced: paste JSON filter params. Leave blank to save just the query. You can also save a
            search straight from the <a href="/search">search page</a> — this form is for building one by hand.
          </p>
        </div>

        <div className="kf-saved__actions">
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save search'}
          </Button>
          {status.kind === 'error' && (
            <span className="kf-saved__msg kf-saved__msg--err" role="alert">
              {status.message}
              {status.signin && (
                <>
                  {' '}
                  <a href="/auth/signin?next=/account">Sign in</a>.
                </>
              )}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
