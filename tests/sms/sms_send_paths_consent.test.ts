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

/** Directories skipped WHEREVER they appear: dependencies and build / VCS output. Every one is
 *  git-ignored at any depth, so nothing under them can be committed without `-f`. */
const SKIP_ANY_DEPTH = new Set([
  'node_modules', '.git', '.next', 'dist', 'out', 'coverage', '.vercel', '.supabase',
  'playwright-report', 'test-results',
]);
/**
 * Skipped ONLY at the repo root. A NESTED `tests/` is not test code: `app/api/sms/tests/route.ts`
 * ships as the route `/api/sms/tests` (QA of 2d67293, F1 — it was skipped at any depth and the
 * scan passed while `next build` emitted it). Test files elsewhere are excluded by `TEST_FILE`.
 */
const SKIP_AT_ROOT = new Set(['tests']);

/** Whether the walk skips this directory (repo-relative, '/'-separated). */
function isSkippedDir(relDir: string): boolean {
  const parts = relDir.split('/');
  const name = parts[parts.length - 1];
  return SKIP_ANY_DEPTH.has(name) || (parts.length === 1 && SKIP_AT_ROOT.has(name));
}

/** Whether a repo-relative file path is inside the scan (no skipped ancestor, a code file, not a test). */
function wouldScan(relFile: string): boolean {
  const parts = relFile.split('/');
  const name = parts[parts.length - 1];
  for (let i = 1; i < parts.length; i++) {
    if (isSkippedDir(parts.slice(0, i).join('/'))) return false;
  }
  return CODE_FILE.test(name) && !TEST_FILE.test(name) && !name.endsWith('.d.ts');
}
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
/** Colocated test files (app/**\/x.test.tsx exist) — excluded like tests/, per the Operator. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** A module specifier that points at test code: a tests/ or __tests__/ dir, or a *.test / *.spec file. */
const TEST_SPECIFIER = /(^|\/)(tests|__tests__)(\/|$)|\.(test|spec)(\.[cm]?[jt]sx?)?$/;
/** The seam, by its LAST path segment, whatever the prefix ('./', '../', '@/lib/sms/', …). */
const SEAM_SPECIFIER = /(^|\/)twilio-client(\.[cm]?[jt]sx?)?$/;
const SDK_SPECIFIER = /^twilio(\/|$)/;

const toRel = (full: string) => relative(ROOT, full).split(sep).join('/');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!isSkippedDir(toRel(full))) out.push(...sourceFiles(full));
    } else if (wouldScan(toRel(full))) {
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
 * Whether the file loads a module by a COMPUTED specifier — `import(x)` / `require(x)` whose
 * argument is not a string literal. Such a file can reach anything its strings name, so it gets
 * the string backstops below for the SDK (QA F5, `const sdk = 'twilio'; import(sdk)`) and for test
 * files (QA F6). Kept conditional on purpose: a bare `'twilio'` or `'tests'` is ordinary data
 * elsewhere (`{ provider: 'twilio' }` must not force a classification).
 */
function hasComputedImport(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      if ((isImport || isRequire) && n.arguments[0] && !ts.isStringLiteralLike(n.arguments[0])) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * Twilio REST API hosts, regional edges included (`api.dublin.ie1.twilio.com`, QA F5) — any
 * `<label>.twilio.com` except the `www` marketing/docs site, which a docs link may name.
 */
function namesTwilioApiHost(text: string): boolean {
  for (const m of text.matchAll(/(?:[a-z0-9-]+\.)+twilio\.com\b/gi)) {
    if (m[0].toLowerCase() !== 'www.twilio.com') return true;
  }
  return false;
}

function isFunctionLike(n: ts.Node): boolean {
  return ts.isFunctionLike(n) || ts.isClassLike(n);
}

/**
 * Names referenced by an expression OUTSIDE any function body and outside type positions — i.e.
 * the values the expression hands over as-is. `export const x = dispatchSms` hands over the seam;
 * `export const x = () => dispatchSms(…)` is a new sender, which the completeness check owns.
 */
function valueNamesOutsideFunctions(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isTypeNode(n) || isFunctionLike(n)) return;
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
        (ts.isPropertyAssignment(parent) && parent.name === n);
      if (!isMemberName) out.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** Unwrap `await`, parentheses and `as`/`satisfies`/`!` to reach the call a binding came from. */
function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) ||
        ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/**
 * QA F2 — LAUNDERING WITHOUT `from`. Does this module hand a seam VALUE to its importers?
 *   `import { dispatchSms } from './twilio-client'; export { dispatchSms as x };`   (export clause)
 *   `export const x = dispatchSms;` / `const d = dispatchSms; export { d };`         (alias)
 *   `export default dispatchSms;`
 * Seam bindings are the value imports of the seam (static, `import =`, or destructured from
 * `require()` / `await import()`), closed over plain aliases to a fixpoint. Type-only imports
 * cannot send and are ignored.
 */
function launderedSeamExports(sf: ts.SourceFile): string[] {
  const tainted = seamBindings(sf);
  const laundered: string[] = [];
  const isExported = (n: ts.Node) =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && !stmt.isTypeOnly &&
        stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const local = (el.propertyName ?? el.name).text;
        if (!el.isTypeOnly && tainted.has(local)) laundered.push(el.name.text);
      }
    } else if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const names = new Set<string>();
        bindingNames(d.name, names);
        for (const x of names) if (tainted.has(x)) laundered.push(x);
      }
    } else if (ts.isExportAssignment(stmt)) {
      if ([...valueNamesOutsideFunctions(stmt.expression)].some((x) => tainted.has(x))) laundered.push('default');
    }
  }
  return laundered.sort();
}

/**
 * Every MODULE-SCOPE name bound to a seam value: the value imports of the seam (named — under any
 * local name —, default, namespace, `import =`, or destructured from `require()` / `await
 * import()`), closed over plain aliases (`const d = dispatchSms`) to a fixpoint. Shared by the
 * laundering ban (F2) and the completeness check (N2), so both see the seam under every name.
 */
function seamBindings(sf: ts.SourceFile): Set<string> {
  const tainted = new Set<string>();
  const isSeamCall = (e: ts.Expression) => {
    const c = unwrap(e);
    if (!ts.isCallExpression(c)) return false;
    const isImport = c.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(c.expression) && c.expression.text === 'require';
    const spec = isImport || isRequire ? literalText(c.arguments[0]) : null;
    return spec !== null && SEAM_SPECIFIER.test(spec);
  };
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && n.importClause && !n.importClause.isTypeOnly) {
      const spec = literalText(n.moduleSpecifier);
      if (spec !== null && SEAM_SPECIFIER.test(spec)) {
        const clause = n.importClause;
        if (clause.name) tainted.add(clause.name.text);
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) tainted.add(nb.name.text);
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) tainted.add(el.name.text);
      }
    } else if (ts.isImportEqualsDeclaration(n) && !n.isTypeOnly && ts.isExternalModuleReference(n.moduleReference)) {
      const spec = literalText(n.moduleReference.expression);
      if (spec !== null && SEAM_SPECIFIER.test(spec)) tainted.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // MODULE-SCOPE declarations only: an export clause can only name those, and a local inside a
  // function (`const send = options.dispatch ?? dispatchSms`) must not taint a same-named export.
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) declarations.push(...stmt.declarationList.declarations);
  }
  for (const d of declarations) {
    if (d.initializer && isSeamCall(d.initializer)) bindingNames(d.name, tainted);
  }
  // Aliases: `const d = dispatchSms`, `const o = { send: dispatchSms }` … to a fixpoint.
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of declarations) {
      if (!d.initializer) continue;
      const names = new Set<string>();
      bindingNames(d.name, names);
      if ([...names].every((x) => tainted.has(x))) continue;
      if ([...valueNamesOutsideFunctions(d.initializer)].some((x) => tainted.has(x))) {
        for (const x of names) tainted.add(x);
        changed = true;
      }
    }
  }
  return tainted;
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
  const computed = hasComputedImport(sf);
  for (const text of stringsIn(sf)) {
    // The backstop: `const p = './twilio-client'; await import(p)` has no specifier to see.
    if (SEAM_SPECIFIER.test(text)) reasons.add('seam:string');
    // Same backstop for the SDK, but only where something is loaded by a computed name (F5).
    if (computed && SDK_SPECIFIER.test(text)) reasons.add('twilio-sdk:string');
    if (namesTwilioApiHost(text)) reasons.add('twilio-rest-host');
  }
  // F2: an export clause or alias that hands the seam on counts as a re-export, too.
  if (launderedSeamExports(sf).length > 0) reasons.add('seam:re-export');
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

/**
 * Test code a shipped file loads: literal specifiers, plus — in a file that loads anything by a
 * computed name — any path-shaped string naming test code (QA F6, `const p = '../tests/…';
 * import(p)`).
 */
function testImports(rel: string, src: string): string[] {
  const sf = parse(rel, src);
  const out = moduleSpecifiers(sf).filter(({ spec }) => TEST_SPECIFIER.test(spec)).map(({ spec }) => `${rel} → ${spec}`);
  if (hasComputedImport(sf)) {
    for (const text of stringsIn(sf)) {
      if (/[/.]/.test(text) && TEST_SPECIFIER.test(text)) out.push(`${rel} → ${text} (string, computed import)`);
    }
  }
  return out;
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

/**
 * Names a file references: identifiers, AND string literals (QA F4 — `io['sendWeeklySmsBulk']`
 * reaches an entry point with no identifier). Comments are excluded — they are not nodes.
 */
function identifiersIn(rel: string, src: string): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) out.add(n.text);
    else if (ts.isStringLiteralLike(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(parse(rel, src));
  return out;
}

/**
 * The EXPORTED NAMES of a module's senders: top-level functions (declared, or `const` arrow /
 * function expressions, or an anonymous default export) whose body names the seam, another entry
 * point, or — to a fixpoint — another local sender, so a sender behind a private helper still
 * counts. Exported directly, through an export clause (`export { qaNudge }`, `export { f as g }` —
 * QA F3), or as `default`.
 *
 * "NAMES THE SEAM" MEANS UNDER ANY NAME (QA N2). The seed is not just the literal names
 * `dispatchSms` / `twilioClient`: it is every module-scope binding `seamBindings` resolves to the
 * seam — a renamed import (`dispatchSms as qaRenamed`), a module alias (`const d = dispatchSms`),
 * a namespace (`ns`, including `ns['dispatchSms']`). String literals count as names too, as for the
 * caller allow-list (F4).
 */
function exportedSenders(rel: string, src: string): string[] {
  const sf = parse(rel, src);
  const seed = new Set([
    'dispatchSms',
    'twilioClient',
    ...Object.keys(SEND_ENTRY_POINTS),
    ...seamBindings(sf),
  ]);
  const bodyNames = (node: ts.Node) => {
    const names = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) names.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(node);
    return names;
  };
  const hasModifier = (n: ts.Node, kind: ts.SyntaxKind) =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === kind);
  const isExported = (n: ts.Node) => hasModifier(n, ts.SyntaxKind.ExportKeyword);
  /** Key for an anonymous default export's body; cannot collide with an identifier. */
  const ANON_DEFAULT = '<anonymous default>';
  const bodies = new Map<string, Set<string>>();
  const exportedAs = new Map<string, string[]>();
  const exportAs = (local: string, exported: string) =>
    exportedAs.set(local, [...(exportedAs.get(local) ?? []), exported]);
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      // `export default async function (p) {…}` has no name (QA N2, R08).
      const local = stmt.name?.text ?? ANON_DEFAULT;
      bodies.set(local, bodyNames(stmt.body));
      if (isExported(stmt)) exportAs(local, hasModifier(stmt, ts.SyntaxKind.DefaultKeyword) ? 'default' : local);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;
        bodies.set(decl.name.text, bodyNames(init.body));
        if (isExported(stmt)) exportAs(decl.name.text, decl.name.text);
      }
    } else if (ts.isExportAssignment(stmt)) {
      // `export default async (p) => …` (QA N2, R09) and `export default someLocalSender`.
      const e = unwrap(stmt.expression);
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
        bodies.set(ANON_DEFAULT, bodyNames(e.body));
        exportAs(ANON_DEFAULT, 'default');
      } else if (ts.isIdentifier(e)) {
        exportAs(e.text, 'default');
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause &&
               ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) exportAs((el.propertyName ?? el.name).text, el.name.text);
    }
  }
  const senders = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, names] of bodies) {
      if (senders.has(name)) continue;
      if ([...names].some((x) => x !== name && (seed.has(x) || senders.has(x)))) {
        senders.add(name);
        changed = true;
      }
    }
  }
  return [...senders].flatMap((local) => exportedAs.get(local) ?? []).sort();
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
    for (const { rel, src } of scanned()) offenders.push(...testImports(rel, src));
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

// ═══ QA OF 2d67293 — EACH EXPLOIT, VERBATIM, AS A COMMITTED CONTROL ═══
// Every source string below is copied character for character from the QA harness's planted file
// (.scratch/kf-qa-p6/nc/out/<ID>.log). Against 2d67293 each one passed the scan green; each test
// here fails if its fix is reverted.
describe('QA 2d67293 findings — the exact exploits are caught', () => {
  it('F1 (C21): a route under a NESTED tests/ dir is scanned, and flagged', () => {
    const rel = 'app/api/sms/tests/route.ts';
    const src =
      "import { NextResponse } from 'next/server';\n" +
      "import { dispatchSms } from '@/lib/sms/twilio-client';\n" +
      "export async function POST(): Promise<NextResponse> { await dispatchSms('+1', {} as never, { dryRun: false }); return NextResponse.json({ ok: true }); }\n";
    expect(wouldScan(rel)).toBe(true);
    expect(twilioReach(rel, src)).not.toEqual([]);
    expect(CLASSIFIED[rel]).toBeUndefined();
    // …while the ROOT tests/ dir, colocated test files and dependencies stay out.
    expect(isSkippedDir('tests')).toBe(true);
    expect(isSkippedDir('app/api/sms/tests')).toBe(false);
    expect(isSkippedDir('lib/sms/tests')).toBe(false);
    expect(isSkippedDir('worker/node_modules')).toBe(true);
    expect(wouldScan('tests/sms/helpers.ts')).toBe(false);
    expect(wouldScan('app/api/sms/tests/route.test.ts')).toBe(false);
  });

  it('F2 (C12): `export { dispatchSms as qaLaundered }` appended to a classified module is laundering', () => {
    const src = read('lib/sms/welcome.ts') + '\n' + 'export { dispatchSms as qaLaundered };' + '\n';
    expect(launderedSeamExports(parse('lib/sms/welcome.ts', src))).toEqual(['qaLaundered']);
    expect(twilioReach('lib/sms/welcome.ts', src)).toContain('seam:re-export');
  });

  it('F2 (C13): `export const qaSendAlias = dispatchSms` appended to a classified module is laundering', () => {
    const src = read('lib/sms/weekly-send-io.ts') + '\n' + 'export const qaSendAlias = dispatchSms;' + '\n';
    expect(launderedSeamExports(parse('lib/sms/weekly-send-io.ts', src))).toEqual(['qaSendAlias']);
    expect(twilioReach('lib/sms/weekly-send-io.ts', src)).toContain('seam:re-export');
  });

  it('F2: the other hand-over shapes are laundering too; a wrapper or a type is not', () => {
    const launders: Array<[string, string]> = [
      ['alias then clause', `import { dispatchSms } from './twilio-client';\nconst d = dispatchSms;\nexport { d };`],
      ['object holding it', `import { twilioClient } from './twilio-client';\nexport const api = { client: twilioClient };`],
      ['default export', `import { dispatchSms } from './twilio-client';\nexport default dispatchSms;`],
      ['namespace import', `import * as seam from './twilio-client';\nexport const s = seam;`],
      ['destructured require', `const { dispatchSms } = require('./twilio-client');\nexport { dispatchSms as x };`],
      ['destructured await import', `const { twilioClient } = await import('./twilio-client');\nexport const c = twilioClient;`],
    ];
    for (const [label, src] of launders) {
      expect(launderedSeamExports(parse('lib/sms/x.ts', src)), label).not.toEqual([]);
    }
    const clean: Array<[string, string]> = [
      ['a wrapper function is a SENDER (completeness owns it), not a hand-over', `import { dispatchSms } from './twilio-client';\nexport const send = (to: string) => dispatchSms(to, {} as never, { dryRun: true });`],
      ['a type re-export cannot send', `import type { DispatchResult } from './twilio-client';\nexport type { DispatchResult };`],
      ['a type-only specifier cannot send', `import { type DispatchResult } from './twilio-client';\nexport type R = DispatchResult;`],
      ['a local inside a function does not taint a same-named export', `import { dispatchSms } from './twilio-client';\nexport function f(o: { d?: typeof dispatchSms }) { const send = o.d ?? dispatchSms; return send; }\nconst send = 1;\nexport { send };`],
    ];
    for (const [label, src] of clean) {
      expect(launderedSeamExports(parse('lib/sms/x.ts', src)), label).toEqual([]);
    }
  });

  it('F3 (C26): a sender exported through `export { qaNudge }` is on the completeness radar', () => {
    const src =
      read('lib/sms/welcome.ts') + '\n' +
      'async function qaNudge(p: string) {\n  return dispatchSms(p, {} as never, { dryRun: false });\n}\nexport { qaNudge };\n';
    expect(exportedSenders('lib/sms/welcome.ts', src)).toContain('qaNudge');
    expect(SEND_ENTRY_POINTS.qaNudge).toBeUndefined();
  });

  it('F3: a sender behind a PRIVATE helper, and one exported under an alias, are found too', () => {
    const src =
      `import { dispatchSms } from './twilio-client';\n` +
      `function helper(p: string) { return dispatchSms(p, {} as never, { dryRun: true }); }\n` +
      `export async function viaHelper(p: string) { return helper(p); }\n` +
      `const inner = (p: string) => helper(p);\nexport { inner as renamed };\n` +
      `export function unrelated() { return 1; }\n`;
    expect(exportedSenders('lib/sms/x.ts', src)).toEqual(['renamed', 'viaHelper']);
  });

  // ── QA round 2, N2: a sender that reaches the seam under another name. Each `…-app` string is
  // QA's plant (.scratch/kf-qa-p6/r2/c/R0N-app), verbatim, appended to welcome.ts as QA did.
  const N2_PLANTS: Array<[string, string, string]> = [
    ['R12 renamed seam import', 'qaViaRenamed',
      "\nimport { dispatchSms as qaRenamed } from './twilio-client';\nexport async function qaViaRenamed(p: string) {\n  return qaRenamed(p, {} as never, { dryRun: false });\n}\n"],
    ['R10 module-scope alias', 'qaViaAlias',
      '\nconst qaD = dispatchSms;\nexport async function qaViaAlias(p: string) {\n  return qaD(p, {} as never, { dryRun: false });\n}\n'],
    ['R11 namespace element access', 'qaViaNs',
      "\nimport * as qaSeamNs from './twilio-client';\nexport async function qaViaNs(p: string) {\n  return qaSeamNs['dispatchSms'](p, {} as never, { dryRun: false });\n}\n"],
    ['R08 anonymous default function', 'default',
      '\nexport default async function (p: string) {\n  return dispatchSms(p, {} as never, { dryRun: false });\n}\n'],
    ['R09 anonymous default arrow', 'default',
      '\nexport default async (p: string) => dispatchSms(p, {} as never, { dryRun: false });\n'],
  ];
  for (const [label, exported, plant] of N2_PLANTS) {
    it(`N2 (${label}): the sender is on the completeness radar as \`${exported}\``, () => {
      const src = read('lib/sms/welcome.ts') + plant;
      expect(exportedSenders('lib/sms/welcome.ts', src)).toContain(exported);
      expect(SEND_ENTRY_POINTS[exported]).toBeUndefined();
    });
  }

  it('N2: a default export naming a local sender is `default`; a non-sending default is not a sender', () => {
    const viaName =
      `import { dispatchSms } from './twilio-client';\n` +
      `async function nudge(p: string) { return dispatchSms(p, {} as never, { dryRun: true }); }\n` +
      `export default nudge;\n`;
    expect(exportedSenders('lib/sms/x.ts', viaName)).toEqual(['default']);
    const innocent =
      `import { dispatchSms } from './twilio-client';\n` +
      `export type Sender = typeof dispatchSms;\n` +
      `export default function label() { return 'weekly'; }\n`;
    expect(exportedSenders('lib/sms/x.ts', innocent)).toEqual([]);
  });

  it('F4 (C09): `io[\'sendWeeklySmsForSubscriber\']` counts as naming the entry point', () => {
    const rel = 'app/api/qa-elem/route.ts';
    const src =
      "import { NextResponse } from 'next/server';\n" +
      "import * as io from '@/lib/sms/weekly-send-io';\n" +
      'export async function POST(): Promise<NextResponse> {\n' +
      "  const go = io['sendWeeklySmsForSubscriber'];\n" +
      "  await go({ id: 'x' } as never, '+1');\n" +
      '  return NextResponse.json({ ok: true });\n' +
      '}\n';
    expect(identifiersIn(rel, src).has('sendWeeklySmsForSubscriber')).toBe(true);
    expect(SEND_ENTRY_POINTS.sendWeeklySmsForSubscriber).not.toContain(rel);
  });

  it('F4 (C10b): `m[\'sendWeeklySmsBulk\']` through a barrel counts as naming the entry point', () => {
    const rel = 'app/api/qa-barrel/route.ts';
    const src =
      "import { NextResponse } from 'next/server';\n" +
      "import * as m from '@/lib/sms/qa-barrel';\n" +
      "export async function POST(): Promise<NextResponse> { await m['sendWeeklySmsBulk']({}); return NextResponse.json({ ok: true }); }\n";
    expect(identifiersIn(rel, src).has('sendWeeklySmsBulk')).toBe(true);
    expect(SEND_ENTRY_POINTS.sendWeeklySmsBulk).not.toContain(rel);
  });

  it('F5 (C18): the SDK held in a variable and loaded by a computed import is caught', () => {
    const src =
      "const sdk = 'twilio';\n" +
      'export async function qaWorkerVar() {\n' +
      '  const m = await import(sdk);\n' +
      "  return m.default('AC' + 'x', 'y');\n" +
      '}\n';
    expect(twilioReach('worker/src/qa-worker-var.ts', src)).toContain('twilio-sdk:string');
  });

  it('F5 (C20): a regional Twilio REST edge host is caught', () => {
    const src =
      "export const qaEdge = () => fetch('https://api.dublin.ie1.twilio.com/2010-04-01/Accounts/AC/Messages.json', { method: 'POST' });\n";
    expect(twilioReach('scripts/qa-edge.ts', src)).toContain('twilio-rest-host');
  });

  it('F5: stays quiet on a provider label and a docs link (QA false-positive control F4, verbatim)', () => {
    const qaF4 =
      "import { NextResponse } from 'next/server';\n" +
      '// This route deliberately does NOT call sendWeeklySmsForSubscriber or sendConfirmationRequest.\n' +
      "export async function GET(): Promise<NextResponse> { return NextResponse.json({ provider: 'twilio' }); }\n";
    expect(twilioReach('app/api/qa-fp4/route.ts', qaF4)).toEqual([]);
    expect(identifiersIn('app/api/qa-fp4/route.ts', qaF4).has('sendWeeklySmsForSubscriber')).toBe(false);
    expect(twilioReach('lib/x.ts', `export const docs = 'https://www.twilio.com/docs/sms';`)).toEqual([]);
  });

  it('F6 (C25): a test-file specifier held in a variable and loaded by a computed import is caught', () => {
    const src = "const p = '../tests/sms/helpers';\nexport const qaDynTest = () => import(p);\n";
    expect(testImports('lib/qa-dyn-test.ts', src)).not.toEqual([]);
    // …but a plain word in a file that merely HAS a computed import is not a path.
    expect(testImports('lib/y.ts', `const kinds = ['tests', 'specs'];\nexport const load = (m: string) => import(m);`)).toEqual([]);
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
    // …and the loader's CODE (not a docstring) actually reads the two columns it is judged on.
    const loader = src.slice(src.indexOf('export const loadInstantPicksSendSubscriber'));
    expect(loader.slice(0, loader.indexOf('\n};\n'))).toMatch(
      /SELECT id, phone_number, preferences_token, consent_text_version,\s+status, confirmed_timestamp/
    );
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
    // The loader's CODE, not its docstring — the docstring quotes the same SQL, and matching the
    // whole file let a wrong-column mutation pass this lane (QA F8).
    const loader = src.slice(src.indexOf('export const loadWeeklySendConsent'));
    const loaderCode = loader.slice(0, loader.indexOf('\n};\n'));
    expect(loaderCode).toMatch(/SELECT status, confirmed_timestamp, phone_number FROM sms_consent WHERE id = \$1/);
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
