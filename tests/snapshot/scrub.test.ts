// tests/snapshot/scrub.test.ts — unit lane. No database, no filesystem.
//
// The anonymisation pass is the one piece of this pipeline whose failure mode is silent: an
// export that scrubs nothing still produces a file, still loads, and still makes the suites
// green. So every rule gets an adversarial case here, in the FAST lane, where it runs on every
// CI run rather than only when somebody opts into snapshot mode.
//
// Cases are written from the shapes real scraped municipal/library listings actually contain.
import { describe, expect, it } from 'vitest';
import {
  REDACTION,
  isPlaceholderPhone,
  placeholderPhone,
  redactContact,
  redactProse,
  redactTitle,
  residualFindings,
  stripRedactionMarkers,
} from '../../lib/snapshot/scrub';
import { transformRow, selectListSql } from '../../lib/snapshot/transform';
import { tablePolicy } from '../../lib/snapshot/policy';

describe('redactContact — the conservative pass (URLs, addresses, labels)', () => {
  it('removes email addresses', () => {
    const r = redactContact('Register at signup@parksandrec.example.ca before Friday.');
    expect(r.value).toBe(`Register at ${REDACTION.email} before Friday.`);
    expect(r.hits.email).toBe(1);
  });

  it.each([
    ['(604) 555-0123', 'bracketed area code'],
    ['604-555-0123', 'hyphenated'],
    ['604.555.0123', 'dotted'],
    ['+1 604 555 0123', 'international, spaced'],
    ['1-800-555-0199', 'toll free'],
    ['604-555-0123 ext 22', 'with extension'],
  ])('removes the phone number %s (%s)', (phone) => {
    const r = redactContact(`Call ${phone} for details.`);
    expect(r.value).toBe(`Call ${REDACTION.phone} for details.`);
    expect(r.hits.phone).toBe(1);
  });

  it('strips credentials smuggled into a scraped URL, keeping the scheme and host', () => {
    const r = redactContact('https://scraper:hunter2@events.example.org/feed.json');
    expect(r.value).toBe(`https://${REDACTION.credentials}@events.example.org/feed.json`);
    expect(r.value).not.toContain('hunter2');
    expect(r.hits.credentials).toBe(1);
  });

  it('KEEPS postal codes and proper nouns — a public venue address is public catalogue data', () => {
    const address = '1 Kingsway, Vancouver, BC V5T 3H7';
    expect(redactContact(address).value).toBe(address);
  });

  it('does not apply the person heuristic', () => {
    // That is redactProse/redactTitle's job; conservative means conservative.
    expect(redactContact('Contact Amelia Novak').value).toBe('Contact Amelia Novak');
  });

  it('leaves an ordinary description untouched and reports no hits', () => {
    const clean = 'Songs, rhymes and stories for ages 0-5. Drop in, no registration.';
    const r = redactContact(clean);
    expect(r.value).toBe(clean);
    expect(Object.keys(r.hits)).toHaveLength(0);
  });
});

describe('phone detection does not fire on identifiers', () => {
  // A UUID with all-digit runs used to match the phone pattern through its interior, which made
  // the verifier flag `provenance.id`. A phone is a standalone token, never a substring.
  it.each([
    '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    '12345678-9012-4345-8901-234567890123',
    'synthprod-bulk-1234567890',
    'record_6045550123_v2',
  ])('leaves the identifier %s alone', (id) => {
    expect(redactProse(id).value).toBe(id);
  });

  it('still catches a bare ten-digit phone in prose, where it IS standalone', () => {
    const r = redactProse('Call the desk at 6045550198 to register.');
    expect(r.value).toBe(`Call the desk at ${REDACTION.phone} to register.`);
    expect(r.hits.phone_bare).toBe(1);
  });
});

describe('redactProse — the aggressive pass (scraped descriptions, notes)', () => {
  it('removes a contact name but keeps the sentence around it', () => {
    const r = redactProse('For a quieter session please contact Amelia Novak at the desk.');
    expect(r.value).toBe(`For a quieter session please contact ${REDACTION.person} at the desk.`);
    expect(r.value).not.toContain('Amelia');
    expect(r.hits.person).toBe(1);
  });

  it('stops the name at the first non-name word rather than eating the rest of the sentence', () => {
    // The regex captures up to three words; "Priya Raman at" is three, but only two are a name.
    const r = redactProse('Older siblings welcome — ask for Priya Raman at the desk.');
    expect(r.value).toBe(`Older siblings welcome — ask for ${REDACTION.person} at the desk.`);
  });

  it('handles a capitalised keyword (Contact/CONTACT), not just lowercase', () => {
    expect(redactProse('Questions? Contact Amelia Novak.').value).toContain(REDACTION.person);
    expect(redactProse('QUESTIONS? CONTACT Amelia Novak.').value).toContain(REDACTION.person);
  });

  it('keeps a multi-word surname together', () => {
    const r = redactProse('Instructor Anke van der Berg leads this session.');
    expect(r.value).toBe(`Instructor ${REDACTION.person} leads this session.`);
  });

  it('does not treat a lowercase object as a name', () => {
    const s = 'Contact us for details about the program.';
    expect(redactProse(s).value).toBe(s);
  });

  it('removes a Canadian postal code from prose', () => {
    const r = redactProse('Meet at the shelter, V6B 1A1, ten minutes before.');
    expect(r.value).toBe(`Meet at the shelter, ${REDACTION.postal}, ten minutes before.`);
  });

  it('handles the full adversarial line — email, phone and name in one sentence', () => {
    const r = redactProse(
      'Drop in, no registration. Questions? Contact Amelia Novak at amelia@example.org or 604-555-0123. Accessible entrance at V5T 3H7.'
    );
    expect(r.value).not.toMatch(/Amelia|amelia@|604-555-0123|V5T 3H7/);
    expect(residualFindings(r.value, 'redact_prose')).toEqual([]);
  });
});

describe('redactTitle — the middle pass, and WHY it is not redactProse', () => {
  it('removes an instructor name introduced by an unambiguous contact phrase', () => {
    const r = redactTitle('Parent & Tot Swim (register with Coach Mira Halvorsen)');
    expect(r.value).not.toContain('Mira');
    expect(r.value).toContain('Parent & Tot Swim');
  });

  it('KEEPS role words that carry FTS weight-A search meaning', () => {
    // The broad prose keyword set would eat "Coach" and "Host" here and quietly break the very
    // search-relevance behaviour a production snapshot exists to exercise.
    for (const title of ['Coach Approach Basketball', 'Host Your Own Birthday Party', 'Leader in Training']) {
      expect(redactTitle(title).value).toBe(title);
    }
    expect(redactProse('Coach Approach Basketball').value).not.toBe('Coach Approach Basketball');
  });

  it('still strips an email or phone welded into a title', () => {
    const r = redactTitle('Pottery Drop-In — book at clay@example.org');
    expect(r.value).toBe(`Pottery Drop-In — book at ${REDACTION.email}`);
  });
});

describe('placeholderPhone — shape survives, the number does not', () => {
  it.each([
    ['(604) 555-0123', '(604) 555-0100'],
    ['604-555-0198', '604-555-0100'],
    ['+1 604 555 0164', '+6 045 550 1006'],
  ])('rewrites %s keeping every non-digit in place', (input, expected) => {
    expect(placeholderPhone(input)).toBe(expected);
  });

  it('is constant for the same shape — two different numbers become the same placeholder', () => {
    expect(placeholderPhone('604-555-0198')).toBe(placeholderPhone('778-555-0111'));
  });

  it('preserves punctuation and digit count exactly', () => {
    const input = '(778) 555-9999 ext 4021';
    const out = placeholderPhone(input);
    expect(out.replace(/\d/g, '#')).toBe(input.replace(/\d/g, '#'));
    expect(out).not.toBe(input);
  });

  it('round-trips through the verifier’s exact inverse check', () => {
    expect(isPlaceholderPhone(placeholderPhone('(604) 555-0123'))).toBe(true);
    expect(isPlaceholderPhone('(604) 555-0123')).toBe(false);
  });
});

describe('residualFindings — the acceptance scan the verifier runs', () => {
  it('does not flag its own redaction markers', () => {
    // `https://[credentials-redacted]@host` still matches the credentials detector; the scan
    // strips markers first, or every successful redaction would be reported as a failure.
    expect(residualFindings(`https://${REDACTION.credentials}@example.org/x`, 'redact_contact')).toEqual([]);
    expect(residualFindings(`Contact ${REDACTION.person} at ${REDACTION.email}`, 'redact_prose')).toEqual([]);
  });

  it('flags an email that survived on a preserve column', () => {
    expect(residualFindings('someone@example.org', 'preserve')).toContain('email');
  });

  it('does NOT flag a bare ten-digit id on a preserve column', () => {
    // source_record_id is routinely a long numeric upstream id; failing an export for that
    // would be a false alarm that trains people to ignore the alarm.
    expect(residualFindings('6045550123', 'preserve')).toEqual([]);
  });

  it('DOES flag a bare ten-digit number on a prose column, which has been scrubbed', () => {
    expect(residualFindings('call 6045550123', 'redact_prose')).toContain('phone_bare');
  });

  it('flags a postal code only on prose, not on an address', () => {
    expect(residualFindings('V5T 3H7', 'redact_prose')).toContain('postal');
    expect(residualFindings('1 Kingsway, Vancouver, BC V5T 3H7', 'redact_contact')).toEqual([]);
  });
});

describe('stripRedactionMarkers', () => {
  it('removes every marker the scrubber can emit', () => {
    const all = Object.values(REDACTION).join(' ');
    expect(stripRedactionMarkers(all).trim()).toBe('');
  });
});

describe('transformRow — policy application', () => {
  const venue = tablePolicy('venue');

  it('applies each column its policy action and nothing else', () => {
    expect(venue).toBeTruthy();
    const { row, hits } = transformRow(venue!, {
      id: 'cccc0000-0000-4000-8000-000000000001',
      name: 'Mount Pleasant Branch',
      address: '1 Kingsway, Vancouver, BC V5T 3H7',
      municipality_id: 'aaaa0000-0000-4000-8000-000000000002',
      neighbourhood: 'Mount Pleasant',
      display_area: 'Vancouver — East',
      accessibility_notes: 'Please contact Amelia Novak at amelia@example.org.',
      official_url: 'https://ops:pw@example.org/x',
      created_at: '2026-08-18 14:15:53.71545+00',
      updated_at: '2026-08-18 14:15:53.71545+00',
      geo: '0101000020E6100000DF4F8D976EC65EC09A99999999A14840',
      phone: '(604) 555-0123',
      geo_authority: '1',
      geo_source: 'municipal_open_data',
      geo_attribution: 'City of X, Open Government Licence',
      geo_set_at: '2026-05-02 11:00:00+00',
    });

    // PRESERVED FAITHFULLY — the whole point of the exercise.
    expect(row.created_at).toBe('2026-08-18 14:15:53.71545+00');
    expect(row.geo).toBe('0101000020E6100000DF4F8D976EC65EC09A99999999A14840');
    expect(row.municipality_id).toBe('aaaa0000-0000-4000-8000-000000000002');
    expect(row.address).toBe('1 Kingsway, Vancouver, BC V5T 3H7'); // postal code intact

    // Scrubbed.
    expect(row.accessibility_notes).not.toContain('Amelia');
    expect(row.accessibility_notes).not.toContain('amelia@example.org');
    expect(row.official_url).toBe(`https://${REDACTION.credentials}@example.org/x`);
    expect(row.phone).toBe('(604) 555-0100');
    expect(hits.placeholder).toBe(1);
  });

  it('keeps NULL as NULL under every action — nullness is shape', () => {
    const { row } = transformRow(venue!, {
      id: 'cccc0000-0000-4000-8000-000000000004',
      name: 'Pop-Up Tent',
      address: null,
      municipality_id: null,
      neighbourhood: null,
      display_area: null,
      accessibility_notes: null,
      official_url: null,
      created_at: '2026-08-18 14:15:53.71545+00',
      updated_at: '2026-08-18 14:15:53.71545+00',
      geo: null,
      phone: null,
      geo_authority: null,
      geo_source: null,
      geo_attribution: null,
      geo_set_at: null,
    });
    expect(row.phone).toBeNull();
    expect(row.accessibility_notes).toBeNull();
    expect(row.official_url).toBeNull();
  });

  it('REFUSES an unclassified column rather than passing it through', () => {
    expect(() =>
      transformRow(venue!, { id: 'x', name: 'y', newly_added_pii_column: 'a.person@example.org' })
    ).toThrow(/no policy entry/);
  });

  it('omits derived_drop columns from the exported row and from the SELECT list', () => {
    const occ = tablePolicy('activity_occurrence');
    expect(occ).toBeTruthy();
    expect(Object.keys(occ!.columns)).toContain('search_tsv');
    expect(selectListSql(occ!)).not.toContain('search_tsv');
  });
});
