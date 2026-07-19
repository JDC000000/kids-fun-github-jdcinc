// CoverageMatrix.tsx — G-T33-3: launch-region × P0-family coverage board (the G2
// "coverage-or-gap" gate criterion). Presentational, server-compatible.
//
// Rows are the P0 activity families (primary-eligible categories); columns are the
// launch municipalities (matching /search's REGION_CHIPS). Every cell shows either a
// live occurrence count with the contributing source-networks (ActiveNet / PerfectMind
// / …) OR an EXPLICIT "gap" marker — never a blank/silent cell, so a hole in coverage
// is impossible to miss. All numbers come pre-assembled from lib/admin/data-health.ts.
import { Badge } from '@/components/ui';
import { formatCount } from '@/lib/admin/format';
import {
  networkLabel,
  networkShort,
  type CoverageCell,
  type CoverageMatrix as CoverageMatrixData,
} from '@/lib/admin/data-health';
import styles from './DataHealth.module.css';

function Cell({ cell }: { cell: CoverageCell }) {
  if (cell.gap) {
    return (
      <td className={styles.cellGap}>
        <Badge variant="cancelled">gap</Badge>
      </td>
    );
  }
  // Networks contributing to this cell, largest first.
  const nets = Object.entries(cell.byNetwork).sort((a, b) => b[1] - a[1]);
  return (
    <td className={styles.cellCovered}>
      <div className={styles.cellCount}>{formatCount(cell.total)}</div>
      <div className={styles.cellNets}>
        {nets.map(([network, count]) => (
          <span key={network} className={styles.netChip} title={`${networkLabel(network)}: ${count}`}>
            {networkShort(network)} {count}
          </span>
        ))}
      </div>
    </td>
  );
}

export function CoverageMatrix({ coverage }: { coverage: CoverageMatrixData }) {
  const { regions, rows, regionTotals, grandTotal, cellCount, coveredCount, gapCount } = coverage;

  return (
    <section className={styles.section} aria-label="Coverage matrix">
      <h2 className={styles.sectionTitle}>Coverage matrix — region × activity family</h2>
      <p className={styles.hint}>
        Live (non-archived) listing coverage for every launch municipality × P0 activity family, attributed by venue
        municipality, primary category, and source-network. A red <strong>gap</strong> cell means we currently hold{' '}
        <em>zero</em> listings for that combination — the explicit coverage-or-gap board (G2). Counts are the occurrence
        total; the chips show which networks contribute (e.g. <span className={styles.mono}>AN</span> = ActiveNet,{' '}
        <span className={styles.mono}>PM</span> = PerfectMind).
      </p>

      <p className={styles.hint}>
        <strong>{formatCount(coveredCount)}</strong> of {formatCount(cellCount)} cells covered ·{' '}
        <strong>{formatCount(gapCount)}</strong> gap{gapCount === 1 ? '' : 's'} ·{' '}
        {formatCount(grandTotal)} live occurrence(s) across the grid.
      </p>

      <div className={styles.matrixScroll}>
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th className={styles.matrixCorner}>P0 family \ Region</th>
              {regions.map((r) => (
                <th key={r.key} title={r.name}>
                  {r.label}
                </th>
              ))}
              <th className={styles.totalCol}>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.family.key}>
                <th scope="row" className={styles.familyCell} title={row.family.key}>
                  {row.family.label}
                </th>
                {row.cells.map((cell) => (
                  <Cell key={`${cell.regionKey}-${cell.familyKey}`} cell={cell} />
                ))}
                <td className={`${styles.num} ${styles.totalCol}`}>{formatCount(row.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className={`${styles.familyCell} ${styles.totalRow}`}>
                Total
              </th>
              {regionTotals.map((t, i) => (
                <td key={regions[i].key} className={`${styles.num} ${styles.totalRow}`}>
                  {formatCount(t)}
                </td>
              ))}
              <td className={`${styles.num} ${styles.totalRow}`}>{formatCount(grandTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchCovered}`} aria-hidden="true" /> covered (count + networks)
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchGap}`} aria-hidden="true" /> gap (zero coverage)
        </span>
        {coverage.networks.length > 0 && (
          <span className={styles.legendItem}>
            networks:{' '}
            {coverage.networks.map((n, i) => (
              <span key={n}>
                {i > 0 ? ', ' : ''}
                <span className={styles.mono}>{networkShort(n)}</span> = {networkLabel(n)}
              </span>
            ))}
          </span>
        )}
      </div>
    </section>
  );
}
