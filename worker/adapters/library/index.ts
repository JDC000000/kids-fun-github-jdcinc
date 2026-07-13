// worker/adapters/library/index.ts — G-T9-1/2: Library adapter scaffold
// (TSD §5.1 Adapter B, PRD §8 fam 7). Family 'library'; the extract() parser is
// selected per-system by platform (BiblioCommons vs Communico), the Communico
// parser doubling as the generic per-system feed fallback.
//
// Dry-run scaffold: library sources are terms_status='pending' and G-T5-6's gate
// blocks production runs until a terms decision lands. fetch() is a dry-run over
// a synthetic feed fixture; branch/location + exact date + age metadata are
// preserved so mapping keeps branch provenance (G-T9-3).
import type { Adapter, StructuredRecord, DedupKey } from '../../core/adapter';
import { LIBRARY_SYSTEMS, getLibrarySystem, type LibrarySystemConfig } from './config';

/** BiblioCommons/BiblioEvents-shaped event. */
interface BiblioEvent {
  id: string;
  title: string;
  branch: string;
  startsAt: string;
  endsAt: string;
  ages: string;
  url: string;
}

/** Communico/Libnet-shaped event. */
interface CommunicoEvent {
  eventId: string;
  name: string;
  location: string;
  start: string;
  end: string;
  audience: string;
  detailUrl: string;
}

export class LibraryAdapter implements Adapter {
  readonly family = 'library';

  constructor(private readonly system: LibrarySystemConfig) {}

  async fetch(): Promise<unknown[]> {
    // Synthetic per-platform feed fixtures (no live request). Shape only.
    if (this.system.platform === 'bibliocommons') {
      const events: BiblioEvent[] = [
        {
          id: `${this.system.systemKey}-baby-storytime-1`,
          title: 'Baby Storytime',
          branch: `${this.system.systemName} — Central`,
          startsAt: '2026-07-15T17:30:00.000Z',
          endsAt: '2026-07-15T18:00:00.000Z',
          ages: '0-2 years',
          url: `${this.system.feedBaseUrl}/${this.system.systemKey}-baby-storytime-1`,
        },
      ];
      return events;
    }
    const events: CommunicoEvent[] = [
      {
        eventId: `${this.system.systemKey}-toddler-storytime-1`,
        name: 'Toddler Storytime',
        location: `${this.system.systemName} — City Centre`,
        start: '2026-07-15T16:30:00.000Z',
        end: '2026-07-15T17:00:00.000Z',
        audience: 'Ages 2-5',
        detailUrl: `${this.system.feedBaseUrl}/${this.system.systemKey}-toddler-storytime-1`,
      },
    ];
    return events;
  }

  extract(raw: unknown[]): StructuredRecord[] {
    if (this.system.platform === 'bibliocommons') {
      return (raw as BiblioEvent[]).map((e) => ({
        sourceRecordId: e.id,
        title: e.title,
        venueName: e.branch, // branch/location provenance (G-T9-3)
        startDatetimeUtc: e.startsAt,
        endDatetimeUtc: e.endsAt,
        costStatus: 'free' as const,
        ageText: e.ages,
        categoryHint: 'storytime',
        sourceUrl: e.url,
        raw: e,
      }));
    }
    return (raw as CommunicoEvent[]).map((e) => ({
      sourceRecordId: e.eventId,
      title: e.name,
      venueName: e.location,
      startDatetimeUtc: e.start,
      endDatetimeUtc: e.end,
      costStatus: 'free' as const,
      ageText: e.audience,
      categoryHint: 'storytime',
      sourceUrl: e.detailUrl,
      raw: e,
    }));
  }

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `library::${this.system.systemKey}::${record.sourceRecordId}` };
  }
}

export function loadLibraryAdapters(): LibraryAdapter[] {
  return LIBRARY_SYSTEMS.map((system) => new LibraryAdapter(system));
}

export { LIBRARY_SYSTEMS, getLibrarySystem };
