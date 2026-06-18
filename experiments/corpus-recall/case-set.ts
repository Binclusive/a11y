/**
 * The labelled fixture set for `recall:eval` (RFC Phase 1, §1f).
 *
 * Two families, both grounded in the SAME design-system components so precision
 * is tested under realistic ambiguity (the negatives are not strawmen — they
 * share a Link / IconButton / Select with the positives and differ only in the
 * one fact that makes them clean):
 *
 *   - POSITIVE — code that genuinely exhibits a corpus pattern the static FLOOR
 *     MISSES (a non-floor SC: generic / noisy link text, missing selected-state).
 *     Each carries `expect: [{ patternId, line, wcag }]` — the recall finding the
 *     layer SHOULD surface. Drives the recall number.
 *   - NEGATIVE — a hard decoy that MUST surface zero: a Tooltip-titled IconButton
 *     (G3 name-injecting-wrapper), a FormLabel-wrapped Select (G3 label-ancestor),
 *     a floor-already-caught empty anchor (cross-dedup), or a correctly-named
 *     control (no genuine failure — the calling agent must abstain). Each carries
 *     `clean: true`. The precision spine.
 *
 * The `line`/`patternId` values are pinned to the fixture source — they are the
 * anchors the synthetic AND the later real nominations target. If a fixture moves
 * a line, update it here; the eval reads source verbatim at that line (G2).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the `.tsx` fixtures live, relative to this file. */
const CASES_DIR = fileURLToPath(new URL("./cases", import.meta.url));

/** Absolute path to a fixture under `cases/<family>/<name>.tsx`. */
function fixture(family: "positive" | "negative", name: string): string {
  return resolve(CASES_DIR, family, `${name}.tsx`);
}

/** The corpus failure a POSITIVE fixture should surface (one expected finding). */
export interface ExpectedFinding {
  /** The distilled patternId the recall layer should flag here (closed vocabulary). */
  readonly patternId: string;
  /** The 1-based JSX line the finding anchors to (G2 verbatim-quote line). */
  readonly line: number;
  /** The WCAG SCs the finding asserts (carried onto the recall finding). */
  readonly wcag: readonly string[];
}

/**
 * One labelled fixture. `kind` discriminates the union: a `positive` carries the
 * `expect` it must surface; a `negative` carries `clean: true` and must surface
 * nothing. `id` is the stable key the pluggable nominations map is keyed by.
 *
 * A decoy whose precision fact lives in a wrapper's DEFINITION file (a Radix
 * toggle → `button[role=checkbox]`, a `rendersOwnName` control) needs only the
 * def file to exist on disk next to the call site: the source-tracer follows the
 * `import` and reads it off disk, so the resolved-host suppressors (G3
 * `toggle-role` / `renders-own-name`) fire from the trace — the def need not be
 * an explicit member of the scan list.
 */
export type LabelledCase =
  | {
      readonly id: string;
      readonly file: string;
      readonly kind: "positive";
      readonly expect: readonly ExpectedFinding[];
    }
  | {
      readonly id: string;
      readonly file: string;
      readonly kind: "negative";
      readonly clean: true;
    };

/** A POSITIVE fixture: floor-missed corpus failure the recall layer must catch. */
function positive(name: string, expect: readonly ExpectedFinding[]): LabelledCase {
  return {
    id: `positive/${name}`,
    file: fixture("positive", name),
    kind: "positive",
    expect,
  };
}

/** A NEGATIVE fixture: a hard decoy that must surface zero recall findings. */
function negative(name: string): LabelledCase {
  return {
    id: `negative/${name}`,
    file: fixture("negative", name),
    kind: "negative",
    clean: true,
  };
}

/**
 * The labelled corpus-recall fixture set. ~6 positive + ~6 hard-negative to
 * start; grow it as the corpus distills more non-floor patterns. The order is
 * stable so the aggregate Wilson count is reproducible.
 */
export const CASES: readonly LabelledCase[] = [
  // POSITIVE — non-floor link-text failures (the link HAS content, so the floor
  // stays silent; only the recall layer catches the non-descriptive / noisy name).
  positive("generic-link-text", [{ patternId: "2.4.4-generic-link-text", line: 9, wcag: ["2.4.4"] }]),
  positive("learn-more-link", [{ patternId: "2.4.4-generic-link-text", line: 9, wcag: ["2.4.4"] }]),
  positive("noisy-link-name", [{ patternId: "2.4.4-noisy-or-wrong-name", line: 10, wcag: ["2.4.4"] }]),
  positive("raw-anchor-noisy-name", [
    { patternId: "2.4.4-noisy-or-wrong-name", line: 10, wcag: ["2.4.4"] },
  ]),

  // POSITIVE (Phase-1 certification) — honest, RETRIEVABLE, floor-missed variants
  // of the only patterns the eval certifies: generic / non-descriptive link text
  // and noisy / polluted link names. The app pours a bad NAME into a Link shell the
  // component can't fix. Each verified end-to-end: grounds via R1, floor-clean,
  // survives the G0-G6 verify stack on a correct nomination. The selected/current-
  // state patterns were REMOVED from the eval set: trusted tab/toggle components
  // (e.g. antd `<Tabs>`) self-manage selected state at runtime, so a static
  // selected-state nomination there is a false positive — those fixtures were
  // mislabeled positives. (antd reclassified to a hard negative below.)
  //   generic / non-descriptive link text (present name, useless out of context):
  positive("link-read-more", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-this-link", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-details", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-more-info", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-here-mui", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-click-here-router", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-go-next", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-learn-more-chakra", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-click-mui", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-read-more-router", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-view-more-mui", [{ patternId: "2.4.4-generic-link-text", line: 9, wcag: ["2.4.4"] }]),
  positive("link-see-more-chakra", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-find-out-more-router", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  positive("link-continue-next", [{ patternId: "2.4.4-generic-link-text", line: 8, wcag: ["2.4.4"] }]),
  //   noisy / polluted link name (URL, path, filename, SKU, breadcrumb, "undefined"):
  positive("noisy-cdn-link", [{ patternId: "2.4.4-noisy-or-wrong-name", line: 10, wcag: ["2.4.4"] }]),
  positive("noisy-filename-link", [{ patternId: "2.4.4-noisy-or-wrong-name", line: 10, wcag: ["2.4.4"] }]),
  positive("noisy-https-url-link", [{ patternId: "2.4.4-noisy-or-wrong-name", line: 10, wcag: ["2.4.4"] }]),
  positive("noisy-querystring-link", [{ patternId: "2.4.4-noisy-or-wrong-name", line: 10, wcag: ["2.4.4"] }]),
  positive("noisy-report-filename-link", [{ patternId: "2.4.4-noisy-or-wrong-name", line: 10, wcag: ["2.4.4"] }]),
  positive("noisy-sku-link", [{ patternId: "2.4.4-noisy-or-wrong-name", line: 9, wcag: ["2.4.4"] }]),
  positive("noisy-breadcrumb-link", [{ patternId: "2.4.4-noisy-or-wrong-name", line: 10, wcag: ["2.4.4"] }]),
  positive("noisy-undefined-link", [{ patternId: "2.4.4-noisy-or-wrong-name", line: 9, wcag: ["2.4.4"] }]),
  positive("noisy-path-segment-link", [{ patternId: "2.4.4-noisy-or-wrong-name", line: 10, wcag: ["2.4.4"] }]),
  positive("noisy-catalog-breadcrumb-link", [{ patternId: "2.4.4-noisy-or-wrong-name", line: 10, wcag: ["2.4.4"] }]),

  // NEGATIVE — the precision spine (same components as the positives).
  negative("tooltip-titled-icon-button"), // G3: name-injecting-wrapper on the inner IconButton.
  negative("form-label-wrapped-select"), // G3: label-ancestor on the wrapped Select.
  negative("floor-caught-anchor"), // cross-dedup: the floor already flags the empty <a>.
  negative("named-link"), // correctly named + descriptive — the agent must abstain.
  negative("aria-label-icon-button"), // explicit aria-label — named, the agent must abstain.
  negative("aria-label-social-link"), // explicit aria-label — named, the agent must abstain.
  // NEGATIVE — the S1 RESOLVED-HOST precision cases (the FP class the first eval
  // was blind to). Each call site looks nameless, but the source-tracer follows
  // the import to the wrapper DEFINITION (a sibling .tsx on disk) and resolves it
  // to a suppressed host: a Radix-style toggle (G3 `toggle-role`) and a shadcn
  // control that renders its own name (G3 `renders-own-name`).
  negative("radix-toggle-checkbox"), // G3: resolved toggle-role.
  negative("sr-only-named-control"), // G3: resolved renders-own-name.
  // NEGATIVE (certification expansion) — new hard decoys on the honest patterns,
  // each tripping exactly ONE veto so a nomination there surfaces zero.
  negative("tooltip-titled-link"), // G3: name-injecting-wrapper (titled Tooltip over a Link).
  negative("tooltip-titled-slider"), // G3: name-injecting-wrapper (titled Tooltip over the inner control).
  negative("label-wrapped-slider"), // G3: label-ancestor on the wrapped control.
  negative("radix-switch-toggle"), // G3: resolved toggle-role (button[role=switch]) — selected-state veto.
  negative("sr-named-social-link"), // G3: resolved renders-own-name.
  negative("floor-caught-dialog"), // cross-dedup: the floor already flags the unnamed <Dialog>.
  negative("antd-tabs-self-managed"), // clean: antd Tabs self-manages selected state (auto-selects first pane).
];
