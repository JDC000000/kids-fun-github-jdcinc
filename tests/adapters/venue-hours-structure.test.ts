// Venue opening hours keep the per-day structure the source published (P1-7b).
//
// THE BUGS. `parseOpeningHours` collected schema.org markup into a day→hours map and flattened it
// to a sentence on the way out. Two facts were destroyed on that path and one was invented:
//
//   1. A spec that NAMED days we could not read was published as "open daily". `dayOfWeek` in its
//      object form (`{"@id": "https://schema.org/Saturday"}`) is legal JSON-LD and parses to no day
//      names, and the old fallback treated "no days parsed" identically to "no days stated" — so a
//      Saturday-only venue was advertised as open all week. This is the "arrive at a closed
//      building" failure: the hours a parent acts on said open on a day the venue never claimed.
//   2. A day with SPLIT HOURS kept only its last window (`map.set` overwrote), so a venue open
//      10–1 and 2–5 published "2 PM–5 PM" and its whole morning disappeared.
//   3. The per-day facts never left the adapter at all, so nothing downstream could ever answer
//      "is it open today?" without re-parsing our own prose.

import { describe, expect, it } from 'vitest';
import { formatWeeklyHours, parseOpeningHours, parseWeeklyHours } from '../../worker/adapters/venue';

/** The days a parsed week says the venue is open, Monday-first. */
function openDays(nodes: Record<string, unknown>[]): string[] {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const week = parseWeeklyHours(nodes)!;
  return names.filter((_, i) => week.days[i].length > 0);
}

describe('a spec whose days we cannot read claims no days — never the whole week', () => {
  // dayOfWeek as JSON-LD node references rather than plain strings. Legal, and unparseable here.
  const objectDayOfWeek = [
    {
      openingHoursSpecification: [
        {
          '@type': 'OpeningHoursSpecification',
          dayOfWeek: [{ '@id': 'https://schema.org/Saturday' }],
          opens: '10:00',
          closes: '18:00',
        },
      ],
    },
  ];

  it('does NOT advertise a Saturday-only venue as open daily', () => {
    // The regression. Before the fix this returned 'Daily 10 AM–6 PM'.
    expect(parseOpeningHours(objectDayOfWeek)).not.toBe('Daily 10 AM–6 PM');
    expect(parseOpeningHours(objectDayOfWeek)).toBeUndefined();
  });

  it('claims no day at all rather than guessing which one was meant', () => {
    expect(parseWeeklyHours(objectDayOfWeek)).toBeUndefined();
  });

  it('still reads every day as open when dayOfWeek is genuinely ABSENT (schema.org: all days)', () => {
    // The case the old fallback was actually for, and it must keep working.
    const noDayOfWeek = [
      { openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', opens: '10:00', closes: '18:00' }] },
    ];
    expect(parseOpeningHours(noDayOfWeek)).toBe('Daily 10 AM–6 PM');
    expect(openDays(noDayOfWeek)).toHaveLength(7);
  });

  it('drops an unreadable day part in the STRING form too, rather than assuming all week', () => {
    expect(parseOpeningHours([{ openingHours: ['Hols 10:00-17:00'] }])).toBeUndefined();
  });
});

describe('a day that closes over lunch keeps both of its windows', () => {
  const splitDay = [{ openingHours: ['Sa 10:00-13:00', 'Sa 14:00-17:00'] }];

  it('renders both windows instead of only the last one', () => {
    // The regression. Before the fix the 10–1 window was overwritten and this read 'Sat 2 PM–5 PM'.
    expect(parseOpeningHours(splitDay)).toBe('Sat 10 AM–1 PM, 2 PM–5 PM');
  });

  it('holds them as two separate windows on that day', () => {
    const week = parseWeeklyHours(splitDay)!;
    expect(week.days[5]).toEqual([
      { opens: '10:00', closes: '13:00' },
      { opens: '14:00', closes: '17:00' },
    ]);
  });

  it('orders windows by opening time regardless of the order the source listed them', () => {
    const reversed = [{ openingHours: ['Sa 14:00-17:00', 'Sa 10:00-13:00'] }];
    expect(parseOpeningHours(reversed)).toBe('Sat 10 AM–1 PM, 2 PM–5 PM');
  });

  it('lets a more specific OVERLAPPING window replace the general one it contradicts', () => {
    // Not a split day — a general week plus a narrower Saturday. Printing both would contradict.
    const override = [{ openingHours: ['Mo-Su 09:00-17:00', 'Sa 10:00-16:00'] }];
    const week = parseWeeklyHours(override)!;
    expect(week.days[5]).toEqual([{ opens: '10:00', closes: '16:00' }]);
    expect(week.days[0]).toEqual([{ opens: '09:00', closes: '17:00' }]);
  });
});

describe('a day the venue is closed is absent, not assumed open', () => {
  const closedMondays = [{ openingHours: ['Tu-Su 10:00-17:00'] }];

  it('never rolls a closed day into a "Daily" claim', () => {
    expect(parseOpeningHours(closedMondays)).toBe('Tue–Sun 10 AM–5 PM');
    expect(parseOpeningHours(closedMondays)).not.toContain('Daily');
  });

  it('holds Monday as an empty window list — "not open", distinct from "unknown"', () => {
    const week = parseWeeklyHours(closedMondays)!;
    expect(week.days[0]).toEqual([]);
    expect(openDays(closedMondays)).toEqual(['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  it('breaks a day run around a midweek closure instead of spanning it', () => {
    const closedWednesday = [{ openingHours: ['Mo-Tu 10:00-17:00', 'Th-Su 10:00-17:00'] }];
    expect(parseOpeningHours(closedWednesday)).toBe('Mon–Tue 10 AM–5 PM; Thu–Sun 10 AM–5 PM');
    expect(openDays(closedWednesday)).not.toContain('Wed');
  });
});

describe('the correct cases still render exactly as they did', () => {
  it('keeps the pinned weekday/weekend split', () => {
    expect(parseOpeningHours([{ openingHours: ['Mo-Fr 09:00-17:00', 'Sa-Su 10:00-16:00'] }])).toBe(
      'Mon–Fri 9 AM–5 PM; Sat–Sun 10 AM–4 PM',
    );
  });

  it('keeps the pinned all-week form', () => {
    expect(parseOpeningHours([{ openingHours: ['Mo-Su 09:30-17:00'] }])).toBe('Daily 9:30 AM–5 PM');
  });

  it('still returns undefined when the markup states no hours at all', () => {
    expect(parseOpeningHours([{ name: 'No Hours Here' }])).toBeUndefined();
    expect(parseWeeklyHours([{ name: 'No Hours Here' }])).toBeUndefined();
  });

  it('exposes the weekday/weekend read as a DERIVED view of the per-day structure', () => {
    // The ticket asked for a weekday/weekend object. Per-day is strictly richer: this read is
    // derivable from it, while "closed Wednesday" above is not expressible in a weekday/weekend
    // pair at all — which is why the structure is per-day and this is a projection of it.
    const week = parseWeeklyHours([{ openingHours: ['Mo-Fr 09:00-17:00', 'Sa-Su 10:00-16:00'] }])!;
    expect(formatWeeklyHours({ days: week.days.slice(0, 5).concat([[], []]) })).toBe('Mon–Fri 9 AM–5 PM');
    expect(formatWeeklyHours({ days: [[], [], [], [], [], ...week.days.slice(5)] })).toBe('Sat–Sun 10 AM–4 PM');
  });
});
