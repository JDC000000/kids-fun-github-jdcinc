// tests/sms/untyped-modules.d.ts — ambient declarations for two modules that ship no types.
//
// Needed by tests/sms/preferences_headers.test.ts, which deliberately loads THE REAL
// next.config.mjs and Next's OWN path matcher rather than a hand-copied literal: a test against a
// copy would keep passing after somebody edited or deleted the rule it exists to protect.
//
// Both are genuinely untyped rather than awkwardly typed — next.config.mjs is plain JavaScript,
// and `path-to-regexp` is vendored inside Next's `dist/compiled` with no declarations. Declared
// as `unknown` rather than `any` so the test still has to narrow them explicitly, which is where
// the shape being relied on gets written down.

declare module '*/next.config.mjs' {
  const config: unknown;
  export default config;
}

declare module 'next/dist/compiled/path-to-regexp' {
  export const pathToRegexp: (source: string) => RegExp;
}
