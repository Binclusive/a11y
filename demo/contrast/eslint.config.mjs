import jsxA11y from "eslint-plugin-jsx-a11y";
import tsParser from "@typescript-eslint/parser";

// The standard a11y linter a developer enables: eslint-plugin-jsx-a11y, recommended.
const recommendedRules = jsxA11y.flatConfigs?.recommended?.rules ?? jsxA11y.configs.recommended.rules;

export default [
  {
    files: ["**/*.tsx"],
    plugins: { "jsx-a11y": jsxA11y },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    rules: recommendedRules,
  },
];
