/**
 * The Jetpack Compose STATIC collector — a 5th producer of {@link Finding}s, the
 * Android-Compose sibling of the SwiftUI collector (`collect-swift.ts`). See ADR
 * 0008: the Compose surface mirrors SwiftUI exactly — an out-of-process engine
 * parses `.kt` source with the Kotlin compiler's PSI and emits the shared
 * `Finding` JSON contract; this module is the thin TS boundary that maps each raw
 * record into a full `Finding` carrying `provenance: "compose"` (the ADR's chosen
 * tag — `Language` is deliberately NOT extended) and the contract-derived
 * enforcement level.
 *
 * The engine lives at `kotlin/A11yKotlinScan/` (a Gradle project). Running it
 * needs the JVM/Gradle toolchain, so two invocation strategies are tried in order,
 * matching the Swift collector's prebuilt-then-fallback shape:
 *   1. the prebuilt `installDist` launcher (`./gradlew installDist` was run once) —
 *      a self-contained script under `build/install/.../bin`, fast, no recompile;
 *   2. `./gradlew run` — a fallback that compiles/launches through the wrapper, so
 *      the collector still works on a checkout where `installDist` hasn't run.
 * Both resolve `java` via the ambient `JAVA_HOME`/PATH; when neither can launch,
 * the toolchain is absent and the scan degrades gracefully (see `runCheckKotlin`).
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contractForFiles, enforcementFor } from "./config-scan";
import type { Finding } from "./core";

/** The Compose static rule id the engine emits — the contract with it (ADR 0008). */
type ComposeRuleId = "compose/image-no-label";

/**
 * One raw finding as the Kotlin engine prints it. Mirrors `Finding.kt` exactly:
 * `{ file, line, ruleId, message, wcag: ["1.1.1"], severity: "serious"|"critical" }`.
 * Validated structurally at the process boundary before it becomes a `Finding`.
 */
interface KotlinFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: ComposeRuleId;
  readonly message: string;
  readonly wcag: readonly string[];
  readonly severity: "serious" | "critical";
}

/**
 * Resolve `dir` to a canonical, symlink-free absolute path — the same namespace
 * the engine emits its `file` paths in (it walks via `java.io.File`, which the
 * caller feeds a real path). Both the engine input and the returned `root` derive
 * from this, so the CLI's `relative(root, …)` agrees with the emitted paths.
 * See `collect-swift.ts` for the full rationale — this is the same seam.
 */
function canonicalRoot(dir: string): string {
  const abs = resolve(dir);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** The in-repo location of the Kotlin Gradle project, resolved relative to this file. */
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/collect-kotlin.ts -> <repo>/kotlin/A11yKotlinScan
  return resolve(here, "..", "kotlin", "A11yKotlinScan");
}

/** The prebuilt `installDist` launcher, or `null` when it hasn't been built yet. */
function installedLauncher(): string | null {
  const bin = join(
    packageRoot(),
    "build",
    "install",
    "A11yKotlinScan",
    "bin",
    "A11yKotlinScan",
  );
  return existsSync(bin) ? bin : null;
}

/**
 * Build the command+args (and cwd) to run the engine against `dir`. Prefers the
 * prebuilt `installDist` launcher; falls back to the `./gradlew run` wrapper so a
 * fresh checkout works without a manual build step (it compiles/launches on first
 * use). The Gradle fallback runs from the package root and is silenced to `-q
 * --console=plain` so only the app's own JSON reaches stdout.
 */
function engineInvocation(dir: string): {
  command: string;
  args: string[];
  cwd: string;
} {
  const pkg = packageRoot();
  const launcher = installedLauncher();
  if (launcher !== null) {
    return { command: launcher, args: [dir], cwd: pkg };
  }
  const gradlew = join(pkg, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  return {
    command: gradlew,
    // `--args=<dir>` passes the scan dir through to the app; `-q --console=plain`
    // keeps Gradle's own task logging off stdout so the JSON array is unpolluted.
    args: ["-q", "--console=plain", "--no-daemon", "run", `--args=${dir}`],
    cwd: pkg,
  };
}

/** Spawn the engine and resolve with its raw stdout (the JSON array text). */
function runEngine(dir: string): Promise<string> {
  const { command, args, cwd } = engineInvocation(dir);
  return new Promise<string>((resolvePromise, reject) => {
    // Pass the ambient env through so the launcher/wrapper resolves `java` via
    // JAVA_HOME/PATH; an absent toolchain surfaces as a spawn `error` (ENOENT) or
    // a non-zero exit, both funneled to the graceful path in `runCheckKotlin`.
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      // ENOENT here means the launcher/`gradlew` itself couldn't be executed
      // (no wrapper, no shell) — the toolchain-absent surface. Give it a clear,
      // one-line message so `runCheckKotlin` can print it verbatim.
      reject(
        new Error(
          `A11yKotlinScan could not be launched (${err.message}). Is the JVM/Gradle toolchain installed (JAVA_HOME set)?`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        reject(
          new Error(
            `A11yKotlinScan exited with code ${code ?? "null"}` +
              (stderr.trim() !== "" ? `:\n${stderr.trim()}` : ""),
          ),
        );
      }
    });
  });
}

/**
 * Boundary-parse the engine's stdout into validated {@link KotlinFinding}s. A
 * malformed record is dropped rather than smuggling untyped data inward — the
 * engine is trusted, but this is the one place its output crosses into TS, so we
 * narrow it explicitly (the `parseSwiftFindings` discipline this mirrors).
 */
export function parseKotlinFindings(raw: string): KotlinFinding[] {
  const text = raw.trim();
  if (text === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // The engine contract is a JSON array on stdout. Non-JSON here means the
    // engine misbehaved (a stray log line, a partial write, a crash banner) —
    // fail loud with a one-line, actionable error rather than let a raw
    // SyntaxError bubble untyped across the boundary.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`A11yKotlinScan produced non-JSON output (${detail})`);
  }
  if (!Array.isArray(data)) return [];
  const out: KotlinFinding[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.file === "string" &&
      typeof r.line === "number" &&
      r.ruleId === "compose/image-no-label" &&
      typeof r.message === "string" &&
      Array.isArray(r.wcag) &&
      r.wcag.every((w) => typeof w === "string") &&
      (r.severity === "serious" || r.severity === "critical")
    ) {
      out.push({
        file: r.file,
        line: r.line,
        ruleId: r.ruleId,
        message: r.message,
        wcag: r.wcag as readonly string[],
        severity: r.severity,
      });
    }
  }
  return out;
}

/**
 * The full output of a Compose scan, parallel to `scanSwift`: the findings plus
 * the canonical, symlink-free `root` the collector actually scanned in. The CLI
 * renders `relative(root, …)` against THIS, so the collector owns its path
 * namespace end-to-end.
 */
export interface KotlinScanResult {
  readonly root: string;
  readonly findings: readonly Finding[];
}

/**
 * Scan `.kt` source under `dir` for static Jetpack Compose accessibility findings.
 *
 * Shells to the Kotlin PSI engine, parses its JSON, and maps each raw record into
 * a full {@link Finding} — `provenance: "compose"`, the engine's `file`/`line`/
 * `ruleId`/`message`/`wcag`, and the enforcement level the governing
 * `binclusive.json` assigns to that finding's WCAG SC (or the no-contract default).
 * The engine's own `severity` is folded into the message so it survives into the
 * report without widening `Finding` — the TS side stays a pure mirror of the
 * SwiftUI collector. A launch/exit failure rejects with a one-line Error, which
 * the CLI handles as the graceful toolchain-absent path.
 */
export async function scanKotlin(dir: string): Promise<KotlinScanResult> {
  const root = canonicalRoot(dir);
  const raw = await runEngine(root);
  const kotlinFindings = parseKotlinFindings(raw);

  // The contract that governs these files, found by walking up from them — the
  // same package-up rule every collector uses. With no `binclusive.json` every
  // finding takes the no-contract default.
  const contract = contractForFiles(kotlinFindings.map((f) => f.file));

  const findings: Finding[] = kotlinFindings.map((f) => ({
    file: f.file,
    line: f.line,
    ruleId: f.ruleId,
    // Carry the engine's severity in the message so the report path (which has
    // no `severity` field) still surfaces it — same shape as `scanSwift`.
    message: `[${f.severity}] ${f.message}`,
    wcag: f.wcag,
    enforcement: enforcementFor(f.wcag, contract),
    provenance: "compose",
  }));

  return { root, findings };
}
