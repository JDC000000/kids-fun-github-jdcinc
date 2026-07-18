// app/admin/dashboard/_components/KpiTiles.tsx — the Product-health KPI section.
//
// Presentational, server-compatible (no `use client`). Renders the KPI rollups
// from lib/analytics/kpi.ts as three tile groups (Engagement / Active users /
// Account value) built on the shared, brand-token-driven UI primitives
// (@/components/ui Card + Badge) rather than hand-rolled tile CSS, so these tiles
// read consistently with the rest of the design system and light/dark modes.
//
// Kept as a self-contained sibling under app/admin/dashboard/_components/ (a
// `_`-prefixed, non-route folder) so the T33 data-health and T34 admin-console
// sections can follow the same modular pattern instead of everything piling into
// page.tsx. All derived numbers use the pure, unit-tested helpers from kpi.ts.
import { Badge, Card } from '@/components/ui';
import { formatCount } from '@/lib/admin/format';
import {
  SOURCE_CTR_TARGET_PCT,
  perDay,
  signedInSharePct,
  sourceCtrPct,
  zeroResultPct,
  type ProductHealthKpis,
} from '@/lib/analytics/kpi';
import styles from './KpiTiles.module.css';

const EM_DASH = '—';

/** A percentage value → "42%", or an em-dash when null (not enough data). */
function formatPct(value: number | null): string {
  return value == null ? EM_DASH : `${value}%`;
}

/** A per-day rate → "12.5 / day". */
function formatPerDay(value: number): string {
  return `${value.toLocaleString('en-CA', { maximumFractionDigits: 1 })} / day`;
}

interface KpiTileProps {
  label: string;
  value: string;
  sub?: string;
  badge?: { text: string; variant: 'confirmed' | 'info' | 'expected' | 'neutral' };
}

/** One KPI tile: a Card surface with a label, a big tabular value, an optional
 *  target/status Badge and an optional sub-line. */
function KpiTile({ label, value, sub, badge }: KpiTileProps) {
  return (
    <Card className={styles.tile}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
      {badge && (
        <div className={styles.badgeRow}>
          <Badge variant={badge.variant}>{badge.text}</Badge>
        </div>
      )}
      {sub && <div className={styles.sub}>{sub}</div>}
    </Card>
  );
}

function KpiGroup({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className={styles.group}>
      <h3 className={styles.groupTitle}>{title}</h3>
      <p className={styles.groupHint}>{hint}</p>
      <div className={styles.grid}>{children}</div>
    </div>
  );
}

/** Badge describing how the source CTR compares to the §12.5 KPI #7 target. */
function ctrBadge(ctr: number | null): KpiTileProps['badge'] {
  if (ctr == null) return { text: `target ≥${SOURCE_CTR_TARGET_PCT}%`, variant: 'neutral' };
  return ctr >= SOURCE_CTR_TARGET_PCT
    ? { text: `≥${SOURCE_CTR_TARGET_PCT}% target met`, variant: 'confirmed' }
    : { text: `below ${SOURCE_CTR_TARGET_PCT}% target`, variant: 'expected' };
}

export function KpiTiles({ kpis }: { kpis: ProductHealthKpis }) {
  const { windows, engagement, activeUsers, accountValue } = kpis;

  const ctr = sourceCtrPct(engagement.outboundClicks, engagement.listingViews);
  const zeroRate = zeroResultPct(engagement.zeroResultSearches, engagement.searchesWithResults);
  const signedInShare = signedInSharePct(accountValue.signedInUsers, activeUsers.mau);

  return (
    <section className={styles.wrap} aria-label="Product-health KPIs">
      <KpiGroup
        title={`Engagement · last ${windows.engagementDays} days`}
        hint="Volume and click-through from analytics_event. Per-day rates are the window total averaged over its calendar days."
      >
        <KpiTile
          label="Searches"
          value={formatPerDay(perDay(engagement.searches, windows.engagementDays))}
          sub={`${formatCount(engagement.searches)} in ${windows.engagementDays}d`}
        />
        <KpiTile
          label="Listing views"
          value={formatPerDay(perDay(engagement.listingViews, windows.engagementDays))}
          sub={`${formatCount(engagement.listingViews)} in ${windows.engagementDays}d`}
        />
        <KpiTile
          label="Outbound source clicks"
          value={formatPerDay(perDay(engagement.outboundClicks, windows.engagementDays))}
          sub={`${formatCount(engagement.outboundClicks)} in ${windows.engagementDays}d`}
        />
        <KpiTile
          label="Source click-through rate"
          value={formatPct(ctr)}
          badge={ctrBadge(ctr)}
          sub={`${formatCount(engagement.outboundClicks)} clicks ÷ ${formatCount(engagement.listingViews)} views`}
        />
        <KpiTile
          label="Zero-result search rate"
          value={formatPct(zeroRate)}
          sub={
            engagement.broadenedSearches > 0
              ? `${formatCount(engagement.zeroResultSearches)} of ${formatCount(engagement.searchesWithResults)} · ${formatCount(engagement.broadenedSearches)} recovered via broadening`
              : `${formatCount(engagement.zeroResultSearches)} of ${formatCount(engagement.searchesWithResults)} searches`
          }
        />
      </KpiGroup>

      <KpiGroup
        title="Active users"
        hint="Distinct anonymous sessions / signed-in accounts (user_or_session) seen across all events in each rolling window — the product-owner's DAU/WAU/MAU without a DB query."
      >
        <KpiTile label={`DAU · last ${windows.dauDays}d`} value={formatCount(activeUsers.dau)} sub="distinct actors (24h)" />
        <KpiTile label={`WAU · last ${windows.wauDays}d`} value={formatCount(activeUsers.wau)} sub="distinct actors (7d)" />
        <KpiTile label={`MAU · last ${windows.mauDays}d`} value={formatCount(activeUsers.mau)} sub="distinct actors (30d)" />
        <KpiTile
          label={`Signed-in users · last ${windows.mauDays}d`}
          value={formatCount(accountValue.signedInUsers)}
          badge={
            signedInShare == null
              ? undefined
              : { text: `${signedInShare}% of MAU`, variant: 'info' }
          }
          sub="distinct accounts that signed in"
        />
      </KpiGroup>

      <KpiGroup
        title={`Account value · last ${windows.accountDays} days`}
        hint="Repeat-use / retention signals — parents investing in an account. These fill in as the account, saved-search and email streams wire their §9 events."
      >
        <KpiTile
          label="Saved searches created"
          value={formatCount(accountValue.savedSearches)}
          sub="saved_search_created events"
        />
        <KpiTile
          label="Weekly-email opt-ins"
          value={formatCount(accountValue.emailOptIns)}
          sub="weekly_email_opt_in (opted-in)"
        />
        <KpiTile
          label="Sign-ins"
          value={formatCount(accountValue.signInEvents)}
          sub="account_signed_in events"
        />
      </KpiGroup>
    </section>
  );
}
