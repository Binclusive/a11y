import { basename, join, resolve } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import { type EnrichedFinding, enrichAll } from "../src/evidence";
import { collectUnityFindings } from "../src/unity-findings";

/**
 * End-to-end integration test for the FULL Unity path — the chain tail of epic #87
 * (#91). The per-module unit suites cover each Unity producer/rule/aggregator/renderer
 * in isolation; this test guards the SEAMS BETWEEN them as one chain, on the REAL
 * prefab/project fixture, which no unit test exercises:
 *
 *     producer (scanUnity) → aggregator (collectUnityFindings) → enrich (enrichAll)
 *     → render (buildJsonReport / renderReport via the `check-unity` CLI verb)
 *
 * Two altitudes are driven, against the SAME `test/fixtures/unity-project/` fixture
 * (the real open-project-1 Button / ButtonNoLabel / LocalizedButton / Binary prefabs):
 *
 *   1. The in-process chain: `collectUnityFindings` → `enrichAll`, asserting the exact
 *      enriched-finding set end-to-end — the right rule ids on the right assets, each
 *      carrying `provenance: "unity"`, `layer: "floor"`, the correct WCAG SC, and the
 *      corpus enrichment (audit tier/orgs where applicable).
 *   2. The `check-unity` CLI verb (text + `--json` + exit code), driven exactly the way
 *      `cli-commands.test.ts` drives `check-shopify` / `check-swift` — proving the
 *      shared renderer / JSON contract is not bypassed and that blocking floor findings
 *      gate the exit code (exit 1).
 *
 * THE HIGHEST-VALUE ASSERTION — the precision invariant end-to-end (ADR 0004, the
 * resolver's law): through the FULL pipeline, the labelless button is the ONLY asset
 * that produces a `unity/missing-accessible-label` finding. The localized button
 * (a runtime LocalizeStringEvent → DYNAMIC label) and the binary/opaque asset produce
 * NONE — a false `Absent` must not survive the wired path. If the integration ever
 * regressed to flag the dynamic or opaque cases, this test fails where the per-rule
 * unit tests (which feed the rule a hand-built graph) could not see it.
 */

const FIXTURE = resolve(join(__dirname, "fixtures", "unity-project"));

const MISSING_LABEL = "unity/missing-accessible-label";
const COLOR_ONLY = "unity/color-only-state";
const NO_SR = "unity/no-screen-reader-support";
const NO_REBIND = "unity/no-input-rebinding";

/** The assets the precision invariant must EXCLUDE from a missing-label finding. */
const DYNAMIC_LABEL_ASSET = "LocalizedButton.prefab";
const OPAQUE_ASSET = "Binary.prefab";
const LABELLESS_ASSET = "ButtonNoLabel.prefab";
const STATIC_LABEL_ASSET = "Button.prefab";

/** `provenance: "unity"`, `layer: "floor"` on every aggregated finding. */
const isUnityFloor = (f: EnrichedFinding): boolean =>
  f.provenance === "unity" && (f.layer ?? "floor") === "floor";

describe("Unity E2E: producer → aggregator → enrich → render on the real fixture", () => {
  describe("in-process chain: collectUnityFindings → enrichAll", () => {
    it("emits exactly the expected enriched findings end-to-end (no mocked seams)", async () => {
      const enriched = enrichAll(await collectUnityFindings(FIXTURE));

      // Every aggregated finding is a Unity static-floor finding (gates the exit code).
      expect(enriched.length).toBeGreaterThan(0);
      expect(enriched.every(isUnityFloor)).toBe(true);

      // Index by `basename(file)::ruleId` so the per-asset rule firing is checkable.
      const fired = new Set(enriched.map((f) => `${basename(f.file)}::${f.ruleId}`));

      // color-only-state fires on every ColorTint (m_Transition: 1) Selectable — all
      // three text prefabs carry it.
      expect(fired.has(`${STATIC_LABEL_ASSET}::${COLOR_ONLY}`)).toBe(true);
      expect(fired.has(`${LABELLESS_ASSET}::${COLOR_ONLY}`)).toBe(true);
      expect(fired.has(`${DYNAMIC_LABEL_ASSET}::${COLOR_ONLY}`)).toBe(true);

      // The project-level baseline rules each fire once, anchored on the project root
      // (the fixture has no .cs / .inputactions, so both absence rules trigger).
      const baseline = enriched.filter(
        (f) => f.ruleId === NO_SR || f.ruleId === NO_REBIND,
      );
      expect(baseline.map((f) => f.ruleId).sort()).toEqual([NO_REBIND, NO_SR]);
      expect(baseline.every((f) => f.line === 0)).toBe(true);
      expect(baseline.every((f) => basename(f.file) === "unity-project")).toBe(true);
    });

    it("carries the correct WCAG SCs per rule end-to-end", async () => {
      const enriched = enrichAll(await collectUnityFindings(FIXTURE));
      const wcagFor = (ruleId: string): readonly string[] => {
        const f = enriched.find((x) => x.ruleId === ruleId);
        expect(f, `expected a ${ruleId} finding`).toBeDefined();
        return f!.wcag;
      };

      expect(wcagFor(MISSING_LABEL)).toEqual(["1.1.1", "4.1.2"]);
      expect(wcagFor(COLOR_ONLY)).toEqual(["1.4.1"]);
      expect(wcagFor(NO_SR)).toEqual(["1.3.1", "4.1.2"]);
      expect(wcagFor(NO_REBIND)).toEqual(["2.1.1", "2.5.1"]);
    });

    it("attaches baseline enrichment keyed off the WCAG SC (ADR 0041 §G — no corpus)", async () => {
      const enriched = enrichAll(await collectUnityFindings(FIXTURE));

      // The missing-label finding resolves to baseline coverage on its first known
      // SC (1.1.1). No frequency tier is carried anywhere — the corpus left the engine.
      const missing = enriched.find((f) => f.ruleId === MISSING_LABEL);
      expect(missing).toBeDefined();
      expect(missing!.corpus.source).toBe("baseline");
      expect(missing!.corpus).not.toHaveProperty("tier");
      if (missing!.corpus.source === "baseline") {
        expect(missing!.corpus.sc).toBe("1.1.1");
      }

      // The project-level rules likewise enrich off the baseline catalog.
      for (const ruleId of [NO_SR, NO_REBIND]) {
        const f = enriched.find((x) => x.ruleId === ruleId);
        expect(f, ruleId).toBeDefined();
        expect(["baseline", "none"]).toContain(f!.corpus.source);
      }

      // color-only (1.4.1) is covered by the baseline catalog — enrichment still
      // resolves an SC, never UNMAPPED.
      const colorOnly = enriched.find((f) => f.ruleId === COLOR_ONLY);
      expect(colorOnly).toBeDefined();
      expect(colorOnly!.corpus.source).toBe("baseline");
      if (colorOnly!.corpus.source === "baseline") {
        expect(colorOnly!.corpus.sc).toBe("1.4.1");
      }
    });

    it(
      "LOCKS the precision invariant end-to-end: missing-label ONLY on the labelless " +
        "button — never the dynamic (LocalizeStringEvent) or opaque (binary) asset (ADR 0004)",
      async () => {
        const enriched = enrichAll(await collectUnityFindings(FIXTURE));

        const missingLabelAssets = enriched
          .filter((f) => f.ruleId === MISSING_LABEL)
          .map((f) => basename(f.file));

        // The genuinely-labelless button IS flagged...
        expect(missingLabelAssets).toContain(LABELLESS_ASSET);

        // ...and it is the ONLY asset flagged. A false Absent on the dynamic or opaque
        // case (the wrong-host-class failure that gets an a11y tool uninstalled) must
        // not survive the full producer → aggregator → enrich path.
        expect(missingLabelAssets).toEqual([LABELLESS_ASSET]);
        expect(missingLabelAssets).not.toContain(DYNAMIC_LABEL_ASSET);
        expect(missingLabelAssets).not.toContain(OPAQUE_ASSET);
        expect(missingLabelAssets).not.toContain(STATIC_LABEL_ASSET);
      },
    );
  });

  describe("check-unity CLI verb: render path end-to-end", () => {
    beforeEach(() => {
      process.exitCode = undefined;
    });

    it("text report renders the missing-label finding via the shared renderer", async () => {
      const { stdout, exit, exitCode } = await runVerb(["check-unity", FIXTURE]);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(stdout).toContain("scanning Unity Force-Text scenes");
      expect(stdout).toContain(MISSING_LABEL);
      expect(stdout).toContain(COLOR_ONLY);
      // No binclusive.json ⇒ advisory floor findings (ADR 0010) → exit 0, the same
      // first-run semantics as the other verbs. Blocking is opt-in (gate flags).
      expect(exitCode ?? 0).toBe(0);
    });

    it("--json emits the shared report schema and enriched Unity findings", async () => {
      const { stdout, exit, exitCode } = await runVerb(["check-unity", FIXTURE, "--json"]);
      expect(Exit.isSuccess(exit)).toBe(true);

      const report = JSON.parse(stdout);

      // Same machine schema as check-shopify --json: tool tag + zeroed coverage (Unity
      // has no component resolver) — proves the shared buildJsonReport is not bypassed.
      expect(report.tool).toBe("a11y-checker");
      expect(report.coverage.total).toBe(0);
      expect(Array.isArray(report.findings)).toBe(true);
      expect(report.findings.length).toBeGreaterThan(0);

      // Every JSON finding is Unity-provenance and carries the canonical Finding fields
      // the shared contract exposes (id/file/line/ruleId/enforcement/wcag/evidence).
      expect(report.findings.every((f: { provenance: string }) => f.provenance === "unity")).toBe(
        true,
      );
      for (const f of report.findings) {
        expect(typeof f.id).toBe("string");
        expect(typeof f.ruleId).toBe("string");
        expect(Array.isArray(f.wcag)).toBe(true);
        // The evidence sub-object carries source + sc (no frequency tier — ADR 0041 §G).
        expect(f.evidence).toHaveProperty("source");
        expect(f.evidence).toHaveProperty("sc");
        expect(f.evidence).not.toHaveProperty("tier");
      }

      // The missing-label finding surfaces with its baseline enrichment on SC 4.1.2.
      const ml = report.findings.find(
        (f: { ruleId: string }) => f.ruleId === MISSING_LABEL,
      );
      expect(ml).toBeDefined();
      expect(ml.wcag).toEqual(["1.1.1", "4.1.2"]);
      expect(ml.evidence.source).toBe("baseline");
      expect(ml.evidence.sc).toBe("1.1.1");

      // No binclusive.json ⇒ advisory floor findings (ADR 0010): reported, not
      // blocking, so the first-run scan exits 0. Blocking is opt-in (gate flags).
      expect(report.summary.findings).toBeGreaterThan(0);
      expect(report.summary.blocking).toBe(0);
      expect(exitCode ?? 0).toBe(0);
    });

    it(
      "--json output LOCKS the precision invariant through the rendered report: the " +
        "missing-label finding anchors ONLY on the labelless button",
      async () => {
        const { stdout, exit } = await runVerb(["check-unity", FIXTURE, "--json"]);
        expect(Exit.isSuccess(exit)).toBe(true);

        const report = JSON.parse(stdout);
        const missingLabelFiles: string[] = report.findings
          .filter((f: { ruleId: string }) => f.ruleId === MISSING_LABEL)
          .map((f: { file: string }) => basename(f.file));

        // The false-Absent guard holds all the way out to the JSON the consumer reads.
        expect(missingLabelFiles).toEqual([LABELLESS_ASSET]);
        expect(missingLabelFiles).not.toContain(DYNAMIC_LABEL_ASSET);
        expect(missingLabelFiles).not.toContain(OPAQUE_ASSET);
        expect(missingLabelFiles).not.toContain(STATIC_LABEL_ASSET);
      },
    );
  });
});

/**
 * Drive the root `@effect/cli` command with `args` (verb + flags), capturing stdout —
 * the same no-process recipe `cli-commands.test.ts` uses for the other `check-*` verbs
 * (`.patterns/effect-cli/running.md`). The first two argv slots stand in for the
 * `node` + script path that `Command.run` strips.
 */
async function runVerb(args: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  exit: Exit.Exit<void, unknown>;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    out.push(a.join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
    err.push(a.join(" "));
  });
  process.exitCode = undefined;
  try {
    const exit = await Effect.runPromiseExit(
      runCli(["node", "a11y-checker", ...args]).pipe(Effect.provide(NodeContext.layer)),
    );
    return { stdout: out.join("\n"), stderr: err.join("\n"), exitCode: process.exitCode, exit };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}
