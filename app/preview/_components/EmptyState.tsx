// Empty / broadening state (Screen 5b): a thin result is a helpful fork, not a dead
// end. Explains the constraint and offers concrete broaden actions. Presentational —
// the shell owns the state and passes the handlers.

interface EmptyStateProps {
  radiusKm: number;
  canWiden: boolean;
  hasActiveFilters: boolean;
  onWidenRadius: () => void;
  onClearFilters: () => void;
}

export function EmptyState({ radiusKm, canWiden, hasActiveFilters, onWidenRadius, onClearFilters }: EmptyStateProps) {
  return (
    <div className="kf-empty">
      <div className="kf-empty__glyph" aria-hidden="true">
        ◍
      </div>
      <h2 className="kf-empty__title">Nothing matches within {radiusKm} km yet</h2>
      <p className="kf-empty__body">
        That&apos;s a tight combination for East Van this morning. Try one of these — you won&apos;t lose your place.
      </p>
      <div className="kf-empty__actions">
        {canWiden && (
          <button type="button" className="kf-empty__action kf-empty__action--primary" onClick={onWidenRadius}>
            Widen the radius to {radiusKm === 5 ? 10 : 20} km
          </button>
        )}
        {hasActiveFilters && (
          <button type="button" className="kf-empty__action" onClick={onClearFilters}>
            Clear filters and show everything nearby
          </button>
        )}
        <p className="kf-empty__body" style={{ margin: '6px 0 0' }}>
          Schedules here usually post 2–4 weeks ahead. We&apos;ll recheck and keep expected listings separate.
        </p>
      </div>
    </div>
  );
}
