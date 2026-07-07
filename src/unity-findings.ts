/**
 * The Unity finding-emission aggregator (#88, foundation of epic #87) — the single
 * in-process function that turns a scanned Unity project into one canonical `Finding[]`.
 * The `collect-unity` analog of `scanLiquid`/`scanSwift`: every Unity consumer (the
 * future `check-unity` CLI verb #89, the corpus gate #90, the MCP/hook surfaces #92)
 * calls this one function, so there is exactly one place Unity findings are produced and
 * exactly one shape they take (the one-collector-one-shape rule, ADR 0001/0002).
 *
 * It runs `scanUnity` (`collect-unity.ts`) once, then runs the THREE Unity rule sources
 * over the scan and reconciles them onto the shared `core.ts` `Finding` shape:
 *
 *   1. `scanColorOnlyState` (`unity-rule-color-only.ts`) — already returns canonical
 *      `Finding[]`; passed through unchanged.
 *   2. `scanMissingLabel` (`unity-rule-missing-label.ts`) — the new per-widget rule on
 *      the resolver's `Absent` state; already canonical `Finding[]`; passed through.
 *   3. `runUnityBaselineRules` (`unity-rules-baseline.ts`) — returns the project-scoped
 *      `UnityProjectFinding[]` (`line: 0`, `provenance: "unity"`, no `layer`). Adapted to
 *      a canonical `Finding` AT THIS SEAM ({@link adaptProjectFinding}), stamping
 *      `layer: "floor"`. The shared `Finding` / `UnityProjectFinding` types are NOT
 *      widened to force-fit — the field mapping lives at the boundary (epic #87 resolved
 *      question: adapt at the aggregator seam).
 *
 * Every finding the aggregator returns carries `provenance: "unity"` (already on each
 * source) and `layer: "floor"` — Unity findings are deterministic static-floor findings
 * that gate the CLI exit code, exactly like the other producers' floor findings.
 *
 * Forgiving by construction (mirrors `scanUnity` / the other collectors): a missing
 * project dir is an empty scan (`scanUnity` yields no assets; `runUnityBaselineRules`
 * returns `[]` on a non-existent dir), so the whole aggregate is `[]`, never a throw.
 */

import { scanUnity } from "./collect-unity";
import type { Finding } from "./core";
import { scanColorOnlyState } from "./unity-rule-color-only";
import { scanMissingLabel } from "./unity-rule-missing-label";
import { runUnityBaselineRules, type UnityProjectFinding } from "./unity-rules-baseline";

/**
 * Adapt a project-scoped {@link UnityProjectFinding} to the canonical {@link Finding}
 * shape at the aggregator boundary. The two shapes already agree field-for-field on the
 * surface the report reads (`file`, `line`, `ruleId`, `message`, `wcag`, `enforcement`,
 * `provenance`); this stamps the one missing field — `layer: "floor"` — without widening
 * either type. `provenance` is already the `"unity"` literal both shapes share.
 */
function adaptProjectFinding(finding: UnityProjectFinding): Finding {
  return {
    file: finding.file,
    line: finding.line,
    ruleId: finding.ruleId,
    message: finding.message,
    wcag: finding.wcag,
    enforcement: finding.enforcement,
    provenance: finding.provenance,
    layer: "floor",
  };
}

/** Stamp `layer: "floor"` on an already-canonical Unity rule finding (color-only,
 * missing-label). The per-widget rules build the `Finding` shape directly but leave
 * `layer` unset (the floor default); the aggregator makes it explicit so every Unity
 * finding carries the same exit-code-affecting layer tag. */
function asFloor(finding: Finding): Finding {
  return finding.layer === "floor" ? finding : { ...finding, layer: "floor" };
}

/**
 * Aggregate every Unity rule source over a scanned project directory into one flat
 * canonical `Finding[]` (all `provenance: "unity"`, `layer: "floor"`). The single seam
 * the rest of the Unity-wiring epic plugs into.
 *
 *   - per-widget color-only-state findings (`scanColorOnlyState`),
 *   - per-widget missing-accessible-label findings (`scanMissingLabel`),
 *   - project-level baseline findings (`runUnityBaselineRules`, adapted at the seam).
 *
 * A missing/unreadable project dir yields `[]` (an empty scan), never a throw.
 */
export async function collectUnityFindings(dir: string): Promise<Finding[]> {
  const scan = await scanUnity(dir);

  const [colorOnly, missingLabel, baseline] = await Promise.all([
    Promise.resolve(scanColorOnlyState(scan)),
    scanMissingLabel(scan),
    runUnityBaselineRules(dir),
  ]);

  return [
    ...colorOnly.map(asFloor),
    ...missingLabel.map(asFloor),
    ...baseline.map(adaptProjectFinding),
  ];
}
