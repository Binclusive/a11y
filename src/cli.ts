import { relative, resolve } from "node:path";
import { collectTsx } from "./collect";
import { gen, init, type LearnInput, learn } from "./commands";
import { scan } from "./core";
import { type EnrichedFinding, enrichAll } from "./corpus";
import { runHookCli } from "./hook";
import { startStdioServer } from "./mcp";
import type { ComponentResolution, Coverage } from "./resolve-components";

const TIER_LABEL: Record<EnrichedFinding["corpus"]["tier"], string> = {
  "very-common": "VERY COMMON",
  common: "COMMON",
  occasional: "OCCASIONAL",
  unknown: "UNKNOWN",
};

function formatFinding(f: EnrichedFinding, root: string): string {
  const where = `${relative(root, f.file)}:${f.line}`;
  const scList =
    f.wcag.length > 0 ? f.wcag.map((sc) => `WCAG ${sc}`).join(", ") : "no WCAG mapping";
  // The enforce check reaches content on opaque/trusted components the
  // structural pass can't see — tag those findings so the recall win is legible.
  const via = f.provenance === "enforce" ? "  (call-site content check)" : "";
  const lines = [
    `  ${where}`,
    `    rule:   ${f.ruleId}  [${f.enforcement}]${via}`,
    `    wcag:   ${scList}`,
    `    ${f.message}`,
  ];
  if (f.corpus.tier === "unknown") {
    lines.push("    corpus: no snapshot match (tier unknown)");
  } else {
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
  }
  return lines.join("\n");
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
function formatCoverage(coverage: Coverage, resolutions: readonly ComponentResolution[]): string {
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
  console.log(formatCoverage(result.coverage, result.resolved.resolutions));
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

  // Tier rollup so the corpus value is visible at a glance.
  const tierCounts = new Map<string, number>();
  for (const f of findings) {
    const key = TIER_LABEL[f.corpus.tier];
    tierCounts.set(key, (tierCounts.get(key) ?? 0) + 1);
  }
  const rollup = [...tierCounts.entries()].map(([tier, n]) => `${tier}: ${n}`).join("  |  ");

  // Enforcement split: `block` findings gate the exit code, `warn` only surface.
  // With no contract every finding is `block`, so the gate is unchanged.
  const blocking = findings.filter((f) => f.enforcement === "block").length;
  const warning = findings.length - blocking;
  console.log(`${findings.length} finding(s)   ${rollup}`);
  console.log(`enforcement: ${blocking} blocking · ${warning} warning`);

  // Exit non-zero only when something the contract BLOCKS fired. A scan that
  // surfaces warn-only findings is a clean build by the customer's own policy.
  process.exitCode = blocking > 0 ? 1 : 0;
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
  const { positionals } = parseArgs(args, []);
  const dir = resolve(positionals[0] ?? ".");
  const r = await init(dir);
  const s = r.contract.stack;
  const router = s.router === null ? "" : ` (${s.router} router)`;
  console.log(`a11y-checker init — ${dir}`);
  console.log(`  stack:       ${s.framework}${router} · ${s.designSystem} · ${s.language}`);
  console.log(`  enforcement: block ${r.contract.enforcement.block.join(", ") || "(none)"}`);
  console.log(`  wrote:       ${relative(dir, r.contractPath)}`);
  for (const p of r.blockPaths) console.log(`  block:       ${relative(dir, p)}`);
  if (r.preservedLearned > 0) {
    console.log(`  preserved:   ${r.preservedLearned} learned rule(s)`);
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
  a11y-checker init [dir]                        detect stack, write binclusive.json + AGENTS/CLAUDE block
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
