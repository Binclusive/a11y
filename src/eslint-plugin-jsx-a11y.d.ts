/**
 * Ambient types for `eslint-plugin-jsx-a11y`, which ships no `.d.ts` and has
 * no `@types/` package on npm. We only consume it as an ESLint flat-config
 * plugin, so we type it precisely against ESLint's own `ESLint.Plugin` shape
 * rather than reaching for `any` (which the repo bans).
 */
declare module "eslint-plugin-jsx-a11y" {
  import type { ESLint } from "eslint";
  const plugin: ESLint.Plugin;
  export default plugin;
}
