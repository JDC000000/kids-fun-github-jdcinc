'use client';

// components/charts/TrendChart.tsx — hand-rolled SVG trend chart (M5 / T32, G-T32-6).
//
// A dependency-free line/area chart built to the dataviz method: 2px round-capped
// lines, ≥8px end-markers with a 2px surface ring, a single 0-anchored baseline,
// hairline recessive grid, a legend for ≥2 series (none for one — the title names
// it), selective DIRECT end-labels, a crosshair+tooltip hover layer with keyboard
// parity, and a TABLE-VIEW TWIN so every value is reachable without hover and colour
// is never the sole identity channel (WCAG 1.4.1). Series colours come from the
// validated --kf-chart-* tokens (never a raw hex here), so light/dark swap in one
// place and stay the audited palette.
//
// It is a client component for the interaction layer, but its INITIAL markup (SVG +
// legend + table) is server-rendered by Next — present in the SSR DOM for the axe
// audit and legible with JavaScript disabled. All text is set via React children
// (escaped), never innerHTML.
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  axisMax,
  axisTicks,
  areaPath,
  linePath,
  plotArea,
  projectValues,
  scaleX,
  type PlotBox,
} from './scale';
import type { TrendSeries, ValueFormatter } from './types';
import styles from './TrendChart.module.css';

// NOTE: this is a client component rendered by a SERVER page, so its props must be
// plain serialisable data — a formatter FUNCTION cannot cross that boundary (React
// throws "Functions cannot be passed directly to Client Components"). Formatting is
// therefore done INTERNALLY (count + date), never via a function prop.

const VIEW: PlotBox = {
  width: 720,
  height: 260,
  padTop: 16,
  padRight: 60,
  padBottom: 30,
  padLeft: 48,
};

const defaultFormat: ValueFormatter = (n) => n.toLocaleString('en-CA');

export interface TrendChartProps {
  /** Accessible name / caption for the figure. */
  title: string;
  /** Short description under the title (optional). */
  caption?: string;
  /** X-axis category labels, oldest→newest (e.g. ISO dates). */
  x: string[];
  /** 1..3 series aligned to `x`. */
  series: TrendSeries[];
  /** Single-series area wash (ignored unless exactly one series). */
  area?: boolean;
  /** Show at most this many x-axis labels (evenly sampled). Default 6. */
  maxXLabels?: number;
}

function defaultFormatX(raw: string): string {
  // 'YYYY-MM-DD' → 'Mon D' without pulling in a date lib or touching the clock.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return raw;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = months[Number(m[2]) - 1] ?? m[2];
  return `${mon} ${Number(m[3])}`;
}

export function TrendChart({ title, caption, x, series, area = false, maxXLabels = 6 }: TrendChartProps) {
  // Internal formatters — NOT props (see the note above on the RSC function-prop rule).
  const valueFormat: ValueFormatter = defaultFormat;
  const formatX = defaultFormatX;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const count = x.length;
  const isArea = area && series.length === 1;
  const showLegend = series.length >= 2;

  // ── Geometry (pure; the same maths scale.ts unit-tests) ──────────────────────
  const geo = useMemo(() => {
    const box = plotArea(VIEW);
    const rawMax = series.reduce((m, s) => {
      const sMax = s.values.reduce((a, b) => (Number.isFinite(b) && b > a ? b : a), 0);
      return sMax > m ? sMax : m;
    }, 0);
    const ticks = axisTicks(rawMax, 4);
    const yMax = axisMax(ticks);
    const xs = Array.from({ length: count }, (_, i) => scaleX(i, count, box));
    const lines = series.map((s) => {
      const pts = projectValues(s.values, yMax, box);
      return { series: s, pts, d: linePath(pts), area: isArea ? areaPath(pts, box.bottom) : '' };
    });
    return { box, ticks, yMax, xs, lines };
  }, [series, count, isArea]);

  // Evenly sample x labels (always include first & last) to avoid axis clutter.
  const xLabelIdx = useMemo(() => {
    if (count === 0) return [] as number[];
    if (count <= maxXLabels) return Array.from({ length: count }, (_, i) => i);
    const step = (count - 1) / (maxXLabels - 1);
    const idx = new Set<number>();
    for (let k = 0; k < maxXLabels; k++) idx.add(Math.round(k * step));
    idx.add(count - 1);
    return [...idx].sort((a, b) => a - b);
  }, [count, maxXLabels]);

  // Direct end-labels: the last value of each series, de-collided vertically.
  const endLabels = useMemo(() => {
    const items = geo.lines
      .map((l) => ({
        key: l.series.key,
        colorVar: l.series.colorVar,
        y: l.pts.length ? l.pts[l.pts.length - 1].y : geo.box.bottom,
        text: l.series.values.length ? valueFormat(l.series.values[l.series.values.length - 1]) : '',
      }))
      .sort((a, b) => a.y - b.y);
    const MIN_GAP = 14;
    for (let i = 1; i < items.length; i++) {
      if (items[i].y - items[i - 1].y < MIN_GAP) items[i].y = items[i - 1].y + MIN_GAP;
    }
    // Keep labels inside the box.
    for (const it of items) it.y = Math.min(geo.box.bottom, Math.max(geo.box.top + 6, it.y));
    return items;
  }, [geo, valueFormat]);

  function nearestIndex(evt: PointerEvent<SVGSVGElement>): number | null {
    const svg = svgRef.current;
    if (!svg || count === 0) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const local = pt.matrixTransform(ctm.inverse());
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < geo.xs.length; i++) {
      const dist = Math.abs(geo.xs[i] - local.x);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  function onPointerMove(evt: PointerEvent<SVGSVGElement>) {
    setActive(nearestIndex(evt));
  }

  function onKeyDown(evt: KeyboardEvent<HTMLDivElement>) {
    if (count === 0) return;
    const cur = active ?? count - 1;
    let next: number | null = null;
    if (evt.key === 'ArrowRight') next = Math.min(count - 1, cur + 1);
    else if (evt.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (evt.key === 'Home') next = 0;
    else if (evt.key === 'End') next = count - 1;
    else if (evt.key === 'Escape') next = null;
    else return;
    evt.preventDefault();
    setActive(next);
  }

  const activeSafe = active != null && active >= 0 && active < count ? active : null;
  const tooltipLeftPct = activeSafe != null ? (geo.xs[activeSafe] / VIEW.width) * 100 : 0;
  const ariaLabel =
    `${title}: ${series.map((s) => s.label).join(', ')} over ${count} day${count === 1 ? '' : 's'}. ` +
    `Full data in the table below the chart.`;

  return (
    <figure className={styles.figure}>
      <figcaption className={styles.caption}>
        <span className={styles.title}>{title}</span>
        {caption && <span className={styles.sub}>{caption}</span>}
      </figcaption>

      {showLegend && (
        <ul className={styles.legend}>
          {series.map((s) => (
            <li key={s.key} className={styles.legendItem}>
              <span className={styles.legendKey} style={{ background: s.colorVar }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
      )}

      <div
        className={styles.plot}
        tabIndex={0}
        role="group"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((a) => (a == null ? count - 1 : a))}
        onBlur={() => setActive(null)}
      >
        <svg
          ref={svgRef}
          className={styles.svg}
          viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
          role="img"
          aria-label={ariaLabel}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
        >
          {/* Horizontal gridlines + y-axis tick labels (recessive hairlines). */}
          {geo.ticks.map((t) => {
            const y = geo.box.bottom - (geo.yMax > 0 ? (t / geo.yMax) * geo.box.h : 0);
            return (
              <g key={`grid-${t}`}>
                <line
                  x1={geo.box.left}
                  x2={geo.box.right}
                  y1={y}
                  y2={y}
                  className={t === 0 ? styles.baseline : styles.grid}
                />
                <text x={geo.box.left - 8} y={y + 3} className={styles.yTick}>
                  {valueFormat(t)}
                </text>
              </g>
            );
          })}

          {/* X-axis labels (sampled). */}
          {xLabelIdx.map((i) => (
            <text key={`x-${i}`} x={geo.xs[i]} y={VIEW.height - 10} className={styles.xTick}>
              {formatX(x[i])}
            </text>
          ))}

          {/* Area wash (single-series only). */}
          {isArea &&
            geo.lines.map((l) => (
              <path key={`area-${l.series.key}`} d={l.area} fill="var(--kf-chart-1-wash)" stroke="none" />
            ))}

          {/* Crosshair for the active x. */}
          {activeSafe != null && (
            <line
              x1={geo.xs[activeSafe]}
              x2={geo.xs[activeSafe]}
              y1={geo.box.top}
              y2={geo.box.bottom}
              className={styles.crosshair}
            />
          )}

          {/* Series lines. */}
          {geo.lines.map((l) => (
            <path
              key={`line-${l.series.key}`}
              d={l.d}
              fill="none"
              stroke={l.series.colorVar}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* End-markers (≥8px, 2px surface ring). */}
          {geo.lines.map((l) => {
            const p = l.pts[l.pts.length - 1];
            if (!p) return null;
            return (
              <circle
                key={`end-${l.series.key}`}
                cx={p.x}
                cy={p.y}
                r={4}
                fill={l.series.colorVar}
                stroke="var(--kf-surface)"
                strokeWidth={2}
              />
            );
          })}

          {/* Active-point markers on the crosshair. */}
          {activeSafe != null &&
            geo.lines.map((l) => {
              const p = l.pts[activeSafe];
              if (!p) return null;
              return (
                <circle
                  key={`act-${l.series.key}`}
                  cx={p.x}
                  cy={p.y}
                  r={4}
                  fill={l.series.colorVar}
                  stroke="var(--kf-surface)"
                  strokeWidth={2}
                />
              );
            })}

          {/* Direct end-labels (value in ink; identity via the coloured end-dot beside it). */}
          {endLabels.map((it) => (
            <text key={`lbl-${it.key}`} x={geo.box.right + 8} y={it.y + 3} className={styles.endLabel}>
              {it.text}
            </text>
          ))}
        </svg>

        {/* Tooltip — every series' value at the active x. Positioned by % so it
            tracks the scaled SVG without a resize observer. */}
        {activeSafe != null && (
          <div
            className={styles.tooltip}
            style={{ left: `${tooltipLeftPct}%` }}
            role="status"
            aria-live="polite"
          >
            <div className={styles.tooltipDate}>{x[activeSafe]}</div>
            <ul className={styles.tooltipList}>
              {series.map((s) => (
                <li key={s.key} className={styles.tooltipRow}>
                  <span className={styles.tooltipKey} style={{ background: s.colorVar }} aria-hidden="true" />
                  <span className={styles.tooltipLabel}>{s.label}</span>
                  <span className={styles.tooltipValue}>{valueFormat(s.values[activeSafe] ?? 0)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Table-view twin — the WCAG-clean equivalent; every value reachable without hover. */}
      <details className={styles.tableWrap}>
        <summary className={styles.tableSummary}>Show data table</summary>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>{title} — daily values</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                {series.map((s) => (
                  <th scope="col" key={s.key} className={styles.num}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {x.map((d, i) => (
                <tr key={d}>
                  <th scope="row" className={styles.dateCell}>
                    {d}
                  </th>
                  {series.map((s) => (
                    <td key={s.key} className={styles.num}>
                      {valueFormat(s.values[i] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
