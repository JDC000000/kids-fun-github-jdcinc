// tests/email/render.test.ts — digest HTML/text rendering + escaping.
import { describe, expect, it } from 'vitest';
import { renderWeeklyDigest } from '@/lib/email/render';
import type { WeeklyDigest } from '@/lib/email/digest';

function digest(overrides: Partial<WeeklyDigest> = {}): WeeklyDigest {
  return {
    userId: 'u-1',
    totalActivities: 2,
    shouldSend: true,
    emptySearches: [],
    sections: [
      {
        savedSearchId: 'ss-1',
        label: 'Swim near me',
        searchUrl: 'https://app.example/search?q=swim',
        activities: [
          {
            id: 'a-1',
            seriesId: 's-1',
            name: 'Family Public Swim',
            venue: 'Hillcrest Pool',
            when: 'Sat, Jul 18, 10:00 a.m.',
            cost: 'Free',
            url: 'https://app.example/preview/a-1',
          },
          {
            id: 'a-2',
            seriesId: 's-2',
            name: 'Leisure Swim',
            venue: 'Harry Jerome',
            when: 'Sun, Jul 19, 1:00 p.m.',
            cost: '$3',
            url: 'https://app.example/preview/a-2',
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('renderWeeklyDigest', () => {
  it('subject reflects the activity count and pluralizes', () => {
    expect(renderWeeklyDigest(digest(), { unsubscribeUrl: 'https://app.example/u' }).subject).toBe(
      '2 new activities for your saved searches'
    );
    const one = digest({ totalActivities: 1 });
    expect(renderWeeklyDigest(one, { unsubscribeUrl: 'https://app.example/u' }).subject).toBe(
      '1 new activity for your saved searches'
    );
  });

  it('renders activity names, venues, when/cost, the search label, and the unsubscribe link', () => {
    const { html, text } = renderWeeklyDigest(digest(), { unsubscribeUrl: 'https://app.example/unsub?t=1' });
    for (const needle of ['Family Public Swim', 'Hillcrest Pool', 'Sat, Jul 18, 10:00 a.m.', 'Free', 'Swim near me']) {
      expect(html).toContain(needle);
      expect(text).toContain(needle);
    }
    expect(html).toContain('href="https://app.example/preview/a-1"');
    expect(html).toContain('https://app.example/unsub?t=1');
    expect(text).toContain('Unsubscribe: https://app.example/unsub?t=1');
  });

  it('HTML-escapes dynamic text so a source-provided name cannot inject markup', () => {
    const evil = digest();
    evil.sections[0].activities[0].name = '<script>alert(1)</script> & "friends"';
    const { html } = renderWeeklyDigest(evil, { unsubscribeUrl: '#' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;friends&quot;');
  });

  it('includes a hidden preheader for the inbox preview line', () => {
    const { html } = renderWeeklyDigest(digest(), { unsubscribeUrl: '#' });
    expect(html).toMatch(/display:none[^>]*>[^<]*2 new kid-friendly activities/);
  });

  // ── Empty saved searches ────────────────────────────────────────────────────────
  // One short factual line per saved search that matched nothing, naming the constraint
  // and linking to that search. Rendered only inside an email that is being sent anyway
  // (lib/email/weekly.ts returns before rendering when !shouldSend).
  const withEmpties = () =>
    digest({
      emptySearches: [
        {
          savedSearchId: 'ss-2',
          label: 'Weekend swim',
          searchUrl: 'https://app.example/search?q=swim&when=weekend',
          blockingConstraint: 'date',
          blockingLabel: 'date',
        },
      ],
    });

  it('names the blocking constraint and links the search, in HTML and text', () => {
    const { html, text } = renderWeeklyDigest(withEmpties(), { unsubscribeUrl: '#' });
    for (const out of [html, text]) {
      expect(out).toContain('Weekend swim');
      expect(out).toContain('No matches right now — removing the date would show results.');
      expect(out).toContain('https://app.example/search?q=swim&');
    }
    expect(html).toContain('Saved searches with no matches');
    expect(text).toContain('Saved searches with no matches:');
  });

  it('says nothing at all when no saved search is empty', () => {
    const { html, text } = renderWeeklyDigest(digest(), { unsubscribeUrl: '#' });
    expect(html).not.toContain('Saved searches with no matches');
    expect(text).not.toContain('Saved searches with no matches');
    expect(html).not.toContain('No matches right now');
    expect(text).not.toContain('No matches right now');
  });

  it('HTML-escapes an empty search label and URL too', () => {
    const evil = withEmpties();
    evil.emptySearches[0].label = '<img src=x onerror=1> & "co"';
    const { html } = renderWeeklyDigest(evil, { unsubscribeUrl: '#' });
    expect(html).not.toContain('<img src=x onerror=1>');
    expect(html).toContain('&lt;img src=x onerror=1&gt; &amp; &quot;co&quot;');
  });

  it('falls back to the honest wording when no single filter unlocks results', () => {
    const d = withEmpties();
    d.emptySearches[0].blockingConstraint = null;
    d.emptySearches[0].blockingLabel = null;
    const { html, text } = renderWeeklyDigest(d, { unsubscribeUrl: '#' });
    for (const out of [html, text]) {
      expect(out).toContain('No matches right now — relaxing any single filter still shows none.');
    }
  });
});
