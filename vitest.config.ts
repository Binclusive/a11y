import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // Keep the default `vitest run` (the `test` script) pure and browser-free:
    // the rendered-DOM e2e suite (`*.e2e.test.ts`) launches real Chromium and
    // takes seconds, so it is gated behind `test:e2e` (which overrides this
    // exclude). The unit count must stay at 272 and must never launch a browser.
    // `**/.claude/**` keeps nested agent/session worktrees (which carry their
    // own `test/**`) from being globbed alongside the real top-level suite.
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/*.e2e.test.ts"],
  },
});
