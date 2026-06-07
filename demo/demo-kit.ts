#!/usr/bin/env -S pnpm exec tsx
/**
 * demo-kit — one declarative scenario, three modes.
 *
 *   demo-kit lint   <scenario.json>   prove every step (run in isolation, assert output, exit non-zero on failure)
 *   demo-kit play   <scenario.json>   drive it live (type, run, WAIT for each assertion, then advance)
 *   demo-kit record <scenario.json>   regenerate demo.tape from the scenario and render it with vhs
 *
 * Why it exists — two real failures this prevents:
 *   1. A demo command silently ERRORED while narration claimed success.
 *      → every step carries OUTPUT ASSERTIONS; `lint` fails when a command errors or output doesn't match.
 *   2. A background process mutated the shared fixture the demo read, showing a wrong number.
 *      → `lint` runs fixture-mutating steps against a per-run TEMP COPY, never the shared repo dir.
 *
 * Dependency-light: Node built-ins + child_process only. Shells out to cp -R, vhs.
 */

import {
  cpSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

// ── types (mirror scenario.schema.json) ───────────────────────────────────────
interface Terminal {
  width?: number;
  height?: number;
  theme?: string;
  fontSize?: number;
  typingSpeed?: string;
  padding?: number;
}
interface Expect {
  exit?: number;
  stdoutContains?: string[];
  stdoutNotContains?: string[];
  stdoutRegex?: string;
}
interface Step {
  say?: string[];
  run: string;
  expect?: Expect;
  read?: number;
  hidden?: boolean;
}
interface Act {
  title: string;
  steps: Step[];
}
interface Isolation {
  fixture: string;
  as: string;
}
interface Scenario {
  name: string;
  title: string;
  output?: string;
  terminal?: Terminal;
  workdir?: string;
  shellInit?: string[];
  isolation?: Isolation;
  setup?: Step[];
  teardown?: Step[];
  acts: Act[];
}

// ── ansi ──────────────────────────────────────────────────────────────────────
const A = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};
const c = (code: string, s: string) => `${code}${s}${A.reset}`;

// ── scenario loading + path resolution ────────────────────────────────────────
/** Paths in a scenario are relative to `workdir`, which is relative to the repo root. */
interface Ctx {
  scenario: Scenario;
  repoRoot: string;
  cwd: string; // absolute workdir — cwd for every command
  shellInit: string;
}

function loadScenario(scenarioPath: string): Ctx {
  const abs = resolve(process.cwd(), scenarioPath);
  if (!existsSync(abs)) {
    fail(`scenario not found: ${abs}`);
  }
  const scenario = JSON.parse(readFileSync(abs, "utf8")) as Scenario;
  // The repo root is the workdir resolved against the scenario file's directory.
  // Scenario lives at demo/scenario.json; workdir "." → demo/.. == repo root.
  const scenarioDir = dirname(abs);
  const workdir = scenario.workdir ?? ".";
  const cwd = resolve(scenarioDir, "..", workdir); // scenario is in demo/, repo root is its parent
  const repoRoot = resolve(scenarioDir, "..");
  const shellInit = (scenario.shellInit ?? []).join("\n");
  return { scenario, repoRoot, cwd, shellInit };
}

// ── command execution (shared by lint + play) ─────────────────────────────────
interface RunResult {
  stdout: string; // combined stdout+stderr
  exit: number;
}

/**
 * Run a command in a bash subshell with shellInit sourced and cwd applied.
 * `env` binds the isolation var (e.g. FIX) so the command's `$FIX` expands.
 */
function runCommand(ctx: Ctx, command: string, env: NodeJS.ProcessEnv): RunResult {
  const script = `set -o pipefail\n${ctx.shellInit}\n${command}`;
  const r = spawnSync("bash", ["-c", script], {
    cwd: ctx.cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = (r.stdout ?? "") + (r.stderr ?? "");
  const exit = r.status ?? (r.signal ? 1 : 0);
  return { stdout, exit };
}

// ── assertion evaluation ──────────────────────────────────────────────────────
interface AssertResult {
  ok: boolean;
  reasons: string[];
}

function evalExpect(expect: Expect | undefined, res: RunResult): AssertResult {
  const reasons: string[] = [];
  if (!expect) return { ok: true, reasons };

  if (expect.exit !== undefined && res.exit !== expect.exit) {
    reasons.push(`exit ${res.exit} ≠ expected ${expect.exit}`);
  }
  for (const sub of expect.stdoutContains ?? []) {
    if (!res.stdout.includes(sub)) {
      reasons.push(`missing expected substring: ${JSON.stringify(sub)}`);
    }
  }
  for (const sub of expect.stdoutNotContains ?? []) {
    if (res.stdout.includes(sub)) {
      reasons.push(`found forbidden substring: ${JSON.stringify(sub)}`);
    }
  }
  if (expect.stdoutRegex !== undefined) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(expect.stdoutRegex);
    } catch (e) {
      reasons.push(`invalid stdoutRegex: ${(e as Error).message}`);
    }
    if (re && !re.test(res.stdout)) {
      reasons.push(`stdout did not match regex /${expect.stdoutRegex}/`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ── isolation: temp copy lifecycle ────────────────────────────────────────────
/**
 * In lint mode, copy the fixture to a temp dir OUTSIDE the repo and bind the
 * isolation var to that absolute path. Mutating steps share the one copy within
 * a run. The real repo fixture is never touched. Returns {env, cleanup}.
 *
 * In play/record, the var points at the real fixture (pretty on-screen). Nothing
 * to clean up here; play's teardown handles generated files.
 */
function makeIsolation(
  ctx: Ctx,
  mode: "lint" | "live",
): { env: NodeJS.ProcessEnv; cleanup: () => void; fixPath?: string } {
  const iso = ctx.scenario.isolation;
  if (!iso) return { env: {}, cleanup: () => {} };

  if (mode === "live") {
    // real path, made absolute so $FIX is unambiguous regardless of cwd
    const real = resolve(ctx.repoRoot, iso.fixture);
    return { env: { [iso.as]: real }, cleanup: () => {}, fixPath: real };
  }

  // lint: temp copy outside the repo
  const tmp = mkdtempSync(join(tmpdir(), "demo-kit-fix-"));
  const dest = join(tmp, "fixture");
  cpSync(resolve(ctx.repoRoot, iso.fixture), dest, { recursive: true });
  return {
    env: { [iso.as]: dest },
    cleanup: () => {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
    fixPath: dest,
  };
}

// ── flatten the scenario into a linear step list with labels ──────────────────
interface FlatStep extends Step {
  label: string;
  section?: string; // act title printed before the first step of an act
}

function flatten(scn: Scenario): FlatStep[] {
  const out: FlatStep[] = [];
  (scn.setup ?? []).forEach((s, i) => {
    out.push({ ...s, label: `setup.${i + 1}`, hidden: true });
  });
  scn.acts.forEach((act, ai) => {
    act.steps.forEach((s, si) => {
      out.push({
        ...s,
        label: `act${ai + 1}.${si + 1}`,
        section: si === 0 ? act.title : undefined,
      });
    });
  });
  (scn.teardown ?? []).forEach((s, i) => {
    out.push({ ...s, label: `teardown.${i + 1}`, hidden: true });
  });
  return out;
}

// ── verb: lint ────────────────────────────────────────────────────────────────
function cmdLint(scenarioPath: string): number {
  const ctx = loadScenario(scenarioPath);
  const { env, cleanup } = makeIsolation(ctx, "lint");
  const steps = flatten(ctx.scenario);

  console.log(c(A.bold, `lint ${ctx.scenario.name} — ${steps.length} step(s)`));
  console.log(c(A.dim, `cwd: ${ctx.cwd}`));
  if (ctx.scenario.isolation) {
    console.log(
      c(A.dim, `isolation: $${ctx.scenario.isolation.as} → temp copy of ${ctx.scenario.isolation.fixture}`),
    );
  }
  console.log("");

  let failures = 0;
  try {
    for (const step of steps) {
      if (step.section) console.log(c(A.bold, `  ${step.section}`));
      const res = runCommand(ctx, step.run, env);
      const verdict = evalExpect(step.expect, res);
      if (verdict.ok) {
        console.log(`  ${c(A.green, "PASS")} ${step.label}  ${c(A.dim, step.run)}`);
      } else {
        failures++;
        console.log(`  ${c(A.red, "FAIL")} ${step.label}  ${c(A.dim, step.run)}`);
        for (const reason of verdict.reasons) {
          console.log(`         ${c(A.red, "↳")} ${reason}`);
        }
        // a short output tail helps diagnose
        const tail = res.stdout.trim().split("\n").slice(-6).join("\n         ");
        if (tail) console.log(c(A.dim, `         ── output tail ──\n         ${tail}`));
      }
    }
  } finally {
    cleanup();
  }

  console.log("");
  if (failures === 0) {
    console.log(c(A.green, `✓ all ${steps.length} step(s) passed`));
    return 0;
  }
  console.log(c(A.red, `✗ ${failures} of ${steps.length} step(s) failed`));
  return 1;
}

// ── verb: play ────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseDelayMs(speed: string | undefined, fallback: number): number {
  if (!speed) return fallback;
  const m = /^([0-9]+)(ms|s)$/.exec(speed);
  if (!m) return fallback;
  const n = Number(m[1]);
  return m[2] === "s" ? n * 1000 : n;
}

async function typeOut(text: string, perChar: number): Promise<void> {
  for (const ch of text) {
    process.stdout.write(ch);
    if (perChar > 0) await sleep(perChar);
  }
  process.stdout.write("\n");
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(c(A.dim, "  ⏎ press Enter to continue… "), () => {
      rl.close();
      resolve();
    });
  });
}

async function cmdPlay(scenarioPath: string, manual: boolean): Promise<number> {
  const ctx = loadScenario(scenarioPath);
  const { env, cleanup, fixPath } = makeIsolation(ctx, "live");
  const perChar = parseDelayMs(ctx.scenario.terminal?.typingSpeed, 45);
  const steps = flatten(ctx.scenario);
  const promptStr = c(A.bold + A.cyan, "demo$ ");

  console.log(c(A.bold, ctx.scenario.title));
  console.log("");

  let exitCode = 0;
  try {
    for (const step of steps) {
      if (step.hidden) {
        // run silently
        runCommand(ctx, step.run, env);
        continue;
      }
      if (step.section) console.log("\n" + c(A.bold, `── ${step.section} ──`) + "\n");
      for (const line of step.say ?? []) console.log(c(A.dim, `# ${line}`));

      // type the command (with $FIX shown as the real path for readability)
      process.stdout.write(promptStr);
      const shown = fixPath && ctx.scenario.isolation
        ? step.run.split(`$${ctx.scenario.isolation.as}`).join(fixPath)
        : step.run;
      await typeOut(shown, perChar);

      // execute, waiting for the assertion (poll with timeout) rather than a blind sleep
      const res = await runUntilExpect(ctx, step, env);
      process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : res.stdout + "\n");

      const verdict = evalExpect(step.expect, res);
      if (!verdict.ok) {
        exitCode = 1;
        console.log(c(A.red, `  ✗ assertion not satisfied: ${verdict.reasons.join("; ")}`));
      } else if (step.expect) {
        console.log(c(A.green, `  ✓ verified`));
      }

      if (manual) {
        await waitForEnter();
      } else if (step.read) {
        await sleep(step.read * 1000);
      }
    }
  } finally {
    cleanup();
    cleanGeneratedFixtureFiles(ctx);
  }
  return exitCode;
}

/**
 * Run the command and, if it carries an `expect`, retry until the assertion is
 * satisfied or a timeout elapses — NOT a blind sleep. Commands here are
 * synchronous (the scan completes before returning), so one run normally
 * satisfies the assertion; the poll loop covers slow/warming runs.
 */
async function runUntilExpect(
  ctx: Ctx,
  step: Step,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  const deadline = Date.now() + 30_000;
  let res = runCommand(ctx, step.run, env);
  while (!evalExpect(step.expect, res).ok && Date.now() < deadline) {
    await sleep(500);
    res = runCommand(ctx, step.run, env);
  }
  return res;
}

/** Remove demo-generated files from the real fixture (play mode writes to it). */
function cleanGeneratedFixtureFiles(ctx: Ctx): void {
  const iso = ctx.scenario.isolation;
  if (!iso) return;
  const fix = resolve(ctx.repoRoot, iso.fixture);
  for (const f of ["binclusive.json", "AGENTS.md", "CLAUDE.md"]) {
    try {
      rmSync(join(fix, f), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ── verb: record ──────────────────────────────────────────────────────────────
/**
 * Regenerate demo/demo.tape FROM the scenario, then run vhs. Regenerating the
 * tape from the same spec is the whole point: the live demo and the video can't
 * drift. The on-screen `$FIX` is rewritten to the real fixture path.
 */
function cmdRecord(scenarioPath: string): number {
  const ctx = loadScenario(scenarioPath);
  const iso = ctx.scenario.isolation;
  const fixReal = iso ? resolve(ctx.repoRoot, iso.fixture) : undefined;
  // keep the tape repo-relative & pretty: show demo/sample-app, not the abs path
  const fixShown = iso ? iso.fixture : undefined;

  // Output basename: scenario.output, else the scenario filename stem (drop one
  // extension). Drives demo/<base>.tape, demo/<base>.gif, demo/<base>.mp4 so a
  // second cut never clobbers the main demo's demo.* outputs.
  const stem = basename(scenarioPath).replace(/\.[^.]+$/, "");
  const base = ctx.scenario.output ?? stem;

  const t = ctx.scenario.terminal ?? {};
  const lines: string[] = [];
  const out = (s = "") => lines.push(s);

  out(`# ${base}.tape — GENERATED from ${stem}.json by \`demo-kit record\`. Do not hand-edit.`);
  out(`# Render:  pnpm exec tsx demo/demo-kit.ts record ${scenarioPath}   (writes demo/${base}.gif + demo/${base}.mp4)`);
  out(`# ${ctx.scenario.title}`);
  out("");
  out(`Output demo/${base}.gif`);
  out(`Output demo/${base}.mp4`);
  out("");
  out(`Set Shell "bash"`);
  if (t.theme) out(`Set Theme "${t.theme}"`);
  if (t.fontSize) out(`Set FontSize ${t.fontSize}`);
  if (t.width) out(`Set Width ${t.width}`);
  if (t.height) out(`Set Height ${t.height}`);
  if (t.padding !== undefined) out(`Set Padding ${t.padding}`);
  if (t.typingSpeed) out(`Set TypingSpeed ${t.typingSpeed}`);
  out("");

  // hidden setup: source shellInit, bind the fixture var, clear the screen
  out(`# hidden setup — source the alias, bind the fixture var, clear screen`);
  out(`Hide`);
  for (const init of ctx.scenario.shellInit ?? []) out(typeLine(init));
  if (ctx.scenario.shellInit?.length) out(`Enter`);
  if (iso && fixShown) {
    out(typeLine(`${iso.as}=${fixShown}`));
    out(`Enter`);
  }
  out(typeLine("clear"));
  out(`Enter`);
  out(`Show`);
  out(`Sleep 1s`);
  out("");

  const SCAN_ALLOWANCE_S = 3; // a11y scan / init warm-up time on top of `read`

  for (const act of ctx.scenario.acts) {
    out(`# =============================================================================`);
    out(`# ${act.title}`);
    out(`# =============================================================================`);
    for (const step of act.steps) {
      if (step.hidden) {
        out(`Hide`);
        out(typeLine(step.run));
        out(`Enter`);
        out(`Show`);
        continue;
      }
      for (const line of step.say ?? []) out(`# ${line}`);
      out(typeLine(step.run));
      out(`Sleep 500ms`);
      out(`Enter`);
      const sleepS = (step.read ?? 1) + SCAN_ALLOWANCE_S;
      out(`Sleep ${sleepS}s`);
      out("");
    }
  }

  // teardown / cleanup so the recording (and repo) end clean
  out(`# cleanup generated files so the repo ends clean`);
  out(`Hide`);
  if (iso && fixShown) {
    out(typeLine(`rm -f ${fixShown}/binclusive.json ${fixShown}/AGENTS.md ${fixShown}/CLAUDE.md`));
    out(`Enter`);
  }
  for (const step of ctx.scenario.teardown ?? []) {
    out(typeLine(step.run));
    out(`Enter`);
  }
  out(typeLine("clear"));
  out(`Enter`);
  out(`Show`);

  const tapeRel = join("demo", `${base}.tape`);
  const tapePath = join(ctx.repoRoot, tapeRel);
  writeFileSync(tapePath, lines.join("\n") + "\n");
  console.log(c(A.green, `wrote ${tapePath} (${lines.length} lines)`));

  // run vhs
  console.log(c(A.dim, `running: vhs ${tapeRel}`));
  const r = spawnSync("vhs", [tapeRel], {
    cwd: ctx.repoRoot,
    stdio: "inherit",
  });
  if (r.error) {
    console.log(
      c(
        A.yellow,
        `vhs did not run (${r.error.message}). The tape was regenerated; ` +
          `re-run \`vhs ${tapeRel}\` in an environment where vhs's headless Chrome ` +
          `can reach ttyd over loopback (a sandbox may block it).`,
      ),
    );
    return 0; // tape regen succeeded; rendering is best-effort
  }
  if (r.status !== 0) {
    console.log(
      c(
        A.yellow,
        `vhs exited ${r.status}. The tape regenerated; rendering may be sandbox-blocked ` +
          `(headless Chrome ↔ ttyd loopback). Re-run unsandboxed to render.`,
      ),
    );
    return 0;
  }
  console.log(c(A.green, `✓ rendered demo/${base}.gif + demo/${base}.mp4`));
  return 0;
}

/**
 * Emit a complete VHS `Type` directive for an arbitrary command string.
 *
 * VHS accepts three string delimiters for `Type`: `"`, `'`, and a backtick —
 * but it has NO escape for the delimiter inside its own quotes, so a command
 * that contains the chosen delimiter (e.g. `a11y learn "…"`, or `jq '…'`)
 * breaks the parser. Pick a delimiter the content does NOT contain. Backslashes
 * are still escaped so a literal `\` survives. The common cases — double quotes
 * in the command, or single quotes in a jq/grep/sed filter — never collide
 * because at least one of the three delimiters is always free in practice.
 */
function typeLine(s: string): string {
  const body = s.replace(/\\/g, "\\\\");
  const delim = !s.includes('"') ? '"' : !s.includes("'") ? "'" : "`";
  return `Type ${delim}${body}${delim}`;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function fail(msg: string): never {
  console.error(c(A.red, `error: ${msg}`));
  process.exit(2);
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  demo-kit lint   <scenario.json>           prove every step in isolation",
      "  demo-kit play   <scenario.json> [--manual] drive the demo live",
      "  demo-kit record <scenario.json>           regenerate demo.tape and render with vhs",
    ].join("\n"),
  );
  process.exit(2);
}

// ── entry ─────────────────────────────────────────────────────────────────────
async function main() {
  const [verb, scenarioArg, ...rest] = process.argv.slice(2);
  if (!verb || !scenarioArg) usage();

  switch (verb) {
    case "lint":
      process.exit(cmdLint(scenarioArg));
      break;
    case "play":
      process.exit(await cmdPlay(scenarioArg, rest.includes("--manual")));
      break;
    case "record":
      process.exit(cmdRecord(scenarioArg));
      break;
    default:
      usage();
  }
}

main().catch((e) => {
  console.error(c(A.red, String(e?.stack ?? e)));
  process.exit(2);
});
