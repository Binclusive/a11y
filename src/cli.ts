import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Args, Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Option } from "effect";
import type { Severity as ContractSeverity } from "@binclusive/a11y-contract";
import { type AgentLaneOverrides, augmentWithAgentLane } from "./agent-lane";
import { collectTsx } from "./collect";
import { contractSeverity } from "./emit-contract";
// Type-only: the rendered-DOM lane (playwright/@axe-core) is loaded lazily inside
// `runCheckUrl` so the static `check` path carries no eager browser-stack import
// and the CI image can ship without it (issue #2133).
import type { DomScanResult } from "./collect-dom";
import { scanLiquid } from "./collect-liquid";
import { scanSwift } from "./collect-swift";
import { gen, init, type LearnInput, learn } from "./commands";
import { collectUnityFindings } from "./unity-findings";
import { type FindingProvenance, scan } from "./core";
import { type Evidence, type EnrichedFinding, enrichAll, resolveDisplay } from "./evidence";
import { runHookCli } from "./hook";
import { phoneHome } from "./phone-home";
import { formatSarif } from "./sarif";
import {
  GATE_OFF,
  type GateConfig,
  gateExitCode,
  SEVERITY_ORDER,
  toGateFinding,
} from "./severity-gate";
import type { ComponentResolution, Coverage } from "./resolve-components";
import type { SuggestResult } from "./suggest";

/**
 * The body of a finding report — everything below the location line. Shared by
 * the source report (`formatFinding`, anchored `file:line`) and the rendered-DOM
 * report (`formatUrlFinding`, anchored on the axe selector) so the baseline
 * cross-ref and fix render identically regardless of which collector produced the
 * finding. The `via` tag names the non-structural producers so each one's
 * distinct reach is legible.
 */
export function detailLines(f: EnrichedFinding): string[] {
  const scList =
    f.wcag.length > 0 ? f.wcag.map((sc) => `WCAG ${sc}`).join(", ") : "no WCAG mapping";
  const via =
    f.provenance === "enforce"
      ? "  (call-site content check)"
      : f.provenance === "axe"
        ? "  (rendered-DOM / axe)"
        : f.provenance === "swiftui"
          ? "  (SwiftUI static)"
          : "";
  const lines = [
    `    rule:   ${f.ruleId}  [${f.enforcement}]${via}`,
    `    wcag:   ${scList}`,
    `    ${f.message}`,
  ];

  // The display contract resolves the axe-vs-SC policy once (see resolveDisplay):
  // WHAT severity / fix-line / ref / patterns to show. This printer only places
  // those resolved values in each source's layout — no policy, no provenance
  // checks.
  const d = resolveDisplay(f);
  if (d.severityLabel !== null) lines.push(`    severity: ${d.severityLabel}`);

  if (d.fixLine !== null) lines.push(`    fix:    ${d.fixLine}`);
  if (d.refUrl !== null) lines.push(`    ref:    ${d.refUrl}`);

  const c = f.corpus;
  switch (c.source) {
    case "baseline":
      // Coverage: axe's published per-rule data (severity + standard fix + help).
      if (c.bestPractice) {
        // An axe best-practice rule with no WCAG SC — honestly NOT a WCAG failure.
        lines.push("    rule:   best-practice (no WCAG SC)");
      } else {
        lines.push(`    coverage: axe baseline rule SC ${c.sc}`);
      }
      break;
    case "none":
      // The baseline catalog doesn't know the SC — but never a bare dead-end: the
      // ref above surfaces whatever runtime help the finding itself carries.
      lines.push("    coverage: no SC mapping — not in the axe baseline catalog");
      break;
  }
  return lines;
}

function formatFinding(f: EnrichedFinding, root: string): string {
  return [`  ${relative(root, f.file)}:${f.line}`, ...detailLines(f)].join("\n");
}

/** A rendered-DOM finding, anchored on the axe CSS selector instead of a line. */
function formatUrlFinding(f: EnrichedFinding): string {
  return [`  ${f.selector ?? "(document)"}`, ...detailLines(f)].join("\n");
}

/**
 * The two summary lines every report ends on: the evidence rollup and the
 * enforcement split. Returns the blocking count too, since that gates the exit
 * code. Shared by the source and rendered-DOM reports.
 *
 * Audit-corpus hits roll up under their real frequency tier (the moat).
 * Baseline hits — covered by axe's catalog but absent from audit-frequency data,
 * INCLUDING the best-practice rules matched by ruleId — roll up under `BASELINE`.
 * `UNMAPPED` is left only for findings whose ruleId is absent from the catalog,
 * so the coverage layer is visible without being mistaken for moat data.
 */
function reportTotals(findings: readonly EnrichedFinding[]): {
  readonly lines: readonly string[];
  readonly blocking: number;
} {
  const sourceCounts = new Map<string, number>();
  for (const f of findings) {
    const key = f.corpus.source === "baseline" ? "BASELINE" : "UNMAPPED";
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
  }
  const rollup = [...sourceCounts.entries()].map(([src, n]) => `${src}: ${n}`).join("  |  ");
  const blocking = findings.filter((f) => f.enforcement === "block").length;
  const warning = findings.length - blocking;
  return {
    lines: [
      `${findings.length} finding(s)   ${rollup}`,
      `enforcement: ${blocking} blocking · ${warning} warning`,
    ],
    blocking,
  };
}

/**
 * Render the a11y-coverage report in three HONEST buckets — the reframe of the
 * old `mapped | opaque` line, which lumped opaque-but-fine library components in
 * with genuine unknowns and made a design-system app look ~94% blind:
 *
 *   - checked — the mapped set (declared + registry + traced). jsx-a11y runs on
 *     these; every finding comes from here. (Unchanged behavior.)
 *   - trusted — OPAQUE components from a known-accessible design system. The
 *     library guarantees their internal structure; opaque is fine.
 *   - declare — OPAQUE genuine unknowns. The real gap — and the ONLY bucket that
 *     keeps the actionable "declare it in binclusive.json" hints.
 *
 * Icon / structural / no-host components get a one-line tail note (no host
 * exists to check; dumping them in `declare` would be a false to-do — `Fragment`,
 * providers, router layout, charts and email components are plumbing, not
 * controls). A standing honesty note
 * keeps `trusted` from reading as "fully verified": the library guarantees the
 * STRUCTURE, but the content the customer passes (names, labels, alt) is checked
 * in a follow-up pass.
 */
function formatCoverage(
  coverage: Coverage,
  resolutions: readonly ComponentResolution[],
  unresolvedPackages: readonly string[] = [],
): string {
  const checked = coverage.declared + coverage.registry + coverage.traced;
  const lines = [
    "a11y coverage:",
    `  checked  ${checked}  — elements we inspected (findings come from here)`,
  ];

  if (coverage.trusted > 0) {
    lines.push(
      `  trusted  ${coverage.trusted}  — from a known-accessible design system (${trustedLibraries(resolutions)}) — the library handles these`,
    );
  }

  // `declare` is the prominent, actionable bucket: one copy-paste config to-do
  // per genuine unknown. Always shown when non-zero, even if trusted dominates.
  const declare = resolutions.filter(
    (r) => r.provenance === "opaque" && r.opaqueKind === "declare",
  );
  if (declare.length > 0) {
    lines.push(
      `  declare  ${coverage.declare}  — unrecognized; declare in binclusive.json to inspect them:`,
    );
    for (const r of declare) {
      lines.push(`    ${formatOpaqueHint(r)}`);
    }
  }

  // Icons have no interactive host — surface as a count, never as a to-do.
  if (coverage.icons > 0) {
    lines.push(`  (+ ${coverage.icons} icon/no-host component(s), nothing to check)`);
  }

  // Structural plumbing (Fragment / providers / router layout / charts / email)
  // has no interactive host either — a count, never an actionable declare to-do.
  if (coverage.structural > 0) {
    lines.push(
      `  (+ ${coverage.structural} structural/plumbing component(s) — no interactive host, nothing to check)`,
    );
  }

  // Honesty guard: `trusted` is a STRUCTURE guarantee, not a content pass — but
  // the enforce call-site check DOES inspect the content the app passes to these
  // components (names, labels, alt), so "trusted" is no longer a blind spot.
  if (coverage.trusted > 0) {
    lines.push(
      "  note: trusted = the library guarantees the structure; the content YOU pass (names, labels, alt) is checked by the call-site content check.",
    );
  }

  // Cold-scan signal: components that are declare-opaque because their package
  // isn't installed on disk (no node_modules). This is NOT a false declare — the
  // component is genuinely unresolved — but the ROOT CAUSE is missing deps, not
  // a missing declaration. Tell the user so they can act.
  if (unresolvedPackages.length > 0) {
    lines.push(
      `  note: ${coverage.declare} component(s) are opaque because their package isn't resolved on disk (${unresolvedPackages.join(", ")}) — install dependencies for deeper tracing.`,
    );
  }

  return lines.join("\n");
}

/**
 * The distinct guaranteeing-library names across the TRUSTED bucket, comma-
 * joined for the `trusted` line (`Radix, MUI`). Sorted for a deterministic
 * report. Reads only the `library` carried on each trusted resolution.
 */
function trustedLibraries(resolutions: readonly ComponentResolution[]): string {
  const libs = new Set<string>();
  for (const r of resolutions) {
    if (r.provenance === "opaque" && r.opaqueKind === "trusted" && r.library !== null) {
      libs.add(r.library);
    }
  }
  return [...libs].sort().join(", ");
}

/**
 * Turn one DECLARE-bucket component into a copy-paste config to-do. We can't
 * know the host — that's why it's unresolved — so we list the realistic host
 * options and tell the customer to pick ONE. This is the line that turns a
 * genuine unknown from a dead end into an actionable entry.
 */
export function formatOpaqueHint(r: ComponentResolution): string {
  return (
    `${r.name} (from ${r.module}) — unrecognized. ` +
    `Declare it: binclusive.json → "components": { "${r.name}": "<host>" } ` +
    `— pick ONE of: ${HOST_OPTIONS}`
  );
}

/** The interactive host primitives a wrapper most often resolves to. */
const HOST_OPTIONS = "button | a | input | textarea | select | label | div";

// ---------------------------------------------------------------------------
// JSON report contract
// ---------------------------------------------------------------------------

export interface JsonFinding {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly enforcement: "block" | "warn";
  readonly provenance: FindingProvenance;
  readonly wcag: readonly string[];
  /**
   * The contract's 3-level severity (`critical`/`major`/`minor`), resolved
   * through the ONE {@link contractSeverity} mapping so this field can never
   * disagree with the wire projection or SARIF. Emitted here so downstream
   * consumers (the CI PR-summary rollup, #2132) count by the canonical contract
   * severity rather than re-deriving it from the evidence/axe impact.
   */
  readonly severity: ContractSeverity;
  /** The WCAG success-criterion id the finding maps to (contract `criterion` = the first `wcag` tag), e.g. "1.4.3"; "" when the rule carries no SC. */
  readonly criterion: string;
  /** The coverage-catalog cross-reference: which source matched, the SC, and whether it is an axe best-practice rule (no WCAG SC). Frequency is platform-derived (ADR 0041 §G), never carried here. */
  readonly evidence: { readonly source: Evidence["source"]; readonly sc: string | null; readonly bestPractice: boolean };
  readonly message: string;
}

export interface JsonReport {
  readonly tool: "a11y-checker";
  readonly root: string;
  readonly filesScanned: number;
  readonly coverage: {
    readonly checked: number;
    readonly trusted: number;
    readonly declare: number;
    readonly icons: number;
    readonly structural: number;
    readonly total: number;
  };
  readonly findings: readonly JsonFinding[];
  readonly summary: {
    readonly findings: number;
    readonly blocking: number;
    readonly warning: number;
  };
}

/**
 * Project the source-discriminated `Evidence` union into the flat
 * `{ source, sc, bestPractice }` shape the JSON contract exposes. The corpus left
 * the engine (ADR 0041 §G), so no frequency tier or org count is carried —
 * frequency is platform-derived and read-joined onto the ticket.
 */
function jsonEvidence(c: Evidence): {
  readonly source: Evidence["source"];
  readonly sc: string | null;
  readonly bestPractice: boolean;
} {
  switch (c.source) {
    case "baseline":
      return { source: "baseline", sc: c.sc, bestPractice: c.bestPractice };
    case "none":
      return { source: "none", sc: null, bestPractice: false };
  }
}

export function buildJsonReport(
  root: string,
  filesScanned: number,
  coverage: Coverage,
  findings: readonly EnrichedFinding[],
): JsonReport {
  const checked = coverage.declared + coverage.registry + coverage.traced;
  const blocking = findings.filter((f) => f.enforcement === "block").length;
  const warning = findings.length - blocking;

  const jsonFindings: JsonFinding[] = findings.map((f) => ({
    id: `${f.ruleId}|${relative(root, f.file)}|${f.line}|${f.wcag.join(",")}`,
    file: relative(root, f.file),
    line: f.line,
    ruleId: f.ruleId,
    enforcement: f.enforcement,
    provenance: f.provenance,
    wcag: f.wcag,
    // Resolve severity + criterion through the ONE contract projection so the
    // report's counts match the wire/SARIF and never re-derive a second mapping.
    severity: contractSeverity(f),
    criterion: f.wcag[0] ?? "",
    evidence: jsonEvidence(f.corpus),
    message: f.message,
  }));

  return {
    tool: "a11y-checker",
    root,
    filesScanned,
    coverage: {
      checked,
      trusted: coverage.trusted,
      declare: coverage.declare,
      icons: coverage.icons,
      structural: coverage.structural,
      total: coverage.total,
    },
    findings: jsonFindings,
    summary: {
      findings: findings.length,
      blocking,
      warning,
    },
  };
}

/**
 * The shared report tail for both runners (source + rendered-DOM): empty-state,
 * grouped findings, the totals rollup, and the blocking-gated exit code. Each
 * runner keeps its own PREAMBLE (the scan header / coverage block) and supplies
 * only what differs — the empty-state text, how findings group, the per-group
 * header line, and which formatter renders each finding. Output is identical to
 * the inlined tails this replaced.
 */
function renderReport(
  findings: readonly EnrichedFinding[],
  opts: {
    readonly emptyMessage: string;
    readonly groupKey: (f: EnrichedFinding) => string;
    readonly groupHeader: (key: string) => string;
    readonly formatItem: (f: EnrichedFinding) => string;
  },
  gate: GateConfig = GATE_OFF,
): void {
  if (findings.length === 0) {
    console.log(opts.emptyMessage);
    return;
  }

  const groups = new Map<string, EnrichedFinding[]>();
  for (const f of findings) {
    const key = opts.groupKey(f);
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }

  for (const [key, group] of groups) {
    console.log(opts.groupHeader(key));
    for (const f of group) {
      console.log(opts.formatItem(f));
      console.log("");
    }
  }

  // Tier rollup + enforcement split — the two summary lines every report ends on.
  const totals = reportTotals(findings);
  for (const line of totals.lines) console.log(line);

  // Default (unset gate): exit non-zero only when something the contract BLOCKS
  // fired — a warn-only scan is a clean build. When the opt-in gate is set, the
  // exit reflects the gate (severity threshold / max-violations) instead (#2134).
  process.exitCode = gateExitCode(findings.map(toGateFinding), gate);
}

/**
 * The `check` command's runner. The optional {@link AgentLaneOverrides} is the AI
 * lane's ONLY injection seam: the CLI handler never passes it (the lane resolves
 * its provider from `LLM_API_KEY`), but the tracer test drives this same function
 * with a stub provider to prove an agent finding reaches rendered output.
 */
export async function runCheck(
  dir: string,
  json = false,
  sarif = false,
  runId = "local",
  agentOverrides: AgentLaneOverrides = {},
  gate: GateConfig = GATE_OFF,
): Promise<void> {
  const root = resolve(dir);
  const files = await collectTsx(root);

  // SARIF is a machine format like --json, but rendered for GitHub code-scanning
  // (uris relativized against `root`, provenance-tagged). It takes precedence
  // over --json when both are set; the CI Action asks for one format per run.
  if (sarif) {
    const deterministic = files.length === 0 ? [] : enrichAll((await scan(files)).findings);
    // AI lane (issue #2182): fold in agent findings when LLM_API_KEY is present.
    // Non-blocking — agent findings are warn-only, so the block-gated exit is
    // computed on the augmented list and can only reflect the deterministic floor.
    const findings = await augmentWithAgentLane(deterministic, root, process.env, agentOverrides);
    console.log(formatSarif(findings, runId, { root }));
    process.exitCode = gateExitCode(findings.map(toGateFinding), gate);
    return;
  }

  if (json) {
    if (files.length === 0) {
      const report = buildJsonReport(root, 0, { total: 0, declared: 0, registry: 0, traced: 0, opaque: 0, trusted: 0, icons: 0, structural: 0, declare: 0 }, []);
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const result = await scan(files);
    const deterministic = enrichAll(result.findings);
    // AI lane (issue #2182): agent findings flow through the SAME JSON report and
    // phone-home envelope as the deterministic floor. When no key is present this
    // returns `deterministic` unchanged.
    const findings = await augmentWithAgentLane(deterministic, root, process.env, agentOverrides);
    const report = buildJsonReport(root, files.length, result.coverage, findings);
    console.log(JSON.stringify(report, null, 2));
    // OPTIONAL, non-blocking phone-home (#2108): file metadata-only findings to
    // the dashboard when the CI env carries a `b8e_` token + org/project. Fully
    // env-gated, so a local `check --json` (no such env) silently skips; a
    // failure here is swallowed inside `phoneHome` and never changes exit code.
    await phoneHome(findings, root, process.env);
    process.exitCode = gateExitCode(findings.map(toGateFinding), gate);
    return;
  }

  if (files.length === 0) {
    console.log(`No .tsx files under ${root}`);
    return;
  }

  const result = await scan(files);
  const deterministic = enrichAll(result.findings);
  const findings = await augmentWithAgentLane(deterministic, root, process.env, agentOverrides);

  console.log(`a11y-checker — scanned ${files.length} .tsx file(s) under ${root}\n`);

  // Coverage first — it frames how much of the codebase the findings cover.
  console.log(formatCoverage(result.coverage, result.resolved.resolutions, result.resolved.unresolvedPackages));
  console.log("");

  // Group by file for a readable report.
  renderReport(
    findings,
    {
      emptyMessage: "No jsx-a11y violations found.",
      groupKey: (f) => f.file,
      groupHeader: (file) => relative(root, file),
      formatItem: (f) => formatFinding(f, root),
    },
    gate,
  );
}

/**
 * Accept a bare filesystem path (`./dist/index.html`) as well as a real URL.
 * If the arg already carries a scheme (`http://`, `https://`, `file://`) pass it
 * through; otherwise it's a local path — resolve it and convert to a `file://`
 * URL so Playwright can navigate to it.
 */
function normalizeTarget(target: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : pathToFileURL(resolve(target)).href;
}

/**
 * The rendered-DOM counterpart to `runCheck`: drive a real browser to the URL,
 * run axe-core against the live page, and report findings anchored on CSS
 * selectors instead of source lines. This is the source-less path — it inspects
 * what actually ships, so it covers non-React pages and anything the static
 * .tsx scan can't see (server-rendered markup, third-party widgets, runtime DOM).
 */
async function runCheckUrl(url: string): Promise<void> {
  const target = normalizeTarget(url);
  console.log(`a11y-checker — rendering ${target} and running axe-core\n`);

  let result: DomScanResult;
  try {
    // Load the browser lane on demand so `check` never pulls playwright/@axe-core.
    const { scanUrl } = await import("./collect-dom");
    result = await scanUrl(target);
  } catch (err) {
    // scanUrl re-throws a load/launch failure as an actionable one-line Error;
    // print just that message (no stack) and exit 2 — a typo'd URL is a usage
    // error, not a crash.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }
  const findings = enrichAll(result.findings);

  // Group by axe rule for a readable report — the DOM path has no file to group
  // on (every finding shares the URL), so the ruleId is the natural section key.
  renderReport(findings, {
    emptyMessage: "No axe-core violations found.",
    groupKey: (f) => f.ruleId,
    groupHeader: (ruleId) => ruleId,
    formatItem: (f) => formatUrlFinding(f),
  });
}

/**
 * The native counterpart to `runCheck`: shell to the out-of-process SwiftSyntax
 * engine, which parses `.swift` source under `dir` and applies the static
 * SwiftUI accessibility rules (with the ancestor-climb heuristic). Findings are
 * anchored on `file:line` like the jsx-a11y pass, so the report groups by file
 * exactly as `runCheck` does. The Swift toolchain may be missing — `scanSwift`
 * surfaces that as a one-line Error, handled like `runCheckUrl`'s launch failure.
 */
async function runCheckSwift(dir: string): Promise<void> {
  let result: Awaited<ReturnType<typeof scanSwift>>;
  try {
    result = await scanSwift(dir);
  } catch (err) {
    // The Swift toolchain (or the prebuilt binary) may be absent — print just
    // the actionable one-line message and exit 2, same discipline as a bad URL.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }
  // The collector owns its path namespace: it returns the canonical, symlink-free
  // `root` it scanned in, so `relative(root, …)` here renders clean
  // `Sources/…/X.swift:line` locations that agree with the engine's emitted paths.
  const { root } = result;
  console.log(`a11y-checker — scanning .swift under ${root} for SwiftUI a11y\n`);

  const findings = enrichAll(result.findings);

  renderReport(findings, {
    emptyMessage: "No SwiftUI a11y violations found.",
    groupKey: (f) => f.file,
    groupHeader: (file) => relative(root, file),
    formatItem: (f) => formatFinding(f, root),
  });
}

/**
 * The Liquid counterpart to `runCheck`: statically scan `.liquid` theme source
 * (in-process — `@shopify/liquid-html-parser` + the structural-absence rules),
 * enrich through the SAME corpus cross-ref, and report findings anchored on
 * `file:line` like the jsx-a11y and SwiftUI passes. No browser, no network. Liquid
 * has no component resolver, so coverage is zeroed in the `--json` shape. A file
 * the parser rejects is skipped (surfaced as a count), never fatal.
 */
async function runCheckShopify(dir: string, json = false): Promise<void> {
  const { root, files, findings: raw, parseErrors } = await scanLiquid(dir);
  const findings = enrichAll(raw);

  if (json) {
    // Liquid carries no resolver coverage — emit the zeroed coverage literal so
    // the JSON shape stays identical to `check`.
    const report = buildJsonReport(
      root,
      files.length,
      { total: 0, declared: 0, registry: 0, traced: 0, opaque: 0, trusted: 0, icons: 0, structural: 0, declare: 0 },
      findings,
    );
    console.log(JSON.stringify(report, null, 2));
    const blocking = findings.filter((f) => f.enforcement === "block").length;
    process.exitCode = blocking > 0 ? 1 : 0;
    return;
  }

  if (files.length === 0) {
    console.log(`No .liquid files under ${root}`);
    return;
  }

  console.log(`a11y-checker — scanned ${files.length} .liquid file(s) under ${root}`);
  if (parseErrors.length > 0) {
    console.log(`  (${parseErrors.length} file(s) skipped — could not parse)`);
  }
  console.log("");

  renderReport(findings, {
    emptyMessage: "No Liquid a11y violations found.",
    groupKey: (f) => f.file,
    groupHeader: (file) => relative(root, file),
    formatItem: (f) => formatFinding(f, root),
  });
}

/**
 * The Unity counterpart to `runCheck`: statically scan a Unity project's Force-Text
 * scenes (`.prefab`/`.unity`) via the in-process aggregator (`collectUnityFindings`),
 * enrich through the SAME corpus cross-ref, and report findings anchored on `file:line`
 * like every other producer. No browser, no network. The aggregator owns the scan and
 * returns one flat `Finding[]` (all `provenance: "unity"`, `layer: "floor"`); a missing
 * or unreadable project dir is an empty scan, never a throw. Unity has no component
 * resolver, so coverage is zeroed in the `--json` shape — identical structure to
 * `check-shopify --json`.
 */
async function runCheckUnity(dir: string, json = false): Promise<void> {
  const root = resolve(dir);
  const findings = enrichAll(await collectUnityFindings(root));

  if (json) {
    // Unity carries no resolver coverage — emit the zeroed coverage literal so the
    // JSON shape stays identical to `check` / `check-shopify`.
    const report = buildJsonReport(
      root,
      0,
      { total: 0, declared: 0, registry: 0, traced: 0, opaque: 0, trusted: 0, icons: 0, structural: 0, declare: 0 },
      findings,
    );
    console.log(JSON.stringify(report, null, 2));
    const blocking = findings.filter((f) => f.enforcement === "block").length;
    process.exitCode = blocking > 0 ? 1 : 0;
    return;
  }

  console.log(`a11y-checker — scanning Unity Force-Text scenes under ${root}\n`);

  renderReport(findings, {
    emptyMessage: "No Unity a11y violations found.",
    groupKey: (f) => f.file,
    groupHeader: (file) => relative(root, file),
    formatItem: (f) => formatFinding(f, root),
  });
}

async function runInit(suggest: boolean, dirArg: string): Promise<void> {
  const dir = resolve(dirArg);
  const r = await init(dir, { suggest });
  const s = r.contract.stack;
  const router = s.router === null ? "" : ` (${s.router} router)`;
  const title = suggest ? "init --suggest" : "init";
  console.log(`a11y-checker ${title} — ${dir}`);
  console.log(`  stack:       ${s.framework}${router} · ${s.designSystem} · ${s.language}`);
  if (r.suggestions !== null) printSuggestions(r.suggestions);
  if (r.suggestions === null) {
    console.log(`  enforcement: block ${r.contract.enforcement.block.join(", ") || "(none)"}`);
  }
  if (r.suggestions === null) {
    console.log(`  wrote:       ${relative(dir, r.contractPath)}`);
  } else {
    console.log(
      `  wrote:       ${relative(dir, r.contractPath)} (components map included — review before committing)`,
    );
  }
  for (const p of r.blockPaths) console.log(`  block:       ${relative(dir, p)}`);
  if (r.preservedLearned > 0) {
    console.log(`  preserved:   ${r.preservedLearned} learned rule(s)`);
  }
}

/**
 * Render the `--suggest` block: every guessed host, aligned, with a confidence
 * marker (✓ confident, ⚠ verify + reason) so the user REVIEWS each one — the
 * whole point of suggesting rather than silently applying. Composites/toggles
 * left in declare are listed too, so nothing the guesser skipped is invisible.
 */
function printSuggestions(result: SuggestResult): void {
  const { suggestions, skipped } = result;
  if (suggestions.length === 0) {
    console.log(
      "  no leaf primitives to hand-map — they're already recognized (registry / trace / trusted library) or composite",
    );
  } else {
    console.log(
      `  suggested ${suggestions.length} component mapping${suggestions.length === 1 ? "" : "s"} (review them — especially the ⚠):`,
    );
    const nameW = Math.max(...suggestions.map((s) => s.name.length));
    const hostW = Math.max(...suggestions.map((s) => s.host.length));
    for (const s of suggestions) {
      const marker =
        s.confidence === "confident" ? "✓" : `⚠ verify — ${s.reason ?? "double-check"}`;
      console.log(`    ${s.name.padEnd(nameW)} → ${s.host.padEnd(hostW)}  ${marker}`);
    }
  }
  if (skipped.length > 0) {
    console.log(`  left in declare (composite — no single host): ${skipped.join(", ")}`);
  }
}

async function runLearn(
  rule: string,
  wcag: readonly string[],
  fix: string | null,
  source: string,
  dirArg: string,
): Promise<void> {
  // The rule is the FIRST positional; an optional dir may follow it.
  const dir = resolve(dirArg);
  const input: LearnInput = {
    rule,
    wcag: [...wcag],
    fix,
    source,
  };
  const r = await learn(dir, input);
  if (r.added) {
    console.log(`learned "${r.id}" → ${relative(dir, r.contractPath)}`);
  } else {
    console.log(`already known (no-op): "${r.id}"`);
  }
  for (const p of r.blockPaths) console.log(`  block: ${relative(dir, p)}`);
}

async function runGen(check: boolean, dirArg: string): Promise<void> {
  const dir = resolve(dirArg);
  const r = await gen(dir, check);
  if (!r.check) {
    console.log(`a11y-checker gen — ${dir}`);
    for (const p of r.blockPaths) console.log(`  block: ${relative(dir, p)}`);
    return;
  }
  console.log(`a11y-checker gen --check — ${dir}`);
  for (const e of r.entries) {
    console.log(`  ${e.status.toUpperCase().padEnd(8)} ${relative(dir, e.path)}`);
  }
  if (!r.inSync) {
    console.error(
      "DRIFT: the on-disk block differs from binclusive.json — run `a11y-checker gen`.",
    );
    process.exitCode = 1;
  } else {
    console.log("in sync.");
  }
}

// ---------------------------------------------------------------------------
// @effect/cli command tree
// ---------------------------------------------------------------------------
//
// The PARSING + DISPATCH layer. Each subcommand declares its flags/args with
// `@effect/cli` `Options`/`Args`, then its handler parses them and calls the
// matching `runX` runner unchanged. Effect stays ISOLATED to this layer — the
// runners are still plain async functions that own their own `process.exitCode`
// side effects (blocking findings → 1, bad URL → 2), and `NodeRuntime.runMain`
// reads that exit code after a clean run, so the findings-based exit codes the
// CI gate depends on survive untouched.
//
// The runner bodies are wrapped in `Effect.promise` (not `tryPromise`): a runner
// that throws is a genuine bug, and letting it reject surfaces the stack via
// `runMain` exactly as the old top-level `.catch` did.

const dirArg = Args.text({ name: "dir" });
const optionalDir = Args.text({ name: "dir" }).pipe(Args.withDefault("."));

// OPT-IN blocking gate (issue #2134), default OFF. `--fail-on` is a choice over
// the contract's own severity vocabulary (SEVERITY_ORDER) so the flag can never
// name a severity the contract doesn't; both are `optional` (no default) so an
// unset gate is the safe state — findings never fail the check on severity/volume.
const failOnOption = Options.choice("fail-on", SEVERITY_ORDER).pipe(
  Options.optional,
  Options.withDescription(
    "OPT-IN blocking gate (default OFF): fail the check when any finding's severity is at or above this threshold (critical | major | minor). Unset ⇒ non-blocking — findings never fail the check on severity.",
  ),
);
const maxViolationsOption = Options.integer("max-violations").pipe(
  Options.optional,
  Options.withDescription(
    "OPT-IN blocking gate (default OFF): fail the check when the total finding count exceeds N. Unset ⇒ no volume gate.",
  ),
);

/** The `check` command's machine-readable output formats. */
const OUTPUT_FORMATS = ["text", "json", "sarif"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

// `--format` is the CANONICAL output selector (issue #2236) — one flag, one of
// text | json | sarif — the generic `--ci` mode and every CI config point at.
// The legacy `--json` / `--sarif` booleans remain as back-compat aliases (the
// shipped GitHub Action and older docs still pass them); an explicit `--format`
// wins, else the booleans resolve with sarif taking precedence over json, which
// mirrors runCheck's own sarif-over-json precedence.
const formatOption = Options.choice("format", OUTPUT_FORMATS).pipe(
  Options.optional,
  Options.withDescription(
    "Output format: text (human report, default) | json | sarif (SARIF 2.1.0 for code-scanning). Canonical machine-readable selector; --json / --sarif remain as aliases.",
  ),
);

// The generic CI runner mode (issue #2236): NON-BLOCKING by default. The run
// exits 0 even when contract-blocking findings are present, so any CI can emit
// and consume the SARIF/JSON artifact without the check failing. This is a
// first-class engine mode, not a shell `|| true` swallow — opt back into a
// failing exit with --fail-on / --max-violations, which still apply here.
const ciOption = Options.boolean("ci").pipe(
  Options.withDescription(
    "Generic CI runner mode: NON-BLOCKING — always exit 0 even with blocking findings, so any CI/CD can consume the SARIF/JSON artifact without failing the build. Combine with --format sarif|json. Opt into a failing exit via --fail-on / --max-violations.",
  ),
);

/**
 * Resolve the one output format from the canonical `--format` and the legacy
 * `--json` / `--sarif` aliases. Explicit `--format` wins; otherwise sarif > json
 * > text (runCheck applies the same sarif-over-json precedence internally).
 */
function resolveFormat(format: Option.Option<OutputFormat>, json: boolean, sarif: boolean): OutputFormat {
  return Option.getOrElse(format, (): OutputFormat => (sarif ? "sarif" : json ? "json" : "text"));
}

const checkCommand = Command.make(
  "check",
  {
    dir: dirArg,
    json: Options.boolean("json"),
    sarif: Options.boolean("sarif"),
    format: formatOption,
    ci: ciOption,
    runId: Options.text("run-id").pipe(Options.withDefault("local")),
    failOn: failOnOption,
    maxViolations: maxViolationsOption,
  },
  ({ dir, json, sarif, format, ci, runId, failOn, maxViolations }) => {
    const resolved = resolveFormat(format, json, sarif);
    return Effect.promise(() =>
      runCheck(dir, resolved === "json", resolved === "sarif", runId, {}, {
        failOn: Option.getOrNull(failOn),
        maxViolations: Option.getOrNull(maxViolations),
        advisory: ci,
      }),
    );
  },
).pipe(
  Command.withDescription(
    "scan .tsx for a11y findings (--format text|json|sarif, canonical; --json / --sarif aliases; --ci: non-blocking exit-0 runner mode; --run-id names the SARIF run; --fail-on / --max-violations: OPT-IN blocking gate, default off)",
  ),
);

const checkUrlCommand = Command.make(
  "check-url",
  { target: Args.text({ name: "target" }) },
  ({ target }) => Effect.promise(() => runCheckUrl(target)),
).pipe(
  Command.withDescription(
    "render a live URL (or local path) and run axe-core (non-React / source-less pages)",
  ),
);

const checkSwiftCommand = Command.make(
  "check-swift",
  { dir: dirArg },
  ({ dir }) => Effect.promise(() => runCheckSwift(dir)),
).pipe(Command.withDescription("scan .swift for SwiftUI accessibility findings (static)"));

const checkShopifyCommand = Command.make(
  "check-shopify",
  { dir: dirArg, json: Options.boolean("json") },
  ({ dir, json }) => Effect.promise(() => runCheckShopify(dir, json)),
).pipe(
  Command.withDescription(
    "scan .liquid Shopify theme source for structural a11y findings (static, no browser; --json: machine-readable)",
  ),
);

const checkUnityCommand = Command.make(
  "check-unity",
  { dir: dirArg, json: Options.boolean("json") },
  ({ dir, json }) => Effect.promise(() => runCheckUnity(dir, json)),
).pipe(
  Command.withDescription(
    "scan Unity Force-Text scenes (.prefab/.unity) for accessibility findings (static, no browser; --json: machine-readable)",
  ),
);

const initCommand = Command.make(
  "init",
  { suggest: Options.boolean("suggest"), dir: optionalDir },
  ({ suggest, dir }) => Effect.promise(() => runInit(suggest, dir)),
).pipe(
  Command.withDescription(
    "detect stack, write binclusive.json + AGENTS/CLAUDE block (--suggest scaffolds the components map)",
  ),
);

// `--wcag a,b` is one flag carrying a comma list; split it in the option so the
// handler sees an Array (canon: options.md "Comma / repeated value flag", form B).
const wcagOption = Options.text("wcag").pipe(
  Options.map((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== ""),
  ),
  Options.withDefault([] as readonly string[]),
);

const learnCommand = Command.make(
  "learn",
  {
    rule: Args.text({ name: "rule" }),
    wcag: wcagOption,
    fix: Options.text("fix").pipe(Options.optional),
    source: Options.text("source").pipe(Options.withDefault("manual")),
    dir: optionalDir,
  },
  ({ rule, wcag, fix, source, dir }) =>
    Effect.promise(() =>
      runLearn(rule, wcag, Option.getOrNull(fix), source, dir),
    ),
).pipe(Command.withDescription(`record a team rule into binclusive.json and the AGENTS/CLAUDE block`));

const genCommand = Command.make(
  "gen",
  { check: Options.boolean("check"), dir: optionalDir },
  ({ check, dir }) => Effect.promise(() => runGen(check, dir)),
).pipe(Command.withDescription("regenerate the block (--check exits non-zero on drift)"));

const mcpCommand = Command.make("mcp", {}, () =>
  // Lazy so the MCP SDK stays off the static `check` path (issue #2133).
  Effect.promise(() => import("./mcp").then((m) => m.startStdioServer())),
).pipe(
  Command.withDescription("start a local stdio MCP server exposing the checker to MCP clients"),
);

const hookCommand = Command.make("hook", {}, () =>
  Effect.promise(() => runHookCli()),
).pipe(
  Command.withDescription(
    "PostToolUse hook: scan the just-edited .tsx (reads event JSON from stdin)",
  ),
);

// Back-compat: a bare `a11y-checker <dir>` (no subcommand) still runs `check` on
// that dir — the shortcut `origin/main`'s `main()` carried explicitly. The root
// gets an OPTIONAL positional dir + a handler (canon: subcommands.md "the root's
// own handler still runs when no subcommand is given"; args.md optional-arg). A
// supplied dir → runCheck; absent → print the root help/usage. All 10 subcommands
// still bind via withSubcommands and take precedence when a known verb is typed.
const rootDir = Args.text({ name: "dir" }).pipe(Args.optional);

const rootCommand = Command.make("a11y-checker", { dir: rootDir }, ({ dir }) =>
  Option.match(dir, {
    onNone: () => Effect.promise(() => printRootHelp()),
    onSome: (d) => Effect.promise(() => runCheck(d)),
  }),
).pipe(
  Command.withDescription(
    "Local accessibility checker for React/TSX, Swift, and live URLs — grounded in a real-world audit corpus.",
  ),
  Command.withSubcommands([
    checkCommand,
    checkUrlCommand,
    checkSwiftCommand,
    checkShopifyCommand,
    checkUnityCommand,
    initCommand,
    learnCommand,
    genCommand,
    mcpCommand,
    hookCommand,
  ]),
);

/**
 * Turn the root command into a runnable `(argv) => Effect`. Exported so tests
 * can drive a subcommand with a synthetic argv (no process spawn) by providing
 * `NodeContext.layer` themselves — see `.patterns/effect-cli/running.md`
 * ("Running a command in a test (no process)").
 */
export const runCli = Command.run(rootCommand, {
  name: "a11y-checker",
  version: "0.1.0",
});

/**
 * The no-subcommand, no-dir case: print the root help/usage. effect/cli owns the
 * help printer (canon: help.md "you never write a help printer") — so we delegate
 * to the built-in `--help` by re-entering the parser, providing the same Node
 * platform context. This renders the description + the full `COMMANDS` list, the
 * back-compat replacement for `origin/main`'s `console.error(USAGE)`.
 */
function printRootHelp(): Promise<void> {
  return Effect.runPromise(
    runCli(["node", "a11y-checker", "--help"]).pipe(Effect.provide(NodeContext.layer)),
  );
}

/**
 * The published-bin entry point: hand the whole `process.argv` to the parser,
 * provide the Node platform context (FileSystem | Path | Terminal), and let
 * `NodeRuntime.runMain` execute it, wire SIGINT, and set the process exit code.
 * A runner that already set `process.exitCode` (blocking findings → 1, bad URL
 * → 2) keeps it: `runMain` only overrides it on an Effect failure.
 */
export function startCli(argv: readonly string[] = process.argv): void {
  runCli(argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
}

// Run only when invoked directly (the `a11y-checker` bin), not on import — so
// the pure render helpers above stay unit-testable without firing the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  startCli();
}
