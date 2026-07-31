/**
 * Globals that the Node runtime genuinely provides but `@types/node@20.14.10` never
 * declares. Ambient-only: this file emits nothing.
 *
 * WHY THIS FILE EXISTS. The worker compiles against `lib: ["ES2022"]` with no `dom` lib
 * (tsconfig.json), because it runs as a headless Node process in a container — there is no
 * DOM. `DOMException`, however, IS a real Node global (WHATWG, stable since Node 17) and is
 * what `AbortController.abort(reason)` is spec'd to be given. `@types/node@20.14.10` simply
 * omits it: the string "DOMException" appears in that package only inside an unrelated doc
 * comment in `fs.d.ts`, never as a declaration. So `health/policy.ts` failed to compile in
 * the worker's own isolated build even though the code is correct at runtime.
 *
 * WHY NOT JUST ADD "dom" TO tsconfig's `lib`. It does compile cleanly — but it is the wrong
 * trade. Pulling in the full DOM lib tells the compiler this Node-only container process is
 * a browser, which makes `document`, `window`, `localStorage` and every other browser-only
 * global type-check clean here (verified: they do). Those would pass CI and then crash the
 * container at runtime — the same "green check, broken worker" failure class this shim is
 * being added to close, merely inverted. Declaring the one symbol Node actually provides
 * keeps the worker honest about its runtime.
 *
 * SHAPE. Modelled on the observed Node runtime object, not guessed: `DOMException` extends
 * `Error`, exposes readonly `name`/`message`/`code`, and takes `(message?, name?)`. The
 * `name` property is the part `isAbortLike()` in `health/policy.ts` depends on, since it
 * discriminates 'AbortError' / 'TimeoutError'.
 *
 * REMOVE THIS FILE when `@types/node` is upgraded to a version that declares `DOMException`
 * itself; the duplicate-identifier error that upgrade produces is the signal to delete it,
 * and the worker-build step in `.github/workflows/ci.yml` is what will surface it.
 */

interface DOMException extends Error {
  readonly name: string;
  readonly message: string;
  readonly code: number;
}

declare var DOMException: {
  prototype: DOMException;
  new (message?: string, name?: string): DOMException;
};
