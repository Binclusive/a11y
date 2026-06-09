/**
 * The SwiftUI STATIC collector — the 4th producer of {@link Finding}s, parallel
 * to the jsx-a11y structural pass (`core.ts`) and the corpus enforce pass
 * (`enforce.ts`).
 *
 * The accessibility analysis itself lives OUT of process, in a SwiftPM binary
 * (`swift/A11ySwiftScan`) that parses `.swift` source with SwiftSyntax and applies
 * the static rules from `plugin/skills/swiftui-a11y/SKILL.md` — crucially with the
 * ancestor-climb heuristic that stops a label on the enclosing
 * Button/NavigationLink/toolbar item from reading as a false positive. We can't run
 * SwiftSyntax from Node, so this module is the THIN boundary: spawn the engine, read
 * its JSON array from stdout, and map each raw record into a full `Finding` carrying
 * `provenance: "swiftui"` and the contract-derived enforcement level — exactly the
 * external-engine→Finding shape an out-of-process DOM/axe collector would use.
 *
 * Two invocation strategies, tried in order:
 *   1. the prebuilt release binary (`swift build -c release` was run once) — fast,
 *      no compile on every scan;
 *   2. `swift run --package-path …` — a fallback that compiles on first use, so the
 *      collector still works on a machine where the release build hasn't been made.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contractForFiles, enforcementFor } from "./config-scan";
import type { Finding } from "./core";

/** The two SwiftUI static rule ids the engine emits — the contract with it. */
type SwiftRuleId = "swiftui/image-no-label" | "swiftui/control-no-name";

/**
 * One raw finding as the Swift engine prints it. Mirrors `Finding.swift` exactly:
 * `{ file, line, ruleId, message, wcag: ["1.1.1"], severity: "serious"|"critical" }`.
 * Validated structurally at the process boundary before it becomes a `Finding`.
 */
interface SwiftFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: SwiftRuleId;
  readonly message: string;
  readonly wcag: readonly string[];
  readonly severity: "serious" | "critical";
}

/**
 * Resolve `dir` to a canonical, symlink-free absolute path — the same namespace
 * the Swift engine emits its `file` paths in (it walks via macOS `FileManager`,
 * which resolves symlinks). Both the engine input and the `root` returned in
 * {@link SwiftScanResult} derive from this, so the CLI's `relative(root, …)`
 * always agrees with the engine's emitted paths. Falls back to a plain `resolve`
 * when the path doesn't exist yet (the engine then reports the empty scan).
 *
 * Module-private: the canonical root is an INTERNAL namespace decision the
 * collector owns. It is not exported — the CLI receives the root it must render
 * against on {@link SwiftScanResult.root}, so no path helper crosses the seam.
 */
function canonicalRoot(dir: string): string {
  const abs = resolve(dir);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** The in-repo location of the Swift package, resolved relative to this file. */
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/collect-swift.ts -> <repo>/swift/A11ySwiftScan
  return resolve(here, "..", "swift", "A11ySwiftScan");
}

/** The prebuilt release binary path, or `null` when it hasn't been built yet. */
function releaseBinary(): string | null {
  const bin = join(packageRoot(), ".build", "release", "A11ySwiftScan");
  return existsSync(bin) ? bin : null;
}

/**
 * Build the command+args to run the engine against `dir`. Prefers the prebuilt
 * release binary; falls back to `swift run --package-path` so a fresh checkout
 * works without a manual build step (it just compiles on first use).
 */
function engineInvocation(dir: string): { command: string; args: string[] } {
  const bin = releaseBinary();
  if (bin !== null) {
    return { command: bin, args: [dir] };
  }
  return {
    command: "swift",
    // `--` ends `swift run`'s own option parsing so a `dir` that starts with `-`
    // is passed through to the engine as a positional, never read as a flag.
    args: ["run", "-c", "release", "--package-path", packageRoot(), "A11ySwiftScan", "--", dir],
  };
}

/** Spawn the engine and resolve with its raw stdout (the JSON array text). */
function runEngine(dir: string): Promise<string> {
  const { command, args } = engineInvocation(dir);
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        reject(
          new Error(
            `A11ySwiftScan exited with code ${code ?? "null"}` +
              (stderr.trim() !== "" ? `:\n${stderr.trim()}` : ""),
          ),
        );
      }
    });
  });
}

/**
 * Boundary-parse the engine's stdout into validated {@link SwiftFinding}s. A
 * malformed record is dropped rather than smuggling untyped data inward — the
 * engine is trusted, but this is the one place its output crosses into TS, so we
 * narrow it explicitly (the same discipline `corpus.ts` uses at the JSON
 * boundary).
 */
export function parseSwiftFindings(raw: string): SwiftFinding[] {
  const text = raw.trim();
  if (text === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // The engine contract is a JSON array on stdout. Non-JSON here means the
    // engine misbehaved (a stray log line, a partial write, a crash banner) —
    // fail loud with a one-line, actionable error instead of letting a raw
    // SyntaxError bubble untyped across the boundary.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`A11ySwiftScan produced non-JSON output (${detail})`);
  }
  if (!Array.isArray(data)) return [];
  const out: SwiftFinding[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.file === "string" &&
      typeof r.line === "number" &&
      (r.ruleId === "swiftui/image-no-label" || r.ruleId === "swiftui/control-no-name") &&
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
 * The full output of a SwiftUI scan, parallel to `scan`: the findings plus the
 * canonical, symlink-free `root` the collector actually scanned in. The CLI
 * renders `relative(root, …)` against THIS — so the collector owns its path
 * namespace end-to-end and the CLI imports no path helper from here.
 */
export interface SwiftScanResult {
  readonly root: string;
  readonly findings: readonly Finding[];
}

/**
 * Scan `.swift` source under `dir` for static SwiftUI accessibility findings.
 *
 * Shells to the Swift engine, parses its JSON, and maps each raw record into a
 * full {@link Finding} — `provenance: "swiftui"`, the engine's `file`/`line`/
 * `ruleId`/`message`/`wcag`, and the enforcement level the governing
 * `binclusive.json` assigns to that finding's WCAG SC (or `block` with no
 * contract, the historical default). The engine's own `severity` is folded into
 * the message so it survives into the report without widening the `Finding`
 * shape — the TS side stays a pure mirror of the existing collectors.
 */
export async function scanSwift(dir: string): Promise<SwiftScanResult> {
  // Canonicalize: the engine walks the tree via macOS `FileManager`, which
  // resolves symlinks (e.g. `/tmp` → `/private/tmp`), so every emitted `file`
  // is a real path. Feeding it the real root keeps the engine's output and the
  // report's `relative(root, …)` base in the same namespace — otherwise a
  // symlinked root renders broken `../../private/…` paths. We return this `root`
  // so the CLI renders against the exact namespace the engine emitted in.
  const root = canonicalRoot(dir);
  const raw = await runEngine(root);
  const swiftFindings = parseSwiftFindings(raw);

  // The contract that governs these files, found by walking up from them — same
  // package-up rule the jsx-a11y scan uses (`contractForFiles`). With no
  // `binclusive.json` every finding is `block`.
  const contract = contractForFiles(swiftFindings.map((f) => f.file));

  const findings: Finding[] = swiftFindings.map((f) => ({
    file: f.file,
    line: f.line,
    ruleId: f.ruleId,
    // Carry the engine's severity in the message so the existing report path
    // (which has no `severity` field) still surfaces it.
    message: `[${f.severity}] ${f.message}`,
    wcag: f.wcag,
    enforcement: enforcementFor(f.wcag, contract),
    provenance: "swiftui",
  }));

  return { root, findings };
}
