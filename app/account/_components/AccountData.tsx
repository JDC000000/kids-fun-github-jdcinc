'use client';

// AccountData — the "Your data" section of /account (Task C, M4/G5).
//
// Two self-service controls a signed-in parent now has:
//   • Download your data — fetches GET /api/account/export and saves the returned
//     JSON as a file. Uses fetch (not a bare link) so a 401/expired session shows
//     a friendly message instead of downloading an error body.
//   • Delete your account — a deliberately two-step, irreversible action: reveal a
//     warning panel, then require the user to type DELETE before the final button
//     enables. On success it POSTs to /api/account/delete and sends the (now
//     signed-out) user home.
//
// Every request is owner-scoped server-side via RLS, so this component only ever
// touches the current user's data.
import { useState } from 'react';
import { Button, Input } from '@/components/ui';

// Must match app/api/account/delete/route.ts DELETE_CONFIRM_PHRASE.
const CONFIRM_PHRASE = 'DELETE';

type ExportStatus =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done' }
  | { kind: 'error'; message: string; signin?: boolean };

type DeleteStatus =
  | { kind: 'idle' }
  | { kind: 'deleting' }
  | { kind: 'deleted' }
  | { kind: 'error'; message: string; signin?: boolean };

export function AccountData() {
  // ── Export ──────────────────────────────────────────────────────────────────
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ kind: 'idle' });

  async function onExport() {
    setExportStatus({ kind: 'working' });
    try {
      const res = await fetch('/api/account/export', { credentials: 'same-origin' });
      if (res.status === 401) {
        setExportStatus({ kind: 'error', message: 'Your session has expired. Please sign in again.', signin: true });
        return;
      }
      if (!res.ok) {
        setExportStatus({ kind: 'error', message: `Could not build your export (${res.status}).` });
        return;
      }
      const blob = await res.blob();
      // Derive the filename the server suggested, or fall back to a stable name.
      const disp = res.headers.get('content-disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disp);
      const filename = match?.[1] ?? 'kids-fun-account-export.json';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportStatus({ kind: 'done' });
    } catch {
      setExportStatus({ kind: 'error', message: 'Network error — please try again.' });
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  const [showDelete, setShowDelete] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [deleteStatus, setDeleteStatus] = useState<DeleteStatus>({ kind: 'idle' });

  const canDelete = confirmInput === CONFIRM_PHRASE && deleteStatus.kind !== 'deleting';

  async function onDelete() {
    if (confirmInput !== CONFIRM_PHRASE) return;
    setDeleteStatus({ kind: 'deleting' });
    try {
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ confirmText: CONFIRM_PHRASE }),
      });

      if (res.status === 401) {
        setDeleteStatus({ kind: 'error', message: 'Your session has expired. Please sign in again.', signin: true });
        return;
      }

      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;

      if (!res.ok || !data?.ok) {
        setDeleteStatus({ kind: 'error', message: data?.error ?? `Could not delete your account (${res.status}).` });
        return;
      }

      setDeleteStatus({ kind: 'deleted' });
      // The account is gone and the session revoked — send them home shortly.
      window.setTimeout(() => {
        window.location.href = '/';
      }, 2500);
    } catch {
      setDeleteStatus({ kind: 'error', message: 'Network error — please try again.' });
    }
  }

  return (
    <section className="kf-account-data" aria-labelledby="kf-account-data-title">
      <h2 className="kf-account-data__title" id="kf-account-data-title">
        Your data
      </h2>

      {/* Download */}
      <div className="kf-account-data__block">
        <h3 className="kf-account-data__subtitle">Download your data</h3>
        <p className="kf-account-data__text">
          Get a copy of everything KIDS FUN stores under your account — your profile and your saved searches —
          as a JSON file.
        </p>
        <div className="kf-account-data__actions">
          <Button variant="primary" onClick={onExport} disabled={exportStatus.kind === 'working'}>
            {exportStatus.kind === 'working' ? 'Preparing…' : 'Download my data'}
          </Button>
          {exportStatus.kind === 'done' && (
            <span className="kf-account-data__msg kf-account-data__msg--ok" role="status">
              Your download has started.
            </span>
          )}
          {exportStatus.kind === 'error' && (
            <span className="kf-account-data__msg kf-account-data__msg--err" role="alert">
              {exportStatus.message}
              {exportStatus.signin && (
                <>
                  {' '}
                  <a href="/auth/signin?next=/account">Sign in</a>.
                </>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Delete */}
      <div className="kf-account-data__block kf-account-data__block--danger">
        <h3 className="kf-account-data__subtitle">Delete your account</h3>
        <p className="kf-account-data__text">
          Permanently delete your account and all the data tied to it — your profile and every saved search.
          This can’t be undone.
        </p>

        {deleteStatus.kind === 'deleted' ? (
          <p className="kf-account-data__msg kf-account-data__msg--ok" role="status">
            Your account and data have been deleted. Signing you out…
          </p>
        ) : !showDelete ? (
          <div className="kf-account-data__actions">
            <Button variant="danger" onClick={() => setShowDelete(true)}>
              Delete my account…
            </Button>
          </div>
        ) : (
          <div className="kf-account-data__confirm">
            <p className="kf-account-data__text">
              To confirm, type <strong>{CONFIRM_PHRASE}</strong> in the box below, then choose “Permanently
              delete”.
            </p>
            <label className="kf-account-data__confirm-label" htmlFor="kf-delete-confirm">
              Type {CONFIRM_PHRASE} to confirm
            </label>
            <Input
              id="kf-delete-confirm"
              type="text"
              autoComplete="off"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              aria-describedby="kf-delete-help"
            />
            <div className="kf-account-data__actions">
              <Button variant="danger" onClick={onDelete} disabled={!canDelete}>
                {deleteStatus.kind === 'deleting' ? 'Deleting…' : 'Permanently delete my account'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowDelete(false);
                  setConfirmInput('');
                  setDeleteStatus({ kind: 'idle' });
                }}
                disabled={deleteStatus.kind === 'deleting'}
              >
                Cancel
              </Button>
            </div>
            <p id="kf-delete-help" className="kf-account-data__hint">
              The button stays disabled until you type {CONFIRM_PHRASE} exactly.
            </p>
            {deleteStatus.kind === 'error' && (
              <span className="kf-account-data__msg kf-account-data__msg--err" role="alert">
                {deleteStatus.message}
                {deleteStatus.signin && (
                  <>
                    {' '}
                    <a href="/auth/signin?next=/account">Sign in</a>.
                  </>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
