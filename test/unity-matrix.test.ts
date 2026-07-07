import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Baseline,
  diffBaseline,
  toBaseline,
  toRepoBaseline,
} from "../experiments/unity-matrix/baseline";
import type { UnityResult } from "../experiments/unity-matrix/run";

/**
 * Coverage for the Unity corpus regression gate (#69) — the SHA-pinned `matrix:check`
 * analog for the Unity producer. The load-bearing behavior is the gate's, not the
 * scan's: the SHA-pinned manifest exists, the producer's opaque accounting is
 * snapshot-faithful (Force-Text → graph, binary → opaque, reported not dropped), and
 * ANY drift vs the committed baseline produces a non-empty delta set (which `check.ts`
 * turns into a non-zero exit). The live clone+scan is exercised by `unity:matrix:run`,
 * not here — these are the deterministic, network-free invariants.
 */

const here = dirname(fileURLToPath(import.meta.url));
const matrixDir = join(here, "..", "experiments", "unity-matrix");

const result = (over: Partial<UnityResult> = {}): UnityResult => ({
  repo: "UnityTechnologies/open-project-1",
  sha: "608eac98df29cd97821a6115cd52dfb9027345b1",
  pinned: true,
  assetsScanned: 533,
  graphCount: 533,
  opaqueBinary: 0,
  opaqueParseError: 0,
  opaqueRate: 0,
  opaqueAssets: [],
  error: null,
  ...over,
});

describe("unity-matrix manifest (SHA-pinned corpus)", () => {
  const manifest = JSON.parse(readFileSync(join(matrixDir, "manifest.json"), "utf8")) as {
    repos: { repo: string; sha: string; uiSystem: string; caveat?: string }[];
  };

  it("lists at least one SHA-pinned repo, seeded on open-project-1 @ 608eac98", () => {
    expect(manifest.repos.length).toBeGreaterThanOrEqual(1);
    const seed = manifest.repos.find((r) => r.repo === "UnityTechnologies/open-project-1");
    expect(seed).toBeDefined();
    expect(seed!.sha).toBe("608eac98df29cd97821a6115cd52dfb9027345b1");
    // every entry is pinned to a full 40-hex sha so the corpus cannot float
    for (const r of manifest.repos) expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("records the open-project-1 correction: a uGUI anchor, NOT a runtime-UI-Toolkit anchor", () => {
    const seed = manifest.repos.find((r) => r.repo === "UnityTechnologies/open-project-1")!;
    expect(seed.uiSystem).toBe("ugui");
    // the .uxml-is-editor-tooling caveat must travel with the entry (AC #5)
    expect(seed.caveat).toMatch(/\.uxml/i);
    expect(seed.caveat).toMatch(/editor/i);
    expect(seed.caveat).toMatch(/ui ?toolkit/i);
  });
});

describe("unity-matrix committed baseline.json", () => {
  it("matches the distilled seed snapshot (533 assets, all graph, 0 opaque)", () => {
    const committed = JSON.parse(readFileSync(join(matrixDir, "baseline.json"), "utf8")) as Baseline;
    const seed = committed["UnityTechnologies/open-project-1"];
    expect(seed).toBeDefined();
    expect(seed.assetsScanned).toBe(533);
    expect(seed.graphCount).toBe(533);
    expect(seed.opaqueBinary).toBe(0);
    expect(seed.opaqueParseError).toBe(0);
    // the bucket invariant: graph + opaque == assetsScanned (no silent drop)
    expect(seed.graphCount + seed.opaqueBinary + seed.opaqueParseError).toBe(seed.assetsScanned);
  });
});

describe("unity-matrix opaque accounting (Force-Text seam, ADR 0004)", () => {
  it("distills binary assets as opaque(binary), never silently skipped", () => {
    const snap = toRepoBaseline(
      result({
        graphCount: 530,
        opaqueBinary: 3,
        opaqueAssets: [
          { file: "Assets/UI/A.prefab", reason: "binary" },
          { file: "Assets/UI/B.prefab", reason: "binary" },
          { file: "Assets/UI/C.prefab", reason: "binary" },
        ],
      }),
    );
    expect(snap.opaqueBinary).toBe(3);
    expect(snap.graphCount + snap.opaqueBinary + snap.opaqueParseError).toBe(snap.assetsScanned);
    expect(snap.opaqueAssets).toHaveLength(3);
  });
});

describe("unity-matrix drift gate (the matrix:check contract)", () => {
  const base = toBaseline({ "UnityTechnologies/open-project-1": result() });

  it("no drift → empty deltas (gate would exit 0)", () => {
    const current = toBaseline({ "UnityTechnologies/open-project-1": result() });
    const { deltas, unchanged } = diffBaseline(current, base);
    expect(deltas).toHaveLength(0);
    expect(unchanged).toBe(1);
  });

  it("an asset newly going opaque → a changed delta (gate would exit non-zero)", () => {
    const current = toBaseline({
      "UnityTechnologies/open-project-1": result({ graphCount: 532, opaqueBinary: 1 }),
    });
    const { deltas } = diffBaseline(current, base);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].kind).toBe("changed");
    expect(deltas[0].graph).toEqual({ before: 533, after: 532 });
    expect(deltas[0].opaqueBinary).toEqual({ before: 0, after: 1 });
  });

  it("assets scanned dropping (silent under-scan) → a changed delta", () => {
    const current = toBaseline({
      "UnityTechnologies/open-project-1": result({ assetsScanned: 500, graphCount: 500 }),
    });
    const { deltas } = diffBaseline(current, base);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].assets).toEqual({ before: 533, after: 500 });
  });

  it("a scan error transition is surfaced", () => {
    const current = toBaseline({
      "UnityTechnologies/open-project-1": result({ error: "clone failed" }),
    });
    const { deltas } = diffBaseline(current, base);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].errorChange).toEqual({ before: null, after: "clone failed" });
  });

  it("a removed / added repo is surfaced as removed / added", () => {
    const removed = diffBaseline(toBaseline({}), base);
    expect(removed.deltas[0].kind).toBe("removed");

    const added = diffBaseline(base, toBaseline({}));
    expect(added.deltas[0].kind).toBe("added");
  });
});
