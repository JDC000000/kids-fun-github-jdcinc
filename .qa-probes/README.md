Throwaway verification probes go here. Gitignored, collected by the `unit` lane, outside every
TEST_ROOTS walk in tests/vitest-lane-split.test.ts.

Write `*.test.ts` files here instead of into `tests/` when you need to run an ad-hoc probe through
vitest — that is what this directory exists for, and it keeps the tracked tree clean when several
sessions share a worktree.
