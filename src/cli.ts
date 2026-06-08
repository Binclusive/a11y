import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectTsx } from "./collect";
import { scanUrl } from "./collect-dom";
import { gen, init, type LearnInput, learn } from "./commands";
import { scan } from "./core";
import { type EnrichedFinding, enrichAll } from "./corpus";
import { runHookCli } from "./hook";
import { startStdioServer } from "./mcp";
import type { ComponentResolution, Coverage } from "./resolve-components";
import type { SuggestResult } from "./suggest";

const TIER_LABEL: Record<EnrichedFinding["corpus"]["tier"], string> = {
  "very-common": "VERY COMMON",
  common: "COMMON",
  occasional: "OCCASIONAL",
  unknown: "UNKNOWN",
};

/**
 * The body of a finding report — everything below the location line. Shared by
 * the source report (`formatFinding`, anchored `file:line`) and the rendered-DOM
 * report (`formatUrlFinding`, anchored on the axe selector) so the corpus
 * cross-ref, fix, and distilled evidence render identically regardless of which
 * collector produced the finding. The `via` tag names the non-structural
 * producers so each one's distinct reach is legible.
 */
function detailLines(f: EnrichedFinding): string[] {
  const scList =
    f.wcag.length > 0 ? f.wcag.map((sc) => `WCAG ${sc}`).join(", ") : "no WCAG mapping";
  const via =
    f.provenance === "enforce"
      ? "  (call-site content check)"
      : f.provenance === "axe"
        ? "  (rendered-DOM / axe)"
        : "";
  const lines = [
    `    rule:   ${f.ruleId}  [${f.enforcement}]${via}`,
    `    wcag:   ${scList}`,
    `    ${f.message}`,
  ];

  // Severity, when known — from axe's runtime impact or the baseline catalog's
  // published default. Shown for both audit and baseline hits.
  if (f.corpus.severity !== null) {
    lines.push(`    severity: ${f.corpus.severity.toUpperCase()}`);
  }

  if (f.corpus.source === "audit") {
    // The moat: real audit-frequency data — org count + frequency tier.
    lines.push(
      `    corpus: [${TIER_LABEL[f.corpus.tier]}] SC ${f.corpus.sc} — ${f.corpus.orgs}/26 orgs`,
      `    fix:    ${f.corpus.fix}`,
    );
    // Distilled per-failure-shape evidence for this SC (when the SC is distilled).
    if (f.corpus.patterns.length > 0) {
      lines.push(`    seen-in-the-wild (distilled, SC ${f.corpus.sc}):`);
      for (const p of f.corpus.patterns) {
        lines.push(`      • [${TIER_LABEL[p.frequencyTier]}] ${p.component} — ${p.failureShape}`);
      }
    }
  } else if (f.corpus.source === "baseline") {
    // Coverage: axe's published per-rule data, NOT audit-frequency data. Make
    // that explicit so it never reads as a moat hit.
    lines.push(`    fix:    ${f.corpus.fix}`);
    if (f.corpus.helpUrl !== null) lines.push(`    ref:    ${f.corpus.helpUrl}`);
    lines.push(`    corpus: baseline rule SC ${f.corpus.sc} (no audit-frequency data yet)`);
  } else {
    // Neither source knows the SC — but never a bare dead-end: surface whatever
    // the finding itself carries (an axe finding still has its runtime helpUrl).
    if (f.corpus.helpUrl !== null) lines.push(`    ref:    ${f.corpus.helpUrl}`);
    lines.push("    corpus: no SC mapping — not in audit-frequency data or the baseline catalog");
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
 * Baseline-only hits — covered by axe's catalog but absent from audit-frequency
 * data — roll up under `BASELINE`, and the truly unmapped under `UNMAPPED`, so
 * the coverage layer is visible without being mistaken for moat data.
 */
function reportTotals(findings: readonly EnrichedFinding[]): {
  readonly lines: readonly string[];
  readonly blocking: number;
} {
  const tierCounts = new Map<string, number>();
  for (const f of findings) {
    const key =
      f.corpus.source === "audit"
        ? TIER_LABEL[f.corpus.tier]
        : f.corpus.source === "baseline"
          ? "BASELINE"
          : "UNMAPPED";
    tierCounts.set(key, (tierCounts.get(key) ?? 0) + 1);
  }
  const rollup = [...tierCounts.entries()].map(([tier, n]) => `${tier}: ${n}`).join("  |  ");
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
  readonly provenance: "jsx-a11y" | "enforce";
  readonly wcag: readonly string[];
  readonly corpus: { readonly tier: string; readonly sc: string | null; readonly orgs: number | null };
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
    readonly byTier: Record<"very-common" | "common" | "occasional" | "unknown", number>;
  };
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

  const byTier: Record<"very-common" | "common" | "occasional" | "unknown", number> = {
    "very-common": 0,
    common: 0,
    occasional: 0,
    unknown: 0,
  };
  for (const f of findings) {
    byTier[f.corpus.tier] += 1;
  }

  const jsonFindings: JsonFinding[] = findings.map((f) => ({
    id: `${f.ruleId}|${relative(root, f.file)}|${f.line}|${f.wcag.join(",")}`,
    file: relative(root, f.file),
    line: f.line,
    ruleId: f.ruleId,
    enforcement: f.enforcement,
    provenance: f.provenance,
    wcag: f.wcag,
    corpus: { tier: f.corpus.tier, sc: f.corpus.sc, orgs: f.corpus.orgs },
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
      byTier,
    },
  };
}

async function runCheck(dir: string, json = false): Promise<void> {
  const root = resolve(dir);
  const files = await collectTsx(root);

  if (json) {
    if (files.length === 0) {
      const report = buildJsonReport(root, 0, { total: 0, declared: 0, registry: 0, traced: 0, opaque: 0, trusted: 0, icons: 0, structural: 0, declare: 0 }, []);
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const result = await scan(files);
    const findings = enrichAll(result.findings);
    const report = buildJsonReport(root, files.length, result.coverage, findings);
    console.log(JSON.stringify(report, null, 2));
    const blocking = findings.filter((f) => f.enforcement === "block").length;
    process.exitCode = blocking > 0 ? 1 : 0;
    return;
  }

  if (files.length === 0) {
    console.log(`No .tsx files under ${root}`);
    return;
  }

  const result = await scan(files);
  const findings = enrichAll(result.findings);

  console.log(`a11y-checker — scanned ${files.length} .tsx file(s) under ${root}\n`);

  // Coverage first — it frames how much of the codebase the findings cover.
  console.log(formatCoverage(result.coverage, result.resolved.resolutions, result.resolved.unresolvedPackages));
  console.log("");

  if (findings.length === 0) {
    console.log("No jsx-a11y violations found.");
    return;
  }

  // Group by file for a readable report.
  const byFile = new Map<string, EnrichedFinding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }

  for (const [file, group] of byFile) {
    console.log(relative(root, file));
    for (const f of group) {
      console.log(formatFinding(f, root));
      console.log("");
    }
  }

  // Tier rollup + enforcement split — the two summary lines every report ends on.
  const totals = reportTotals(findings);
  for (const line of totals.lines) console.log(line);

  // Exit non-zero only when something the contract BLOCKS fired. A scan that
  // surfaces warn-only findings is a clean build by the customer's own policy.
  process.exitCode = totals.blocking > 0 ? 1 : 0;
}

/**
 * The rendered-DOM counterpart to `runCheck`: drive a real browser to the URL,
 * run axe-core against the live page, and report findings anchored on CSS
 * selectors instead of source lines. This is the source-less path — it inspects
 * what actually ships, so it covers non-React pages and anything the static
 * .tsx scan can't see (server-rendered markup, third-party widgets, runtime DOM).
 */
/**
 * Accept a bare filesystem path (`./dist/index.html`) as well as a real URL.
 * If the arg already carries a scheme (`http://`, `https://`, `file://`) pass it
 * through; otherwise it's a local path — resolve it and convert to a `file://`
 * URL so Playwright can navigate to it.
 */
function normalizeTarget(target: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : pathToFileURL(resolve(target)).href;
}

async function runCheckUrl(url: string): Promise<void> {
  const target = normalizeTarget(url);
  console.log(`a11y-checker — rendering ${target} and running axe-core\n`);

  const result = await scanUrl(target);
  const findings = enrichAll(result.findings);

  if (findings.length === 0) {
    console.log("No axe-core violations found.");
    return;
  }

  // Group by axe rule for a readable report — the DOM path has no file to group
  // on (every finding shares the URL), so the ruleId is the natural section key.
  const byRule = new Map<string, EnrichedFinding[]>();
  for (const f of findings) {
    const list = byRule.get(f.ruleId) ?? [];
    list.push(f);
    byRule.set(f.ruleId, list);
  }

  for (const [ruleId, group] of byRule) {
    console.log(ruleId);
    for (const f of group) {
      console.log(formatUrlFinding(f));
      console.log("");
    }
  }

  // Tier rollup + enforcement split — the two summary lines every report ends on.
  const totals = reportTotals(findings);
  for (const line of totals.lines) console.log(line);

  // Exit non-zero only when something the contract BLOCKS fired. A scan that
  // surfaces warn-only findings is a clean build by the customer's own policy.
  process.exitCode = totals.blocking > 0 ? 1 : 0;
}

/**
 * A parsed argv: positionals separated from flags. `valueFlags` are the
 * `--name value` flags that consume the NEXT token as their value — naming
 * them up front is what stops a flag's value (`--wcag 4.1.2`) from being
 * mistaken for a positional. `boolFlags` (e.g. `--check`) consume no value.
 */
interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly bools: ReadonlySet<string>;
}

function parseArgs(args: readonly string[], valueFlags: readonly string[]): ParsedArgs {
  const valueSet = new Set(valueFlags);
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const bools = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === undefined || tok === "" || tok === "--") continue;
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      if (valueSet.has(name)) {
        const next = args[i + 1];
        if (next !== undefined) {
          values.set(name, next);
          i++; // consumed the value — never a positional
        }
      } else {
        bools.add(name);
      }
      continue;
    }
    positionals.push(tok);
  }
  return { positionals, values, bools };
}

async function runInit(args: readonly string[]): Promise<void> {
  const { positionals, bools } = parseArgs(args, []);
  const suggest = bools.has("suggest");
  const dir = resolve(positionals[0] ?? ".");
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
    console.log("  no leaf-primitive components to suggest (all composite or already declared)");
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

async function runLearn(args: readonly string[]): Promise<void> {
  const { positionals, values } = parseArgs(args, ["wcag", "fix", "source"]);
  const rule = positionals[0];
  if (rule === undefined) {
    console.error(
      'usage: a11y-checker learn "<rule text>" [--wcag 4.1.2,1.3.1] [--fix "<code>"] [--source "<who>"] [dir]',
    );
    process.exitCode = 2;
    return;
  }
  // The rule is the FIRST positional; an optional dir may follow it.
  const dir = resolve(positionals[1] ?? ".");
  const wcagRaw = values.get("wcag");
  const input: LearnInput = {
    rule,
    wcag:
      wcagRaw === undefined
        ? []
        : wcagRaw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== ""),
    fix: values.get("fix") ?? null,
    source: values.get("source") ?? "manual",
  };
  const r = await learn(dir, input);
  if (r.added) {
    console.log(`learned "${r.id}" → ${relative(dir, r.contractPath)}`);
  } else {
    console.log(`already known (no-op): "${r.id}"`);
  }
  for (const p of r.blockPaths) console.log(`  block: ${relative(dir, p)}`);
}

async function runGen(args: readonly string[]): Promise<void> {
  const { positionals, bools } = parseArgs(args, []);
  const check = bools.has("check");
  const dir = resolve(positionals[0] ?? ".");
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

const USAGE = `usage:
  a11y-checker check <dir> [--json]              scan .tsx for a11y findings (--json: machine-readable output)
  a11y-checker check-url <url>                   render a live URL and run axe-core (non-React / source-less pages)
  a11y-checker init [--suggest] [dir]           detect stack, write binclusive.json + AGENTS/CLAUDE block (--suggest scaffolds the components map)
  a11y-checker learn "<rule>" [--wcag a,b] [--fix "..."] [--source "..."] [dir]
  a11y-checker gen [--check] [dir]               regenerate the block (--check exits non-zero on drift)
  a11y-checker mcp                               start a local stdio MCP server exposing the checker to MCP clients
  a11y-checker hook                              PostToolUse hook: scan the just-edited .tsx (reads event JSON from stdin)`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  switch (command) {
    case "init":
      return runInit(rest);
    case "learn":
      return runLearn(rest);
    case "gen":
      return runGen(rest);
    case "mcp":
      return startStdioServer();
    case "hook":
      return runHookCli();
    case "check": {
      const parsed = parseArgs(rest, []);
      const dir = parsed.positionals[0];
      if (dir === undefined) {
        console.error("usage: a11y-checker check <dir> [--json]");
        process.exitCode = 2;
        return;
      }
      return runCheck(dir, parsed.bools.has("json"));
    }
    case "check-url": {
      const url = parseArgs(rest, []).positionals[0];
      if (url === undefined) {
        console.error("usage: a11y-checker check-url <url>");
        process.exitCode = 2;
        return;
      }
      return runCheckUrl(url);
    }
    default: {
      // Back-compat: bare `a11y-checker <dir>` still runs check.
      const dir = parseArgs(argv, []).positionals[0];
      if (dir !== undefined) return runCheck(dir);
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
  }
}

// Run only when invoked directly (the `a11y-checker` bin), not on import — so
// the pure render helpers above stay unit-testable without firing the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
