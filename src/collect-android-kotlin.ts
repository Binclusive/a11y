/**
 * The Compose / Kotlin STATIC collector — the Kotlin lane of the Android producer
 * (ADR 0006), parallel to the SwiftUI collector (`collect-swift.ts`). Like Swift, the
 * analysis lives OUT of process, in a Kotlin/JVM engine (`kotlin/A11yKotlinScan`) that
 * parses `.kt` with the Kotlin compiler frontend (PSI) and applies the static Compose
 * rules (lane 2) and programmatic-View rules (lane 3). We can't run the Kotlin frontend
 * from Node, so this module is the THIN boundary: spawn the engine, read its JSON array
 * from stdout, and map each raw record into a full {@link Finding} carrying the
 * surface-derived `provenance` (`compose` / `android-view`) and the contract-derived
 * enforcement level — exactly the shape `collect-swift.ts` uses.
 *
 * The engine is a Gradle `application`; the fast path is its installed distribution
 * binary (`gradle -p kotlin/A11yKotlinScan installDist` was run once). There is no
 * compile-on-demand fallback: unlike `swift run`, a cold Gradle build is slow and noisy
 * on stdout, so an absent binary is a clear, actionable error rather than a silent
 * minutes-long compile.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contractForFiles, enforcementFor } from "./config-scan";
import type { Finding } from "./core";

/** The rule ids the Kotlin engine emits — the contract with it. Both Android Kotlin
 * surfaces (Compose, lane 2; programmatic Views, lane 3) share the one engine. */
type KotlinRuleId = "compose/icon-button-no-name" | "view/touch-no-performclick";

const KOTLIN_RULE_IDS: ReadonlySet<string> = new Set<KotlinRuleId>([
  "compose/icon-button-no-name",
  "view/touch-no-performclick",
]);

/** One raw finding as the Kotlin engine prints it. Mirrors `Finding.kt` exactly:
 * `{ file, line, ruleId, message, wcag: ["4.1.2"], severity: "serious"|"critical" }`. */
interface KotlinFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: KotlinRuleId;
  readonly message: string;
  readonly wcag: readonly string[];
  readonly severity: "serious" | "critical";
}

/** Which producer a Kotlin-engine rule belongs to — Compose vs programmatic View — so
 * the report tags each finding by its real surface. */
function provenanceFor(ruleId: KotlinRuleId): "compose" | "android-view" {
  return ruleId.startsWith("view/") ? "android-view" : "compose";
}

/** The in-repo location of the Kotlin engine package, resolved relative to this file. */
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/collect-android-kotlin.ts -> <repo>/kotlin/A11yKotlinScan
  return resolve(here, "..", "kotlin", "A11yKotlinScan");
}

/** The installed distribution launcher, or `null` when it hasn't been built yet. */
function engineBinary(): string | null {
  const bin = join(packageRoot(), "build", "install", "A11yKotlinScan", "bin", "A11yKotlinScan");
  return existsSync(bin) ? bin : null;
}

/** Spawn the engine on `dir` and resolve with its raw stdout (the JSON array text). */
function runEngine(binary: string, dir: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(binary, [dir], { stdio: ["ignore", "pipe", "pipe"] });
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
 * malformed record is dropped rather than smuggling untyped data inward — the same
 * discipline `collect-swift.ts` uses at the process boundary.
 */
export function parseKotlinFindings(raw: string): KotlinFinding[] {
  const text = raw.trim();
  if (text === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
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
      typeof r.ruleId === "string" &&
      KOTLIN_RULE_IDS.has(r.ruleId) &&
      typeof r.message === "string" &&
      Array.isArray(r.wcag) &&
      r.wcag.every((w) => typeof w === "string") &&
      (r.severity === "serious" || r.severity === "critical")
    ) {
      out.push({
        file: r.file,
        line: r.line,
        ruleId: r.ruleId as KotlinRuleId,
        message: r.message,
        wcag: r.wcag as readonly string[],
        severity: r.severity,
      });
    }
  }
  return out;
}

/** The result of a Compose `.kt` scan — mirrors `SwiftScanResult`. */
export interface ComposeScanResult {
  readonly root: string;
  readonly findings: readonly Finding[];
  /** True when the engine binary is missing — the CLI surfaces a build hint, the way
   * an unbuilt Swift engine is surfaced, rather than reporting a silent clean scan. */
  readonly engineMissing: boolean;
}

/**
 * Scan `.kt` source under `dir` for static Compose accessibility findings. Shells to the
 * Kotlin engine, parses its JSON, and maps each record into a full {@link Finding} —
 * `provenance: "compose"`, the engine's fields, and the enforcement level the governing
 * `binclusive.json` assigns to the finding's WCAG SC (or `block` with no contract). The
 * engine's `severity` is folded into the message so it survives without widening the
 * `Finding` shape — a pure mirror of `scanSwift`.
 */
export async function scanAndroidKotlin(dir: string): Promise<ComposeScanResult> {
  const root = resolve(dir);
  const binary = engineBinary();
  if (binary === null) return { root, findings: [], engineMissing: true };

  const raw = await runEngine(binary, root);
  const kotlinFindings = parseKotlinFindings(raw);

  const contract = contractForFiles(kotlinFindings.map((f) => f.file));

  const findings: Finding[] = kotlinFindings.map((f) => ({
    file: f.file,
    line: f.line,
    ruleId: f.ruleId,
    message: `[${f.severity}] ${f.message}`,
    wcag: f.wcag,
    enforcement: enforcementFor(f.wcag, contract),
    provenance: provenanceFor(f.ruleId),
  }));

  return { root, findings, engineMissing: false };
}
