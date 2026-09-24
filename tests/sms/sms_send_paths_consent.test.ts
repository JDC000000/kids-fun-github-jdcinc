// tests/sms/sms_send_paths_consent.test.ts — every outbound SMS path, and the consent rule it is under.
//
// ═══ WHY THIS EXISTS (CASL fix, 2026-09-24) ═══
// The Instant Picks send texted never-confirmed subscribers because it borrowed a status rule
// written for something else (the on-page list) and nothing forced anyone to ask "what consent
// does this SEND require?". The fix gates that one path; this file is what stops the NEXT send
// path from repeating the mistake. It enumerates every module that can reach Twilio and fails if
// one appears that has not been classified below — so adding a send path means deciding, in
// review, which consent rule it is under.
//
// THE CLASSIFICATION (the boundary the fix draws):
//   • CONTENT — picks, "show me more", anything beyond the consent handshake. Only a subscriber
//     whose double opt-in is COMPLETE and not paused/withdrawn may receive one.
//   • CONSENT FLOW — the one confirmation request to a pending number, and the welcome that
//     acknowledges the JOIN reply. These are the handshake itself and MUST keep reaching pending /
//     just-confirmed rows; blocking them would make confirmation impossible.
//   • SEPARATE CONSENT SCOPE — the area waitlist's one promised notification, recorded in its own
//     table with its own consent (migration 0038) and held behind its own switch.
// STOP / START / HELP / unknown-keyword replies ride on the inbound webhook's TwiML response, not
// on `dispatchSms`, and are pinned by tests/sms/inbound_*.test.ts.
//
// ═══ P6 HARDENING (2026-09-24) — WHAT "CAN REACH TWILIO" NOW MEANS ═══
// QA of a5a863a planted six unclassified senders; the original enumeration (a regex requiring an
// import from a few path shapes AND the name `dispatchSms`, over lib/app/worker/scripts only)
// caught one. It now PARSES every source file (the TypeScript compiler API, already a
// devDependency) and flags ANY reference to the seam — static import, `import type`,
// `export … from`, dynamic `import()`, `require()`, or a bare string literal naming it — under
// EVERY directory except node_modules, tests, build output and colocated *.test / *.spec files.
// Comments are not syntax nodes, so prose that mentions the seam cannot trip it. Four more
// guards close the routes around it:
//   • nobody but the seam may RE-EXPORT it (weekly-send-io used to, which laundered it);
//   • no non-test file may import a test file (the excluded files cannot become a back door);
//   • every exported SEND ENTRY POINT of a classified module has a caller allow-list (probe P6:
//     a new route handing a classified send its own row);
//   • the detector itself is tested against every planted probe, in memory, below.
// STILL NOT A GUARANTEE: a specifier assembled at runtime ('twilio-' + 'client'), `eval`, or a
// Twilio host built from pieces would pass. This is a tripwire for honest mistakes; review is the
// rest.
//
// Reads source only — no database, so it stays in the `unit` lane.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SEAM = 'lib/sms/twilio-client.ts';

/** Directories that are not shipped source. `tests` and `node_modules` are the Operator's
 *  exclusions; the rest are build / VCS output, all git-ignored. Matched at ANY depth. */
const SKIP_DIRS = new Set([
  'node_modules', 'tests', '.git', '.next', 'dist', 'out', 'coverage', '.vercel', '.supabase',
  'playwright-report', 'test-results',
]);
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
/** Colocated test files (app/**\/x.test.tsx exist) — excluded like tests/, per the Operator. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** A module specifier that points at test code: a tests/ or __tests__/ dir, or a *.test / *.spec file. */
const TEST_SPECIFIER = /(^|\/)(tests|__tests__)(\/|$)|\.(test|spec)(\.[cm]?[jt]sx?)?$/;
/** The seam, by its LAST path segment, whatever the prefix ('./', '../', '@/lib/sms/', …). */
const SEAM_SPECIFIER = /(^|\/)twilio-client(\.[cm]?[jt]sx?)?$/;
const SDK_SPECIFIER = /^twilio(\/|$)/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...sourceFiles(full));
    } else if (CODE_FILE.test(name) && !TEST_FILE.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function parse(rel: string, src: string): ts.SourceFile {
  const kind = rel.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx?$/.test(rel)
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  return ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, kind);
}

function literalText(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

/** Every module specifier in a file, however it is written, with what kind of reference it is. */
function moduleSpecifiers(sf: ts.SourceFile): Array<{ spec: string; kind: string }> {
  const out: Array<{ spec: string; kind: string }> = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      const spec = literalText(n.moduleSpecifier);
      if (spec !== null) {
        out.push({
          spec,
          kind: ts.isExportDeclaration(n) ? 're-export' : n.importClause?.isTypeOnly ? 'import-type' : 'import',
        });
      }
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const spec = literalText(n.moduleReference.expression);
      if (spec !== null) out.push({ spec, kind: 'import-equals' });
    } else if (ts.isCallExpression(n)) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      const spec = isImport || isRequire ? literalText(n.arguments[0]) : null;
      if (spec !== null) out.push({ spec, kind: isImport ? 'dynamic-import' : 'require' });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every string a file spells out: literals, and the static text of template expressions. */
function stringsIn(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text + n.templateSpans.map((span) => span.literal.text).join(''));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Why this file can reach Twilio — empty when it cannot. A pure function of (path, source), so
 * the self-tests below can feed it planted probes as ordinary strings.
 */
function twilioReach(rel: string, src: string): string[] {
  if (rel === SEAM) return [];
  const sf = parse(rel, src);
  const reasons = new Set<string>();
  for (const { spec, kind } of moduleSpecifiers(sf)) {
    if (SEAM_SPECIFIER.test(spec)) reasons.add(`seam:${kind}`);
    if (SDK_SPECIFIER.test(spec)) reasons.add(`twilio-sdk:${kind}`);
  }
  for (const text of stringsIn(sf)) {
    // The backstop: `const p = './twilio-client'; await import(p)` has no specifier to see.
    if (SEAM_SPECIFIER.test(text)) reasons.add('seam:string');
    if (/api\.twilio\.com/.test(text)) reasons.add('twilio-rest-host');
  }
  return [...reasons].sort();
}

let scanCache: Array<{ rel: string; src: string }> | undefined;
/** The repo's shipped source, read once per run (~500 files) and shared by every test below. */
function scanned(): Array<{ rel: string; src: string }> {
  scanCache ??= sourceFiles(ROOT).map((file) => ({
    rel: relative(ROOT, file).split(sep).join('/'),
    src: readFileSync(file, 'utf8'),
  }));
  return scanCache;
}

/** Every module that can reach Twilio. */
function modulesThatCanSend(files = scanned()): string[] {
  return files.filter(({ rel, src }) => twilioReach(rel, src).length > 0).map(({ rel }) => rel).sort();
}

const CLASSIFIED: Record<string, 'content' | 'consent-flow' | 'separate-consent-scope'> = {
  'lib/sms/instant-picks-send.ts': 'content',
  'lib/sms/weekly-send-io.ts': 'content',
  'lib/sms/signup-store.ts': 'consent-flow', // the one confirmation request (pending, by design)
  'lib/sms/welcome.ts': 'consent-flow', // acknowledges JOIN; route sends it only on `applied`
  'lib/sms/waitlist-notify.ts': 'separate-consent-scope',
};

/**
 * Every exported function of a classified module that can put a text on the wire, and the ONLY
 * files allowed to name it (its own module included). Probe P6 generalised: a classified send is
 * only as safe as the row its caller hands it, so a NEW caller is a review decision, not a
 * side-effect of an import. The weekly unit also re-checks consent itself; the others are either
 * consent-flow sends that must reach pending rows, or gated where they are.
 */
const SEND_ENTRY_POINTS: Record<string, readonly string[]> = {
  sendInstantPicksText: ['lib/sms/instant-picks-send.ts', 'app/api/sms/instant-picks/route.ts'],
  sendConfirmationRequest: ['lib/sms/signup-store.ts', 'app/api/sms/signup/route.ts'],
  sendWelcomeText: ['lib/sms/welcome.ts', 'app/api/sms/inbound/route.ts'],
  notifyWaitlistFor: ['lib/sms/waitlist-notify.ts'], // no caller yet — held behind its own switch
  sendWeeklySmsForSubscriber: ['lib/sms/weekly-send-io.ts', 'app/api/sms/weekly/run/route.ts'],
  sendWeeklySmsBulk: ['lib/sms/weekly-send-io.ts', 'app/api/sms/weekly/run/route.ts'],
};

/** Identifiers a file actually uses (comments excluded — they are not nodes). */
function identifiersIn(rel: string, src: string): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(parse(rel, src));
  return out;
}

/** Exported functions of a module whose body names the seam's sender or another entry point. */
function exportedSenders(rel: string, src: string): string[] {
  const senders = new Set(['dispatchSms', 'twilioClient', ...Object.keys(SEND_ENTRY_POINTS)]);
  const out: string[] = [];
  const bodyNames = (node: ts.Node) => {
    const names = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n)) names.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(node);
    return names;
  };
  const isExported = (n: ts.Node) =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const stmt of parse(rel, src).statements) {
    if (!isExported(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const own = stmt.name.text;
      if ([...bodyNames(stmt.body)].some((x) => x !== own && senders.has(x))) out.push(own);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;
        const own = decl.name.text;
        if ([...bodyNames(init.body)].some((x) => x !== own && senders.has(x))) out.push(own);
      }
    }
  }
  return out.sort();
}

describe('⛔ every outbound SMS path is classified under a consent rule', () => {
  it('no module can reach Twilio without appearing in the classification above', () => {
    // If this fails with a NEW file: decide which consent rule it is under, add it to CLASSIFIED,
    // and — if it sends CONTENT — make it prove confirmed, active consent before it dispatches.
    expect(modulesThatCanSend()).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it('the scan really covers every source directory, not just lib/app/worker/scripts', () => {
    // Guards the walk itself: if SKIP_DIRS ever swallowed a real directory, the equality above
    // would still pass — vacuously — for everything under it.
    const tops = new Set(scanned().map(({ rel }) => rel.split('/')[0]));
    for (const dir of ['lib', 'app', 'components', 'worker', 'scripts', 'evals', 'invariants']) {
      expect(tops, dir).toContain(dir);
    }
    expect([...tops].some((t) => t === 'tests' || t === 'node_modules')).toBe(false);
  });

  it('nobody re-exports the seam — importing a sender through another module is laundering', () => {
    const reexporters = scanned()
      .filter(({ rel, src }) => twilioReach(rel, src).includes('seam:re-export'))
      .map(({ rel }) => rel);
    expect(reexporters).toEqual([]);
  });

  it('no non-test file imports a test file — the excluded files cannot become a back door', () => {
    const offenders: string[] = [];
    for (const { rel, src } of scanned()) {
      for (const { spec } of moduleSpecifiers(parse(rel, src))) {
        if (TEST_SPECIFIER.test(spec)) offenders.push(`${rel} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('⛔ every classified send entry point has a caller allow-list (probe P6, generalised)', () => {
  it('each entry point is named only by the files allowed to call it', () => {
    const files = scanned();
    for (const [entry, allowed] of Object.entries(SEND_ENTRY_POINTS)) {
      const users = files.filter(({ rel, src }) => identifiersIn(rel, src).has(entry)).map(({ rel }) => rel);
      // A new caller: check it hands the send a row it has proved consent for, then add it here.
      expect(users.sort(), entry).toEqual([...allowed].sort());
    }
  });

  it('the entry-point list is complete: every exported sender of a classified module is on it', () => {
    // So a new `sendFooText` added to a classified module cannot skip the allow-list above.
    const found = Object.keys(CLASSIFIED).flatMap((rel) => exportedSenders(rel, read(rel)));
    expect(found.sort()).toEqual(Object.keys(SEND_ENTRY_POINTS).sort());
  });
});

describe('the detector catches every planted probe, and nothing innocent (in memory)', () => {
  // QA's six probes against a5a863a (P1–P6), plus the extra shapes found while scoping P6.
  const reaches: Array<[string, string, string]> = [
    ['P1 static import of dispatchSms', 'lib/sms/p1.ts', `import { dispatchSms } from './twilio-client';\nexport const f = dispatchSms;`],
    ['P2 twilioClient() used directly', 'lib/sms/p2.ts', `import { twilioClient } from './twilio-client';\nexport const f = () => twilioClient()?.messages.create({} as never);`],
    ['P3 nested ../twilio-client', 'lib/sms/sub/p3.ts', `import { dispatchSms } from '../twilio-client';\nexport const f = dispatchSms;`],
    ['P4 dynamic import()', 'lib/sms/p4.ts', `export const f = async () => (await import('./twilio-client')).dispatchSms;`],
    ['P5 sender in components/', 'components/P5.tsx', `import { dispatchSms } from '@/lib/sms/twilio-client';\nexport function P5() { void dispatchSms; return null; }`],
    ['require()', 'scripts/p8.cjs', `const { dispatchSms } = require('../lib/sms/twilio-client');\nmodule.exports = dispatchSms;`],
    ['template-literal import()', 'lib/sms/p9.ts', 'export const f = () => import(`./twilio-client`);'],
    ['specifier held in a variable', 'lib/sms/p11.ts', `const seam = './twilio-client';\nexport const f = () => import(seam);`],
    ['import type', 'lib/sms/p13.ts', `import type { DispatchResult } from './twilio-client';\nexport type X = DispatchResult;`],
    ['re-export (laundering)', 'lib/p7.ts', `export { twilioClient } from '@/lib/sms/twilio-client';`],
    ['export * (laundering)', 'lib/p7b.ts', `export * from './sms/twilio-client';`],
    ['Twilio SDK, dynamic', 'worker/src/p10.ts', `export const f = async () => (await import('twilio')).default;`],
    ['Twilio SDK, static', 'worker/src/p10b.ts', `import twilio from 'twilio';\nexport const f = twilio;`],
    ['Twilio REST host', 'worker/src/p12.ts', `export const f = () => fetch('https://api.twilio.com/2010-04-01/Accounts/x/Messages.json');`],
  ];
  for (const [label, rel, src] of reaches) {
    it(`catches: ${label}`, () => {
      expect(twilioReach(rel, src)).not.toEqual([]);
    });
  }

  it('P6 (a new route handing the weekly send its own row) is caught by the caller allow-list', () => {
    const src = `import { sendWeeklySmsForSubscriber } from '@/lib/sms/weekly-send-io';\nexport const f = sendWeeklySmsForSubscriber;`;
    const rel = 'app/api/p6/route.ts';
    expect(twilioReach(rel, src)).toEqual([]); // not a seam reference…
    expect(identifiersIn(rel, src).has('sendWeeklySmsForSubscriber')).toBe(true); // …but a caller
    expect(SEND_ENTRY_POINTS.sendWeeklySmsForSubscriber).not.toContain(rel);
  });

  it('flags re-exports distinctly, so the laundering ban can single them out', () => {
    expect(twilioReach('lib/x.ts', `export { dispatchSms } from './sms/twilio-client';`)).toContain('seam:re-export');
  });

  const innocent: Array<[string, string, string]> = [
    ['prose in comments', 'lib/sms/c.ts', `// See \`lib/sms/twilio-client.ts\`; import('./twilio-client')\n/* require('./twilio-client') */\nexport const x = 1;`],
    ['look-alike module names', 'lib/sms/d.ts', `import { a } from './twilio-client-config';\nimport { b } from './not-twilio-client';\nexport const x = [a, b];`],
    ['the seam itself', SEAM, `import twilio from 'twilio';\nexport const x = twilio;`],
  ];
  for (const [label, rel, src] of innocent) {
    it(`ignores: ${label}`, () => {
      expect(twilioReach(rel, src)).toEqual([]);
    });
  }

  it('the test-file import guard catches each shape of test specifier, and not fixtures', () => {
    for (const spec of ['../tests/helpers/db', '@/tests/sms/x', './foo.test', './foo.spec.ts', '../__tests__/x']) {
      expect(TEST_SPECIFIER.test(spec), spec).toBe(true);
    }
    for (const spec of ['@/lib/search/__fixtures__/regions', './testing-utils', './contest', './latest']) {
      expect(TEST_SPECIFIER.test(spec), spec).toBe(false);
    }
  });
});

describe('⛔ CONTENT paths gate on confirmed, active consent', () => {
  it('Instant Picks: the consent gate runs before the throttle, the render and the dispatch', () => {
    const src = read('lib/sms/instant-picks-send.ts');
    const body = src.slice(src.indexOf('export async function sendInstantPicksText'));
    const gate = body.indexOf('if (!hasConfirmedActiveConsent(subscriber)) return held;');
    expect(gate).toBeGreaterThan(-1);
    for (const later of [
      'options.checkThrottle ?? checkAndRecordInstantPicksSend',
      'renderInstantPicksMessage(',
      'options.dispatch ?? dispatchSms',
      'options.record ?? recordSmsSend',
    ]) {
      const at = body.indexOf(later);
      expect(at, later).toBeGreaterThan(gate);
    }
  });

  it('Instant Picks: the predicate requires BOTH active status and a recorded confirmation', () => {
    const src = read('lib/sms/instant-picks-send.ts');
    expect(src).toMatch(
      /return subscriber\.status === 'active' && subscriber\.confirmedTimestamp != null;/
    );
    // …and the loader actually reads the two columns it is judged on.
    expect(src).toMatch(/SELECT id, phone_number, preferences_token, consent_text_version,\s+status, confirmed_timestamp/);
  });

  it('Weekly: the subscriber load selects only active rows', () => {
    const src = read('lib/sms/weekly-send-io.ts');
    const fn = src.slice(src.indexOf('export async function loadActiveSubscribers'));
    const sql = fn.slice(0, fn.indexOf('`,') + 2);
    expect(sql).toMatch(/WHERE c\.status = 'active'/);
    // P6: `active` alone is reachable without a JOIN (pending → STOP → START).
    expect(sql).toMatch(/AND c\.confirmed_timestamp IS NOT NULL/);
  });

  it('Weekly: the per-subscriber send re-checks consent itself, before any read, build, send or write', () => {
    const src = read('lib/sms/weekly-send-io.ts');
    const body = src.slice(src.indexOf('export async function sendWeeklySmsForSubscriber'));
    const gate = body.indexOf('weeklySendConsentRefusal(await loadConsent(subscriber.id), phoneNumber)');
    const refuse = body.indexOf("status: 'refused_consent'");
    expect(gate).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(gate);
    for (const later of [
      'options.deps ?? (await loadWeeklySmsDeps())',
      'await loadRecent(subscriber.id)',
      'buildWeeklySms({',
      'await send(phoneNumber, message',
      'log({',
      'markStopped(subscriber.id)',
      'applyState(subscriber.id, state)',
    ]) {
      const at = body.indexOf(later);
      expect(at, later).toBeGreaterThan(refuse);
    }
  });

  it('Weekly: the rule requires active, a recorded confirmation, and the SAME number', () => {
    const src = read('lib/sms/weekly-send-io.ts');
    const fn = src.slice(src.indexOf('export function weeklySendConsentRefusal'));
    expect(fn).toMatch(/if \(row\.confirmedTimestamp == null\) return 'active_unconfirmed';/);
    expect(fn).toMatch(/if \(row\.phoneNumber !== phoneNumber\) return 'number_mismatch';/);
    expect(src).toMatch(/SELECT status, confirmed_timestamp, phone_number FROM sms_consent WHERE id = \$1/);
  });

  it('Weekly: the single-subscriber run route resolves its target from the ACTIVE set only', () => {
    const src = read('app/api/sms/weekly/run/route.ts');
    // The one path that sends to a named subscriber must pick them out of loadActiveSubscribers(),
    // never load a row by id on its own.
    expect(src).toMatch(/loadActiveSubscribers\(\)/);
    expect(src).not.toMatch(/FROM\s+sms_consent/);
  });
});

describe('CONSENT-FLOW paths are NOT blocked by the fix', () => {
  it('the confirmation request does not consult subscriber status — it IS the pending handshake', () => {
    const src = read('lib/sms/signup-store.ts');
    const fn = src.slice(src.indexOf('export async function sendConfirmationRequest'));
    expect(fn).not.toMatch(/hasConfirmedActiveConsent/);
  });

  it('the welcome is not gated on the content rule — it is sent on the JOIN transition itself', () => {
    expect(read('lib/sms/welcome.ts')).not.toMatch(/hasConfirmedActiveConsent/);
  });
});
