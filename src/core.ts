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
import { isRouterLinkControl } from "./registry";
import {
  type ComponentResolution,
  type Coverage,
  type ResolvedComponents,
  resolveComponents,
} from "./resolve-components";
import {
  ariaHiddenLineRanges,
  isContentSuppressed,
  spreadChildrenLineRanges,
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
 *   - `axe`      — the rendered-DOM collector (see `collect-dom.ts`): a live URL
 *     is rendered in a real browser and axe-core runs against the resulting DOM.
 *     Source-blind by design — it covers non-React sites and live pages we have
 *     no `.tsx` for, and it sees what static analysis can't (color-contrast,
 *     computed roles, real rendered text). Anchored by `selector`, not a line.
 *   - `swiftui`  — the SwiftUI static collector (see `collect-swift.ts`): an
 *     out-of-process SwiftSyntax engine parses `.swift` source and applies the
 *     SwiftUI accessibility rules (missing image label, unlabeled control) with
 *     the ancestor-climb heuristic. Anchored by `file:line` like the source
 *     passes; the native counterpart of the jsx-a11y structural pass.
 *   - `corpus-agent` — the corpus-grounded RECALL layer (RFC Phase 1): an agent
 *     matches the scanned code against the distilled corpus slice and the
 *     server-side gate stack disposes. **Never produced by `scan()`** — only by
 *     the future `review_a11y` MCP tool, and always quarantined into a SEPARATE
 *     `recall` field (see {@link ScanResult}). Advisory only: `enforcement` is
 *     always `"warn"`, `layer` is always `"recall"`, and it can never reach the
 *     CLI exit code. This keeps `scan()`'s output byte-identical and the floor's
 *     precision intact.
 */
export type FindingProvenance =
  | "jsx-a11y"
  | "enforce"
  | "axe"
  | "swiftui"
  | "liquid"
  | "unity"
  | "corpus-agent";

/**
 * Which layer a finding belongs to. `floor` is the deterministic static floor
 * (jsx-a11y / enforce / axe / swiftui) — it gates the CLI exit code. `recall` is
 * the corpus-agent layer — advisory, quarantined, never exit-code-affecting.
 * Floor findings carry no `layer` (it defaults to `floor`); only the recall
 * layer tags it explicitly.
 */
export type FindingLayer = "floor" | "recall";

/**
 * How sure the agent lane is about a DISCOVERED finding — the recall layer's
 * self-reported judgement strength. Set only on `corpus-agent` discoveries (never
 * on a deterministic floor finding, which is reproducible, not a judgement). It is
 * advisory metadata for local rendering; it never reaches the CLI exit code and,
 * like every agent field, has no home on the metadata-only wire contract.
 */
export type AgentConfidence = "low" | "medium" | "high";

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
  /**
   * Which layer produced this finding (see {@link FindingLayer}). Absent on the
   * static floor passes (treated as `floor`); set to `recall` only on
   * `corpus-agent` findings, the quarantine signal the dedup + result shape rely
   * on.
   */
  readonly layer?: FindingLayer;
  /**
   * The distilled corpus pattern id this finding matched. Set only on
   * `corpus-agent` (recall) findings — it is the key for self-dedup
   * (`file:line:patternId`) and the provenance back to the corpus slice that
   * grounded it. Absent on every static-floor pass.
   */
  readonly patternId?: string;
  /**
   * Where the finding lives in a rendered DOM: the CSS selector axe-core
   * reports for the offending node. Set only on `axe` findings (`file` holds the
   * page URL and `line` is 0 — a live DOM has no source line). Absent on the
   * source-level passes, which anchor with `file:line`.
   */
  readonly selector?: string;
  /**
   * axe-core's per-node runtime IMPACT for this finding — the single most
   * accurate severity, computed by axe against the actual rendered node. Set
   * only on `axe` findings (the source passes have no axe runtime). The corpus
   * enrich step prefers this over the static baseline severity when present.
   */
  readonly severity?: "minor" | "moderate" | "serious" | "critical";
  /**
   * axe-core's Deque-University help URL for the rule that fired. Set only on
   * `axe` findings; the baseline catalog supplies the same URL for source-pass
   * findings via the SC lookup.
   */
  readonly helpUrl?: string;
  /**
   * The agent lane's IN-PLACE enrichment of a DETERMINISTIC finding — a prose
   * note / fix suggestion the agent attached without changing what the finding
   * IS. The finding stays `provenance: deterministic` (an automated rule still
   * surfaced it); this only adds AI judgement on top. Prose, never a patch —
   * suggestions-not-patches is structural (this is a string, not an edit). Local
   * only: the wire contract's deterministic arm has no field for it, so an
   * enrichment never crosses the metadata-only boundary.
   */
  readonly agentNote?: string;
  /**
   * The agent lane's confidence in a DISCOVERED finding (see {@link AgentConfidence}).
   * Set only on `corpus-agent` findings the agent surfaced that no deterministic
   * pass caught — never on a floor finding.
   */
  readonly confidence?: AgentConfidence;
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
// NOTE: jsx-a11y's `prefer-tag-over-role` is deliberately NOT enabled here. Run
// wholesale it is ~90% noise — it fires on `<svg role="img" aria-label>` (the
// correct accessible-SVG pattern), `role="status"`, custom `role="combobox"`
// widgets, etc. We ship a SCOPED version instead (`enforce/prefer-tag-over-role`
// in enforce.ts) limited to landmark/structural roles with one clean native tag.

/**
 * The router-Link destination prop. react-router / Remix `Link` / `NavLink`
 * render `<a>` but carry the navigation target on `to`, NOT `href` — so once
 * such a wrapper is mapped to host `a` (a `binclusive.json` `components`
 * declaration), `anchor-is-valid` reads the literal missing `href` and false-
 * positives on every valid `<Link to="/route">`. The fix is jsx-a11y's own
 * `specialLink` lever: it ALIASES `to` onto the rule's href check, so a valid
 * `to` satisfies it. It narrows the rule, it does NOT disable it — an empty
 * `to=""` or `to="#"` still lands in the rule's invalid-href branch and flags.
 */
const ROUTER_LINK_HREF_PROP = "to";

/**
 * Whether any resolved wrapper that landed in the jsx-a11y component map is a
 * react-router / Remix link control mapped to host `a` — i.e. the user mapped
 * `Link`/`NavLink` → `a` in `binclusive.json`. ONLY then do we alias `to` onto
 * `anchor-is-valid` (see {@link ROUTER_LINK_HREF_PROP}). When no router Link is
 * mapped, the rule config is byte-identical to before — zero-config and
 * non-router scans (and the matrix baseline) are untouched.
 *
 * Matches on `r.imported` (the original export name), NOT `r.name` (the local
 * JSX alias): a repo may `import { Link as RouterLink }` and map `RouterLink` ->
 * `a`, so the alias is `RouterLink` while the export the registry recognizes is
 * `Link`. Keying off the alias would silently disarm the fix for aliased imports.
 */
function mapsRouterLinkToAnchor(resolutions: readonly ComponentResolution[]): boolean {
  return resolutions.some(
    (r) => r.host === "a" && isRouterLinkControl(r.module, r.imported),
  );
}

function buildRuleConfig(aliasRouterLinkHref: boolean): Linter.RulesRecord {
  const rules: Linter.RulesRecord = {};
  for (const id of SCORED_RULES) {
    rules[`jsx-a11y/${id}`] =
      id === "anchor-is-valid" && aliasRouterLinkHref
        ? // `specialLink: ['to']` adds `to` to the props that satisfy the href
          // requirement, so a router `<Link to="/route">` is valid — while an
          // empty `to=""`/`to="#"` still flags via the invalid-href aspect.
          ["error", { specialLink: [ROUTER_LINK_HREF_PROP] }]
        : "error";
  }
  return rules;
}

function buildESLint(
  cwd: string,
  components: Readonly<Record<string, string>>,
  aliasRouterLinkHref: boolean,
): ESLint {
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
        rules: buildRuleConfig(aliasRouterLinkHref),
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
  /**
   * QUARANTINE (RFC Phase 1d). The corpus-agent RECALL findings ride here, in a
   * field SEPARATE from `findings` — never mixed in, never gating the CLI exit
   * code, never `enforcement:"block"`. `scan()` itself ALWAYS leaves this empty
   * (`[]`): only the future `review_a11y` recall layer populates it, after the
   * agent returns and the server-side gate stack disposes. Because the recall
   * findings live outside `findings`, `matrix:check` (which snapshots `findings`)
   * is structurally unable to see them — a stochastic count can never flip the
   * regression gate.
   */
  readonly recall: readonly Finding[];
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
    const empty: ResolvedComponents = { map: {}, coverage: EMPTY_COVERAGE, resolutions: [], unresolvedPackages: [], sourceFiles: new Map() };
    return { findings: [], coverage: empty.coverage, resolved: empty, contract, recall: [] };
  }

  const resolved = resolveComponents(tsxPaths, declarations?.components ?? {});
  const eslint = buildESLint(
    commonBaseDir(tsxPaths),
    resolved.map,
    mapsRouterLinkToAnchor(resolved.resolutions),
  );
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
              ...spreadChildrenLineRanges(file),
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
  // `scan()` produces NO corpus-agent findings — the recall layer is the only
  // producer, and it rides the quarantined `recall` field, never `findings`.
  // Keeping it empty here is what makes `scan()` output byte-identical.
  return { findings: merged, coverage: resolved.coverage, resolved, contract, recall: [] };
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
 * Dedup the corpus-agent RECALL candidates against the static floor and against
 * each other (RFC Phase 1d). Two mechanical passes, reusing `dedupeEnforce`'s
 * key discipline (`file:line:sc`):
 *
 *   1. CROSS-dedup — drop any candidate that shares `file:line` AND any WCAG SC
 *      with a STATIC finding. The floor already caught it; the recall layer
 *      exists for what the floor MISSES, so a co-located same-SC hit is
 *      redundant. (A missing floor finding is NOT permission to flag — that is
 *      G4's abstention veto, not this dedup; this only removes "floor already
 *      caught it.")
 *   2. SELF-dedup — collapse candidates by `(file, line, patternId)`, keeping the
 *      first. The same pattern matched twice on one element is one finding.
 *
 * Pure and model-free: a deterministic filter the recall layer applies AFTER the
 * agent returns and BEFORE quarantining the survivors into `recall`. Order is
 * stable — survivors keep their input order.
 */
export function dedupeRecall(
  candidates: readonly Finding[],
  staticFindings: readonly Finding[],
): readonly Finding[] {
  // 1 — CROSS-dedup against the static floor: identical `file:line:sc` covered-set
  // discipline as the enforce pass, so reuse it verbatim rather than re-derive it.
  const crossDeduped = dedupeEnforce(candidates, staticFindings);
  // 2 — SELF-dedup by `(file, line, patternId)`, keeping the first survivor.
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of crossDeduped) {
    const key = `${f.file}:${f.line}:${f.patternId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Convenience wrapper returning just the findings. Retained for callers that
 * don't need the coverage report.
 */
export async function checkFiles(filePaths: readonly string[]): Promise<Finding[]> {
  const { findings } = await scan(filePaths);
  return [...findings];
}
