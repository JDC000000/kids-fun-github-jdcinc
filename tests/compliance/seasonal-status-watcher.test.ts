// tests/compliance/seasonal-status-watcher.test.ts — PRODREC-3.
//
// WHY THIS FILE EXISTS AT ALL — the honest version.
//   All four worker/adapters/seasonal/*.ts files had NEVER been in any compliance scan,
//   from the day the family was built (G-T12-1) until now. Not deliberately exempted —
//   simply never added to no-bypass.test.ts's hand-kept ADAPTER_SOURCES list, with
//   nothing in the mechanism to notice. That is the exact structural gap PRODREC-3
//   closes: no-bypass.test.ts section (D) now discovers adapter families by enumerating
//   worker/adapters/*/ and FAILS LOUDLY for any family without coverage. This file is
//   seasonal's coverage, and it was written by actually reading what these four files
//   do — not by adding four names to a list and calling it covered.
//
// WHY A SEPARATE FILE RATHER THAN FOUR ENTRIES IN ADAPTER_SOURCES.
//   Three of the four files pass no-bypass's shared prohibitions unmodified. config.ts
//   does not, and the reason is worth stating precisely, because it is the opposite of
//   a violation. Each seasonal source carries a `compliance.robotsSummary` — a recorded
//   robots.txt verification. Grouse Mountain's quotes that site's own Disallow list
//   verbatim:
//
//     'grousemountain.com robots.txt: User-agent:* Disallow /api*,/content*,/checkout*,
//      /cart*,/account*,/orders*,/ecom*,/user_*,/login,/logout; …'
//
//   That is a STRING LITERAL, so it survives stripComments(), and it contains the
//   substrings `/checkout*` and `/cart*`. The shared scan's `checkout/cart flow`
//   fingerprint therefore fires on a compliance record whose entire purpose is to
//   document that we stay OUT of checkout and cart. The record is evidence FOR the
//   guarantee, and the shared scan would read it as evidence against.
//
//   Two ways to "fix" that were rejected as dishonest, and are named here so nobody
//   re-proposes them as a simplification:
//     ✗ Reword the robotsSummary so the regex stops matching. That degrades a real
//       compliance record — deleting what a site actually disallows — to satisfy a
//       pattern. The record would become less true.
//     ✗ Make the shared scan skip string literals globally. That weakens the scan for
//       EVERY family already covered: a real `fetch(base + '/checkout')` is a string
//       literal too. Never trade someone else's coverage for this family's convenience.
//
//   So it is handled the way T7/T8's POST narrowing (D-11) and Eventbrite's bearer-token
//   narrowing (G-T10-2) were — named, scoped, positionally proven, never silently
//   omitted. Structure mirrors both: (A) behavioural, (B) structural, (C) self-check.
//
// WHAT THIS FAMILY ACTUALLY IS (established by reading it, not assuming).
//   A status WATCHER, not an ingester. It reads an attraction's public status page for
//   season/closure/weather signals and maps them to `season_state`. It fetches at most
//   ONE page per source, GET only, through the same politeFetch seam as everyone else,
//   and only when BOTH the DB terms/robots gate AND `KIDS_FUN_LIVE_SEASONAL` permit it.
//   Of four configured sources exactly ONE (cypress-mountain) has a reviewed live URL;
//   the other three are fixture-only and cannot fetch at all, env var or not.
//
// SCOPE NOTE (PRODREC-3 / F-4 concurrency): this file only ever READS the seasonal
// sources. It makes no edit to worker/adapters/seasonal/index.ts, which stream F-4 owns
// concurrently for an unrelated SELECT-column guard. Read-only coverage is disjoint from
// F-4's edit by construction.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SeasonalWatcher,
  loadSeasonalWatchers,
  classifyStatusText,
} from '../../worker/adapters/seasonal';
import {
  SEASONAL_SOURCES,
  SEASONAL_LIVE_ENV_KEY,
  getSeasonalSource,
} from '../../worker/adapters/seasonal/config';
import { clearPolicyState } from '../../worker/health/policy';

/** Every file in the family. Section (D) of no-bypass.test.ts asserts this suite names
 *  each one — registration alone does not launder coverage. */
const SEASONAL_SOURCE_FILES = [
  'worker/adapters/seasonal/config.ts',
  'worker/adapters/seasonal/index.ts',
  'worker/adapters/seasonal/manual.ts',
  'worker/adapters/seasonal/map.ts',
];

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
  clearPolicyState();
});

interface CapturedCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: unknown; credentials?: string };
}

function headerLookup(init: CapturedCall['init'], name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function mockFetchCapture(body: string): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown, init?: unknown) => {
    calls.push({ url: String(input), init: init as CapturedCall['init'] });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch);
  return calls;
}

/** The same bar no-bypass holds every other family's live request to. */
function expectCredentialFreeGet(call: CapturedCall): void {
  const method = (call.init?.method ?? 'GET').toString().toUpperCase();
  expect(method, 'read-only GET only — never POST/login/checkout').toBe('GET');
  expect(call.init?.body ?? null, 'no body (no form/credential submission)').toBeNull();
  expect(headerLookup(call.init, 'authorization'), 'no Authorization header').toBeUndefined();
  expect(headerLookup(call.init, 'cookie'), 'no Cookie header (no session replay)').toBeUndefined();
  expect(call.init?.credentials, "no credentials:'include'").not.toBe('include');

  for (const name of Object.keys((call.init?.headers ?? {}) as Record<string, string>)) {
    expect(name, 'no anti-forgery/CSRF header').not.toMatch(/csrf|__requestverificationtoken/i);
  }

  const ua = headerLookup(call.init, 'user-agent');
  expect(ua, 'request carries an identified User-Agent').toBeTruthy();
  expect(ua).toMatch(/KidsFunBot/i);
  expect(ua, 'identified bot UA, not a browser spoof').not.toMatch(/Mozilla/i);
  expect(call.url).not.toMatch(/login|signin|account|checkout|cart/i);
}

// ── (A) behavioural ──────────────────────────────────────────────────────────

describe('PRODREC-3 (A) seasonal live reads are credential-free, GET-only, one page', () => {
  it('cypress-mountain — a single credential-free GET to its reviewed status URL', async () => {
    process.env[SEASONAL_LIVE_ENV_KEY] = 'cypress-mountain';
    const watcher = new SeasonalWatcher(getSeasonalSource('cypress-mountain')!);
    expect(watcher.isLiveFetchEnabled(), 'live when gated on').toBe(true);

    const calls = mockFetchCapture('<html><body>The mountain is open daily.</body></html>');
    const { live } = await watcher.fetch();

    expect(live, 'reports itself as a live read').toBe(true);
    expect(calls.length, 'a status watch is ONE page, never a crawl').toBe(1);
    expectCredentialFreeGet(calls[0]);
    // Pinned to the exact reviewed URL. A repoint onto any other path fails here.
    expect(calls[0].url).toBe('https://www.cypressmountain.com/mountain-report');
  });

  it('the live read is STATELESS — two fetches are identical, no session accumulates', async () => {
    process.env[SEASONAL_LIVE_ENV_KEY] = 'cypress-mountain';
    const watcher = new SeasonalWatcher(getSeasonalSource('cypress-mountain')!);
    const calls = mockFetchCapture('<html><body>open</body></html>');

    await watcher.fetch();
    clearPolicyState();
    await watcher.fetch();

    expect(calls.length).toBe(2);
    for (const call of calls) expectCredentialFreeGet(call);
    expect(headerLookup(calls[1].init, 'cookie'), 'no cookie carried forward').toBeUndefined();
    expect(calls[0].url).toBe(calls[1].url);
  });
});

describe('PRODREC-3 (A) seasonal sources NOT explicitly enabled make ZERO network calls', () => {
  it('no env allow-list at all — every source is fixture-only and silent', async () => {
    delete process.env[SEASONAL_LIVE_ENV_KEY];
    const spy = vi.spyOn(globalThis, 'fetch');

    for (const watcher of loadSeasonalWatchers()) {
      expect(watcher.isLiveFetchEnabled(), 'off with no env var').toBe(false);
      const { text, live } = await watcher.fetch();
      expect(live).toBe(false);
      expect(text.length, 'still yields fixture text').toBeGreaterThan(0);
    }
    expect(spy, 'the whole family made no network request').not.toHaveBeenCalled();
  });

  it('a source not NAMED in the allow-list stays fixture-only', async () => {
    process.env[SEASONAL_LIVE_ENV_KEY] = 'cypress-mountain';
    const spy = vi.spyOn(globalThis, 'fetch');
    const watcher = new SeasonalWatcher(getSeasonalSource('stanley-park-train')!);
    expect(watcher.isLiveFetchEnabled()).toBe(false);
    await watcher.fetch();
    expect(spy).not.toHaveBeenCalled();
  });

  it('fixture-only sources can NEVER fetch — naming them in the env var is not enough', async () => {
    // The property that matters most here. grouse-mountain is fixture-only precisely
    // because its conditions URL was never confirmed and its booking paths are
    // robots-disallowed; stanley-park-train and burnaby-central-railway likewise have no
    // reviewed live URL. An operator setting KIDS_FUN_LIVE_SEASONAL=all-of-them must not
    // be able to turn that into a fetch.
    process.env[SEASONAL_LIVE_ENV_KEY] = SEASONAL_SOURCES.map((s) => s.key).join(',');
    const spy = vi.spyOn(globalThis, 'fetch');

    const fixtureOnly = SEASONAL_SOURCES.filter((s) => s.compliance.livePosture === 'fixture-only');
    expect(fixtureOnly.length, 'the family really does have fixture-only sources').toBeGreaterThan(0);

    for (const source of fixtureOnly) {
      const watcher = new SeasonalWatcher(source);
      expect(
        watcher.isLiveFetchEnabled(),
        `${source.key} is fixture-only — the env var must not override that`
      ).toBe(false);
      await watcher.fetch();
    }
    expect(spy, 'no fixture-only source touched the network').not.toHaveBeenCalled();
  });

  it('a fixture-only posture and a missing live URL are BOTH independently sufficient', () => {
    // Two locks, asserted separately so removing either one fails rather than being
    // masked by the other still holding.
    process.env[SEASONAL_LIVE_ENV_KEY] = 'grouse-mountain';
    const grouse = getSeasonalSource('grouse-mountain')!;
    expect(grouse.compliance.livePosture).toBe('fixture-only');
    expect(grouse.liveStatusUrl, 'no live URL wired').toBeUndefined();
    expect(new SeasonalWatcher(grouse).isLiveFetchEnabled()).toBe(false);

    // Synthetic: posture cleared but URL still absent → still off.
    expect(
      new SeasonalWatcher({ ...grouse, compliance: { ...grouse.compliance, livePosture: 'live-capable-gated' } })
        .isLiveFetchEnabled(),
      'a live posture without a reviewed URL must not fetch'
    ).toBe(false);

    // Synthetic: URL present but posture fixture-only → still off.
    expect(
      new SeasonalWatcher({ ...grouse, liveStatusUrl: 'https://www.grousemountain.com/' }).isLiveFetchEnabled(),
      'a URL without a live posture must not fetch'
    ).toBe(false);
  });

  it('every configured live URL is a status page, never a booking/checkout/login path', () => {
    for (const source of SEASONAL_SOURCES) {
      for (const url of [source.liveStatusUrl, source.statusPageUrl]) {
        if (!url) continue;
        expect(url, `${source.key} URL must be https`).toMatch(/^https:\/\//);
        expect(url, `${source.key} URL must not be a transactional path`).not.toMatch(
          /login|signin|account|checkout|cart|orders|ecom|\/api\b/i
        );
      }
    }
  });

  it('classification is pure — reading status text makes no network call', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(classifyStatusText('The train is closed for the season.').signal).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── (B) structural ───────────────────────────────────────────────────────────

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface Pattern {
  label: string;
  re: RegExp;
}

/**
 * EVERY prohibition from no-bypass.test.ts, re-declared verbatim so this family's
 * coverage is COMPLETE rather than reduced. The one narrowing is handled separately
 * below — it is not removed from this list, it is proven positionally.
 */
const BYPASS_PATTERNS: Pattern[] = [
  { label: 'CAPTCHA handling', re: /captcha/i },
  { label: 'password credential', re: /\bpassword\b/i },
  { label: 'Authorization header', re: /authorization\s*:/i },
  { label: 'Cookie/session header', re: /["']?cookie["']?\s*:/i },
  { label: "credentials:'include'", re: /credentials\s*:\s*['"]?include/i },
  {
    label: 'headless-browser navigation',
    re: /\bpage\.(goto|type|click|fill|waitForSelector|evaluate|setContent)\b/i,
  },
  { label: 'headless-browser library', re: /\b(puppeteer|playwright)\b/i },
  { label: 'anti-forgery token submit', re: /(__requestverificationtoken|x-csrf-token|csrf[_-]?token)/i },
  { label: 'mutating HTTP method (PUT/PATCH/DELETE)', re: /method\s*:\s*['"](put|patch|delete)['"]/i },
  { label: 'POST method', re: /method\s*:\s*['"]post['"]/i },
];

/** The one narrowed prohibition, kept visible on its own. */
const CHECKOUT_PATTERN: Pattern = {
  label: 'checkout/cart flow',
  re: /\b(checkout|add[_-]?to[_-]?cart)\b/i,
};

/**
 * Strip ONLY the recorded-compliance string fields — `robotsSummary` and `termsNote` —
 * and nothing else. This is the narrowing, and its narrowness is the whole point: it
 * removes two named fields of a documented interface, not "strings" in general. A
 * `fetch(base + '/checkout')` anywhere in this family is untouched by it and still fires.
 */
function stripComplianceRecordStrings(code: string): string {
  return code.replace(/\b(robotsSummary|termsNote)\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, '$1: ""');
}

function scanSeasonal(rawSource: string): string[] {
  const code = stripComments(rawSource);
  const violations = BYPASS_PATTERNS.filter(({ re }) => re.test(code)).map(({ label }) => label);
  if (CHECKOUT_PATTERN.re.test(stripComplianceRecordStrings(code))) {
    violations.push(CHECKOUT_PATTERN.label);
  }
  return violations;
}

describe('PRODREC-3 (B) seasonal source contains no login/paywall/CAPTCHA-bypass code', () => {
  for (const rel of SEASONAL_SOURCE_FILES) {
    it(`${rel} is free of bypass fingerprints`, () => {
      const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
      const violations = scanSeasonal(src);
      expect(violations, `${rel} must not contain: ${violations.join(', ')}`).toEqual([]);
    });
  }

  it('the family covers every file that actually exists on disk', () => {
    // Local completeness guard, mirroring no-bypass (D) from this side: a new seasonal
    // file must be added here, not silently inherit the family's registration.
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const onDisk = readdirSync(resolve(process.cwd(), 'worker/adapters/seasonal'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `worker/adapters/seasonal/${f}`)
      .sort();
    expect(onDisk).toEqual([...SEASONAL_SOURCE_FILES].sort());
  });

  it('no seasonal file contains a checkout/cart path OUTSIDE a compliance record', () => {
    // The narrowing, proven from the other direction: after removing only the two
    // recorded-compliance fields, the fingerprint must find nothing anywhere.
    for (const rel of SEASONAL_SOURCE_FILES) {
      const code = stripComplianceRecordStrings(stripComments(readFileSync(resolve(process.cwd(), rel), 'utf8')));
      expect(CHECKOUT_PATTERN.re.test(code), `${rel} must not reference checkout/cart in code`).toBe(false);
    }
  });

  it('the narrowing is needed by exactly ONE file, for exactly the documented reason', () => {
    // Pins WHY the exemption exists. If config.ts's robots records ever stop being the
    // sole reason, this fails and the justification gets re-examined rather than
    // inherited. Also fails if someone widens the exemption to a file that never needed it.
    const needsNarrowing = SEASONAL_SOURCE_FILES.filter((rel) =>
      CHECKOUT_PATTERN.re.test(stripComments(readFileSync(resolve(process.cwd(), rel), 'utf8')))
    );
    expect(needsNarrowing).toEqual(['worker/adapters/seasonal/config.ts']);

    const config = readFileSync(resolve(process.cwd(), 'worker/adapters/seasonal/config.ts'), 'utf8');
    const records = [...config.matchAll(/\brobotsSummary\s*:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
    expect(records.length, 'robots records are present and readable').toBeGreaterThan(0);
    // Every checkout/cart mention in code must sit inside one of those records, and each
    // must read as a robots.txt Disallow — i.e. a path we are staying OUT of.
    const offending = records.filter((r) => CHECKOUT_PATTERN.re.test(r));
    expect(offending.length, 'the matches really are inside robots records').toBeGreaterThan(0);
    for (const record of offending) {
      expect(record, 'the record documents a Disallow, not a path we use').toMatch(/disallow/i);
    }
  });

  it('every source declares a real, dated robots/terms compliance record', () => {
    // Family-specific: this adapter's whole safety story is "we only read pages published
    // to be read". That claim is only as good as the per-source record behind it.
    for (const source of SEASONAL_SOURCES) {
      expect(source.compliance.checkedIso, `${source.key} records a check date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(source.compliance.robotsSummary.length, `${source.key} records a robots summary`).toBeGreaterThan(20);
      expect(['fixture-only', 'live-capable-gated']).toContain(source.compliance.livePosture);
    }
  });

  it('the watcher is OFF by default, like every other live-capable adapter', () => {
    delete process.env[SEASONAL_LIVE_ENV_KEY];
    for (const watcher of loadSeasonalWatchers()) {
      expect(watcher.isLiveFetchEnabled(), 'off with no KIDS_FUN_LIVE_SEASONAL set').toBe(false);
    }
  });

  it('only ONE source is live-capable at all — the reviewed surface stays small', () => {
    // Drift guard: promoting a source to live-capable must be a visible, deliberate edit
    // that fails here first and gets its robots record re-checked.
    const liveCapable = SEASONAL_SOURCES.filter(
      (s) => s.compliance.livePosture === 'live-capable-gated' && s.liveStatusUrl
    ).map((s) => s.key);
    expect(liveCapable).toEqual(['cypress-mountain']);
  });
});

// ── (C) the tripwire tests itself ────────────────────────────────────────────

describe('PRODREC-3 (C) tripwire self-check: every prohibition actually bites', () => {
  const SNIPPETS: Array<[string, string, string]> = [
    ['Cookie header', "await fetch(u, { headers: { cookie: jar } });", 'Cookie/session header'],
    ['Authorization header', "await fetch(u, { headers: { authorization: 'Bearer x' } });", 'Authorization header'],
    ['credentials include', "await fetch(u, { credentials: 'include' });", "credentials:'include'"],
    ['anti-forgery token', "body.append('__RequestVerificationToken', t);", 'anti-forgery token submit'],
    ['csrf header', "headers['x-csrf-token'] = token;", 'anti-forgery token submit'],
    ['headless import', "import puppeteer from 'puppeteer';", 'headless-browser library'],
    ['headless navigation', 'await page.goto(url);', 'headless-browser navigation'],
    ['CAPTCHA handling', 'const solved = solveCaptcha(challenge);', 'CAPTCHA handling'],
    ['password credential', "const password = process.env.PORTAL_PASSWORD;", 'password credential'],
    ['POST', "await fetch(u, { method: 'POST' });", 'POST method'],
    ['PUT', "await fetch(u, { method: 'PUT' });", 'mutating HTTP method (PUT/PATCH/DELETE)'],
    ['DELETE', "await fetch(u, { method: 'delete' });", 'mutating HTTP method (PUT/PATCH/DELETE)'],
    ['checkout flow', "await fetch(base + '/checkout');", 'checkout/cart flow'],
    ['add to cart', "await fetch(base + '/add_to_cart');", 'checkout/cart flow'],
  ];

  for (const [name, snippet, expectedLabel] of SNIPPETS) {
    it(`${name} is caught`, () => {
      expect(scanSeasonal(snippet)).toContain(expectedLabel);
    });
  }

  it('a comment claiming compliance cannot mask real bypass code', () => {
    const src = "// no cookie, no login, no CAPTCHA here\nawait fetch(u, { headers: { cookie: jar } });";
    expect(scanSeasonal(src)).toContain('Cookie/session header');
  });

  it('THE NARROWING IS NARROW: a real checkout fetch is NOT excused by a robots record', () => {
    // The mutation that matters. A file carrying a legitimate robots record AND a real
    // checkout call must still fail — otherwise the exemption is a loophole that any
    // adapter could open just by adding a robotsSummary field.
    const src = [
      "const compliance = { robotsSummary: 'example.com robots.txt: Disallow /checkout*,/cart*' };",
      "await fetch(base + '/checkout', {});",
    ].join('\n');
    expect(scanSeasonal(src)).toContain('checkout/cart flow');
  });

  it('the narrowing does not silently swallow OTHER prohibitions in the same field', () => {
    // Stripping the record fields must not become a general-purpose blind spot: a
    // password or cookie hidden inside robotsSummary is still caught, because only the
    // checkout pattern is evaluated against the stripped text.
    const src = "const c = { robotsSummary: 'password: hunter2', termsNote: 'authorization: Bearer x' };";
    const found = scanSeasonal(src);
    expect(found).toContain('password credential');
    expect(found).toContain('Authorization header');
  });

  it('the narrowing applies ONLY to the two named fields, not to any string', () => {
    // A neighbouring field with the same content is NOT excused.
    expect(scanSeasonal("const c = { note: 'Disallow /checkout*' };")).toContain('checkout/cart flow');
    expect(scanSeasonal("const c = { robotsSummary: 'Disallow /checkout*' };")).toEqual([]);
  });

  it('clean adapter code produces no findings (the scan is not stuck-on-fail)', () => {
    expect(scanSeasonal("const res = await politeFetch(k, new URL(u), { headers: { accept: 'text/html' } });")).toEqual([]);
  });
});
