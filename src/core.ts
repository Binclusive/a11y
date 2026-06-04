import tsParser from "@typescript-eslint/parser";
import { ESLint, type Linter } from "eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";
import ts from "typescript";
import {
  commonBaseDir,
  contractForFiles,
  type EnforcementLevel,
  enforcementFor,
  fileIgnoreMatcher,
  ignoredRuleIds,
} from "./config-scan";
import type { Contract } from "./contract";
import { enforceContent } from "./enforce";
import { type Coverage, type ResolvedComponents, resolveComponents } from "./resolve-components";
import {
  ariaHiddenLineRanges,
  isContentSuppressed,
  transInjectedLineRanges,
} from "./suppression-ranges";
import { wcagForRuleId } from "./wcag-map";

/**
 * Where a finding came from. Two producers, deliberately distinct so the report
 * (and dedupe) can tell them apart:
 *
 *   - `jsx-a11y` — the structural lint pass. Fires only on elements it can see
 *     as a host (intrinsic tags + wrappers resolved to a host via the component
 *     map). Misses opaque/trusted design-system components entirely.
 *   - `enforce`  — the corpus-driven call-site content check. Recognizes the
 *     control TYPE at the call site (resolved host / registry / name heuristic)
 *     and checks the app-owned content (name/alt/label/link-text) — so it fires
 *     on opaque/trusted components the structural pass can't reach. This is the
 *     recall win: "trusted" stops being false reassurance.
 */
export type FindingProvenance = "jsx-a11y" | "enforce";

/**
 * A single accessibility finding. A jsx-a11y finding is normalized off an
 * ESLint message; an enforce finding is produced by the call-site content check
 * (see `enforce.ts`). Both carry the same shape so the report and enforcement
 * gate treat them uniformly.
 *
 * `wcag` is derived from `ruleId` via {@link wcagForRuleId} for jsx-a11y, or set
 * directly by the enforce rule that fired; an empty array means we recognized
 * the rule fired but have no WCAG mapping for it yet (the finding still surfaces).
 *
 * `enforcement` is the contract's policy for this finding's SC (`block` gates
 * the CLI exit code, `warn` only surfaces). With no `binclusive.json` every
 * finding is `block` — the historical behavior.
 *
 * `provenance` tags which pass produced it (see {@link FindingProvenance}).
 */
export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly message: string;
  readonly wcag: readonly string[];
  readonly enforcement: EnforcementLevel;
  readonly provenance: FindingProvenance;
}

/**
 * The jsx-a11y rules we score, pinned to "error" so every one surfaces
 * regardless of the plugin's recommended on/off defaults. Each id here has a
 * WCAG mapping in `wcag-map.ts`; keeping the two lists aligned is what makes
 * a finding corpus-enrichable.
 */
const SCORED_RULES: readonly string[] = [
  "label-has-associated-control",
  "alt-text",
  "anchor-has-content",
  "anchor-is-valid",
  "aria-props",
  "role-has-required-aria-props",
  "role-supports-aria-props",
  "interactive-supports-focus",
  "click-events-have-key-events",
  "no-static-element-interactions",
  "heading-has-content",
];

function buildRuleConfig(): Linter.RulesRecord {
  const rules: Linter.RulesRecord = {};
  for (const id of SCORED_RULES) {
    rules[`jsx-a11y/${id}`] = "error";
  }
  return rules;
}

function buildESLint(cwd: string, components: Readonly<Record<string, string>>): ESLint {
  return new ESLint({
    cwd,
    // Self-contained: ignore any eslintrc / flat config found on disk so the
    // checker behaves identically wherever it runs.
    overrideConfigFile: true,
    errorOnUnmatchedPattern: false,
    overrideConfig: [
      {
        files: ["**/*.tsx"],
        plugins: { "jsx-a11y": jsxA11y },
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            ecmaFeatures: { jsx: true },
            sourceType: "module",
          },
        },
        settings: {
          "jsx-a11y": {
            polymorphicPropName: "as",
            // Derived per-scan from the registry + source-tracer, never a
            // hardcoded design-system list.
            components,
          },
        },
        rules: buildRuleConfig(),
      },
    ],
  });
}

/** The full output of a scan: findings plus the component-map coverage report. */
export interface ScanResult {
  readonly findings: readonly Finding[];
  readonly coverage: Coverage;
  readonly resolved: ResolvedComponents;
  /**
   * The `binclusive.json` that governed this scan (found at or above the files),
   * or `null` when the scan ran zero-config. Surfaced so the CLI can report what
   * policy was applied without re-loading the file.
   */
  readonly contract: Contract | null;
}

const EMPTY_COVERAGE: Coverage = {
  total: 0,
  declared: 0,
  registry: 0,
  traced: 0,
  opaque: 0,
  trusted: 0,
  icons: 0,
  structural: 0,
  declare: 0,
};

/**
 * Scan `.tsx` files: derive the wrapper->host component map (declared +
 * registry + source-trace), run eslint-plugin-jsx-a11y with that map, and return
 * the normalized findings plus the map's coverage report. Non-`.tsx` paths are
 * ignored. Parser errors are skipped (not a11y findings).
 *
 * Config-OPTIONAL. If a `binclusive.json` exists at or above the scanned files
 * its escape-hatch declarations + enforcement policy are applied:
 *
 *   - `components`      merge into the wrapper map (provenance `declared`, override)
 *   - `injectsChildren` extend the runtime child-injection suppression
 *   - `ignore` globs    drop matching files before they are linted
 *   - `ignore` rule ids drop findings for that rule ("off")
 *   - `enforcement`     tags each finding `block` vs `warn`
 *
 * With NO contract the behavior is exactly the historical one: every wrapper
 * auto-resolved, no extra suppression, no files skipped, every finding `block`.
 */
export async function scan(filePaths: readonly string[]): Promise<ScanResult> {
  const allTsx = filePaths.filter((p) => p.endsWith(".tsx"));
  const contract = contractForFiles(allTsx);
  const declarations = contract?.declarations ?? null;

  // Drop ignored files BEFORE linting — they never enter the scan, so they
  // contribute neither findings nor coverage noise.
  const isIgnoredFile =
    declarations === null ? () => false : fileIgnoreMatcher(declarations.ignore);
  const tsxPaths = allTsx.filter((p) => !isIgnoredFile(p));

  if (tsxPaths.length === 0) {
    const empty: ResolvedComponents = { map: {}, coverage: EMPTY_COVERAGE, resolutions: [] };
    return { findings: [], coverage: empty.coverage, resolved: empty, contract };
  }

  const resolved = resolveComponents(tsxPaths, declarations?.components ?? {});
  const eslint = buildESLint(commonBaseDir(tsxPaths), resolved.map);
  const results = await eslint.lintFiles([...tsxPaths]);

  const injectsChildren = declarations?.injectsChildren ?? [];
  const dropRules = declarations === null ? new Set<string>() : ignoredRuleIds(declarations.ignore);

  // Per-file line ranges of elements where a content-family finding is a false
  // positive. Two sources, merged:
  //   - runtime child injection (`<Trans>`/`render=` + the customer's own
  //     `injectsChildren` helpers) — the element is contentful at render time.
  //   - `aria-hidden` — the element is out of the a11y tree, so "empty
  //     link/heading" doesn't apply.
  // Computed once per file and reused, since a file can carry many findings.
  const suppressRangesCache = new Map<string, ReturnType<typeof transInjectedLineRanges>>();
  const suppressRangesFor = (filePath: string): ReturnType<typeof transInjectedLineRanges> => {
    const cached = suppressRangesCache.get(filePath);
    if (cached !== undefined) return cached;
    const text = ts.sys.readFile(filePath);
    const ranges =
      text === undefined
        ? []
        : (() => {
            const file = ts.createSourceFile(
              filePath,
              text,
              ts.ScriptTarget.Latest,
              true,
              ts.ScriptKind.TSX,
            );
            return [
              ...transInjectedLineRanges(file, injectsChildren),
              ...ariaHiddenLineRanges(file),
            ];
          })();
    suppressRangesCache.set(filePath, ranges);
    return ranges;
  };

  const findings: Finding[] = [];
  for (const result of results) {
    for (const msg of result.messages) {
      // Skip fatal parse errors — not a11y findings.
      if (msg.fatal === true || msg.ruleId === null) continue;
      // Source files carry inline `eslint-disable` directives for rules we
      // don't load (e.g. @next/next/*, react-hooks/*). ESLint surfaces those
      // as "Definition for rule ... was not found" problems. They are not
      // accessibility findings — keep only jsx-a11y hits.
      if (!msg.ruleId.startsWith("jsx-a11y/")) continue;
      // `ignore` rule ids turn a rule OFF — drop every finding for it.
      if (dropRules.has(msg.ruleId)) continue;
      // Drop content-family findings on elements that are contentful at runtime
      // (`<Trans>`, `render=`, declared helper) OR removed from the a11y tree
      // (`aria-hidden`) — the "empty element" premise doesn't hold for either.
      if (isContentSuppressed(msg.ruleId, msg.line, suppressRangesFor(result.filePath))) continue;
      const wcag = wcagForRuleId(msg.ruleId);
      findings.push({
        file: result.filePath,
        line: msg.line,
        ruleId: msg.ruleId,
        message: msg.message,
        wcag,
        enforcement: enforcementFor(wcag, contract),
        provenance: "jsx-a11y",
      });
    }
  }

  // Corpus-driven call-site content check. Recognizes the control TYPE at the
  // call site (resolved host / registry / name heuristic) and flags app-owned
  // content that is clearly missing — INCLUDING on opaque/trusted components the
  // structural pass above can never reach. Conservative: dynamic/spread/computed
  // content is "incomplete", not a violation, and is never flagged.
  const enforceFindings = enforceContent(tsxPaths, {
    resolutions: resolved.resolutions,
    declarations,
    contract,
  });
  // Dedupe: an element the structural pass already flagged (resolved-to-host)
  // must not be double-reported by the enforce pass.
  const merged = [...findings, ...dedupeEnforce(enforceFindings, findings)];
  return { findings: merged, coverage: resolved.coverage, resolved, contract };
}

/**
 * Drop every enforce finding that the structural jsx-a11y pass already reported
 * for the SAME element, so a wrapper resolved to a host (and flagged there)
 * isn't double-counted by the call-site check.
 *
 * The match key is (file, line, shared WCAG SC): both passes anchor a finding
 * to the element's opening-tag line and tag it with the same SC family
 * (button-no-name → 4.1.2, img-no-alt → 1.1.1, link-no-name → 2.4.4, ...). When
 * jsx-a11y has already fired on that line for an overlapping SC, the enforce
 * finding is redundant. When it hasn't — the opaque/trusted case the structural
 * pass can't see — the enforce finding is the NEW recall the check exists for.
 */
function dedupeEnforce(
  enforce: readonly Finding[],
  jsxA11y: readonly Finding[],
): readonly Finding[] {
  const covered = new Set<string>();
  for (const f of jsxA11y) {
    for (const sc of f.wcag) covered.add(`${f.file}:${f.line}:${sc}`);
  }
  return enforce.filter((f) => !f.wcag.some((sc) => covered.has(`${f.file}:${f.line}:${sc}`)));
}

/**
 * Convenience wrapper returning just the findings. Retained for callers that
 * don't need the coverage report.
 */
export async function checkFiles(filePaths: readonly string[]): Promise<Finding[]> {
  const { findings } = await scan(filePaths);
  return [...findings];
}
