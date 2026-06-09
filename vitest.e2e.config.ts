import { configDefaults, defineConfig } from "vitest/config";

/**
 * Config for the rendered-DOM e2e suite (`pnpm test:e2e`). The default config
 * (vitest.config.ts) excludes `**\/*.e2e.test.ts` to keep the unit run fast and
 * browser-free; this config does NOT add that exclude, so the e2e files run.
 *
 * `include` is narrowed to `*.e2e.test.ts` so this command runs ONLY the
 * browser-coupled suite. CI must `npx playwright install chromium` first.
 */
export default defineConfig({
  test: {
    globals: false,
    include: ["test/**/*.e2e.test.ts"],
    exclude: [...configDefaults.exclude],
  },
});
