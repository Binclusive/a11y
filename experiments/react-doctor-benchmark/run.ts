/**
 * run.ts — head-to-head a11y benchmark: a11y-checker vs millionco/react-doctor,
 * on the SAME repos, COLD (no init, no manual component declarations).
 *
 * Why this exists. react-doctor also ships an "accessibility" audit, so the
 * question is concrete: on a real design-system app, what does each tool
 * actually surface? This harness clones each target, runs BOTH tools in JSON
 * mode over the same source dir, normalizes their findings to `{file, line,
 * rule}`, and diffs them by call site — so the overlap, each tool's
 * unique-to-it findings, and the coverage gap are measured, not asserted.
 *
 * The two tools resolve components differently, and THAT is the axis under test:
 *   - a11y-checker traces design-system wrappers to their host primitive, so its
 *     rules fire INSIDE `<Input>` / `<Button>` / a shadcn barrel.
 *   - react-doctor is jsx-a11y ported to oxlint: it sees literal `<input>` /
 *     `<a>` only, unless you hand-write `settings['jsx-a11y'].components`.
 * The diff makes that difference legible as a finding count, not a claim.
 *
 * Both tools EXIT NON-ZERO when they find blocking issues — normal, not a
 * failure; we parse stdout regardless of exit code. react-doctor is driven via
 * `npx react-doctor@latest` (network + a one-time oxlint binary download), so
 * the first run is slow; clones live in `.cache/`, results in `results/` (both
 * .gitignored — reproducible from the pinned TARGETS below).
 *
 *   tsx experiments/react-doctor-benchmark/run.ts
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..", "..");
const CLI = join(PLUGIN_ROOT, "src", "cli.ts");
const CACHE_DIR = join(HERE, ".cache");
const RESULTS_DIR = join(HERE, "results");

const CLONE_TIMEOUT_MS = 180_000;
const SCAN_TIMEOUT_MS = 300_000;

/**
 * The benchmark cells. `app` is the project root react-doctor runs in (it needs
 * the package.json to detect the framework); `src` is the .tsx root both tools
 * scan. Both are repo-relative. Add a row to benchmark another repo.
 */
interface Target {
  readonly repo: string;
  readonly branch: string;
  readonly app: string;
  readonly src: string;
}

const TARGETS: readonly Target[] = [
  // Next.js App Router + a hand-vendored shadcn/ui — the shape that exposed the
  // barrel-origin gap and the {...props} content FP. The reference cell.
  { repo: "senchabot-opensource/monorepo", branch: "dev", app: "apps/web", src: "apps/web/src" },
  // A SECOND design system, imported directly (not a local barrel): Google's own
  // ga-dev-tools — MUI v5 + TypeScript, 64 files importing `@mui/material`. Shows
  // react-doctor's wrapper blind spot is not shadcn-specific — it's any design
  // system used as components, which is every design system.
  { repo: "googleanalytics/ga-dev-tools", branch: "main", app: ".", src: "src" },
];

/** One finding, normalized across both tools so they can be diffed by site. */
interface Finding {
  readonly file: string; // repo-src-relative, forward slashes
  readonly line: number;
  readonly rule: string; // leaf rule id (plugin prefix stripped)
}

const slug = (repo: string) => repo.replace("/", "__");
const ruleLeaf = (id: string) => id.split("/").pop() ?? id;
const site = (f: Finding) => `${f.file}:${f.line}`;

/** Shallow-clone repo@branch into `dir`. Reuse the cache if already present. */
function cloneRepo(repo: string, branch: string, dir: string): void {
  if (existsSync(join(dir, ".git"))) return;
  execFileSync(
    "git",
    ["clone", "--depth", "1", "--branch", branch, `https://github.com/${repo}.git`, dir],
    { stdio: "ignore", timeout: CLONE_TIMEOUT_MS },
  );
}

/** The pinned commit of a clone, for the result's provenance. */
function headSha(dir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return "(unknown)";
  }
}

/** Parse `cmd`'s stdout as JSON regardless of exit code (findings ⇒ non-zero). */
function runJson(cmd: string, args: string[], cwd: string): unknown {
  const out = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = out.stdout?.trim() ?? "";
  if (text === "") throw new Error(`${cmd} produced no stdout: ${out.stderr?.slice(0, 300)}`);
  // react-doctor may print a banner before the JSON; slice from the first brace.
  const start = text.indexOf("{");
  return JSON.parse(start > 0 ? text.slice(start) : text);
}

/** a11y-checker over `srcDir`: every finding is an accessibility finding. */
function runOurs(srcDir: string): { findings: Finding[]; coverage: unknown } {
  const report = runJson("npx", ["tsx", CLI, "check", srcDir, "--json"], PLUGIN_ROOT) as {
    findings: Array<{ file: string; line: number; ruleId: string }>;
    coverage: unknown;
  };
  const findings = report.findings.map((f) => ({
    file: f.file.split("\\").join("/"),
    line: f.line,
    rule: ruleLeaf(f.ruleId),
  }));
  return { findings, coverage: report.coverage };
}

/**
 * react-doctor over `appDir`, keeping only `category === "Accessibility"`
 * diagnostics under `srcDir`. Its `filePath` is emitted relative to the cwd it
 * ran in (`appDir`), e.g. `src/components/ui/card.tsx` — though some versions
 * emit absolute paths — so we normalize BOTH forms to a `srcDir`-relative key
 * that aligns with a11y-checker's site keys.
 */
function runReactDoctor(
  appDir: string,
  srcDir: string,
): { a11y: Finding[]; a11yTotal: number; byCategory: Record<string, number> } {
  const report = runJson(
    "npx",
    ["-y", "react-doctor@latest", "--json", "--no-telemetry", "--no-dead-code", "-y", appDir],
    appDir,
  ) as { diagnostics: Array<{ filePath: string; rule: string; category: string; line: number }> };

  const byCategory: Record<string, number> = {};
  for (const d of report.diagnostics) byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;

  // `filePath` is either absolute or relative to `appDir`; reduce to srcDir-rel.
  const appToSrc = relative(appDir, srcDir); // e.g. "src"
  const toSrcRel = (fp: string): string => {
    const rel = isAbsolute(fp) ? relative(srcDir, fp) : relative(appToSrc, fp);
    return rel.split("\\").join("/");
  };

  const a11yAll = report.diagnostics.filter((d) => d.category === "Accessibility");
  const a11y = a11yAll
    .map((d) => ({ file: toSrcRel(d.filePath), line: d.line, rule: ruleLeaf(d.rule) }))
    .filter((f) => !f.file.startsWith("..")); // keep only findings under srcDir
  return { a11y, a11yTotal: a11yAll.length, byCategory };
}

/** Diff two finding sets by call site (`file:line`). */
function compare(ours: Finding[], theirs: Finding[]) {
  const theirSites = new Set(theirs.map(site));
  const ourSites = new Set(ours.map(site));
  const tally = (fs: Finding[]) =>
    Object.fromEntries(
      Object.entries(
        fs.reduce<Record<string, number>>((a, f) => ((a[f.rule] = (a[f.rule] ?? 0) + 1), a), {}),
      ).sort((a, b) => b[1] - a[1]),
    );
  return {
    sharedSites: [...ourSites].filter((s) => theirSites.has(s)).sort(),
    onlyOurs: ours.filter((f) => !theirSites.has(site(f))),
    onlyTheirs: theirs.filter((f) => !ourSites.has(site(f))),
    ourRules: tally(ours),
    theirRules: tally(theirs),
  };
}

function main(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  for (const t of TARGETS) {
    const clone = join(CACHE_DIR, slug(t.repo));
    process.stdout.write(`\n▶ ${t.repo}\n  cloning…\n`);
    try {
      cloneRepo(t.repo, t.branch, clone);
    } catch (e) {
      process.stdout.write(`  ✗ clone failed: ${(e as Error).message}\n`);
      continue;
    }
    const srcDir = join(clone, t.src);
    const appDir = join(clone, t.app);

    process.stdout.write("  a11y-checker…\n");
    const ours = runOurs(srcDir);
    process.stdout.write("  react-doctor (npx, slow first run)…\n");
    const rd = runReactDoctor(appDir, srcDir);

    const cmp = compare(ours.findings, rd.a11y);
    const result = {
      repo: t.repo,
      sha: headSha(clone),
      scanDir: t.src,
      ours: { total: ours.findings.length, coverage: ours.coverage, byRule: cmp.ourRules },
      reactDoctor: {
        a11yTotal: rd.a11yTotal,
        a11yUnderSrc: rd.a11y.length,
        byCategory: rd.byCategory,
        byRule: cmp.theirRules,
      },
      comparison: {
        sharedSites: cmp.sharedSites,
        onlyOurs: cmp.onlyOurs,
        onlyReactDoctor: cmp.onlyTheirs,
      },
    };
    writeFileSync(join(RESULTS_DIR, `${slug(t.repo)}.json`), JSON.stringify(result, null, 2));

    process.stdout.write(
      `  ✓ a11y-checker ${result.ours.total} · react-doctor ${rd.a11yTotal} a11y` +
        ` (${rd.a11y.length} under src) · shared sites ${cmp.sharedSites.length}` +
        ` · only-ours ${cmp.onlyOurs.length} · only-rd ${cmp.onlyTheirs.length}\n`,
    );
  }
  process.stdout.write(`\nWrote results/ — author REPORT.md from these.\n`);
}

main();
