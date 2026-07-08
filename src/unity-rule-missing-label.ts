/**
 * The Unity missing-accessible-label rule — the per-widget structural-absence check
 * that the 3-state label resolver (`unity-label-resolve.ts`, #70) was built to feed
 * (#88, child of epic #87). The Unity analog of the Liquid `*-no-name` rules and the
 * SwiftUI unlabeled-control rule, sitting one altitude up on the resolver's `Absent`
 * state.
 *
 * What it flags: an interactive uGUI widget — a Button / Toggle, or any Selectable —
 * whose accessible label resolves to `Absent` (`resolveUnityLabel(...).kind ===
 * "absent"`), i.e. it carries no text-bearing child at all. A control with no
 * accessible name exposes no name/role to assistive tech: WCAG 1.1.1 (Non-text
 * Content, for the missing name) / 4.1.2 (Name, Role, Value).
 *
 * Precision invariant (ADR 0004, the resolver's law, honored here strictly): we emit
 * ONLY on `Absent`. We emit NOTHING on:
 *   - `static` — a real `m_text` label is present (even an empty literal is a resolved
 *     label state, not an absence).
 *   - `dynamic` — a runtime-localized label (an enabled LocalizeStringEvent with a real
 *     table reference): the visible label is injected at runtime and is NOT statically
 *     knowable, so it is opaque, never flagged. Emitting a false `Absent` here is the
 *     wrong-host-class failure that gets an a11y tool uninstalled (`CLAUDE.md`).
 *   - an opaque / binary asset — no graph to walk, so no finding (opaque is reported by
 *     the producer `scanUnity`, never guessed at here).
 *
 * "Interactive widget" = a GameObject carrying a component whose built-in identity is a
 * control host (`host === "button"`: Button / Toggle) OR a Selectable (any component
 * serializing `m_Transition`). Both are the controls that owe an accessible name. A
 * widget resolved to an opaque/custom component is never treated as interactive (the
 * precision invariant: correct widget or opaque, never wrong-host).
 *
 * Consumes the `collect-unity` producer's output (the parsed `UnityGraph` per asset),
 * never a re-parse — {@link scanMissingLabel} walks a {@link UnityScanResult} directly.
 */

import type { UnityAsset, UnityScanResult } from "./collect-unity";
import { NO_CONTRACT_ENFORCEMENT } from "./config-scan";
import type { Finding } from "./core";
import {
  type UnityComponent,
  type UnityGameObject,
  type UnityGraph,
  resolveComponentIdentity,
} from "./unity-ast";
import { resolveUnityLabel } from "./unity-label-resolve";

/** This rule's stable id (the `unity/` namespace mirrors `liquid/` rule ids). */
export const MISSING_LABEL_RULE_ID = "unity/missing-accessible-label" as const;

/** The WCAG Success Criteria this rule maps to: 1.1.1 Non-text Content (the missing
 * accessible name) and 4.1.2 Name, Role, Value (a control with no exposed name). The
 * corpus enrichment keys off these SCs for the real-world frequency signal, exactly as
 * the other producers' findings do. */
const RULE_WCAG: readonly string[] = ["1.1.1", "4.1.2"];

/** WCAG SCs for the missing-accessible-label rule (the wcag bridge, analog of
 * `wcagForColorOnlyState`). Stable shape: a function so a caller need not import the array. */
export function wcagForMissingLabel(): readonly string[] {
  return RULE_WCAG;
}

/** What a caller supplies so a finding can be anchored to its asset. The producer's
 * {@link UnityAsset} already carries both fields, so {@link unityMissingLabelFindings}
 * accepts it directly — but it also needs the raw source, which the resolver reads for
 * the LocalizeStringEvent fields the L1 AST does not capture. */
export interface MissingLabelContext {
  /** The `.prefab` / `.unity` file the finding is anchored in. */
  readonly file: string;
  /** The asset's parse outcome from the producer (graph, or opaque). */
  readonly parse: UnityAsset["parse"];
  /** The raw Force-Text source the asset was parsed from (the resolver re-reads it for
   * the LocalizeStringEvent dynamic-detection fields). */
  readonly source: string;
}

/**
 * A GameObject is an interactive widget owing an accessible name iff it carries a
 * component resolving to a control host (`button`) OR a Selectable (a component
 * serializing `m_Transition`). A custom/opaque component is never treated as
 * interactive — the precision invariant (correct widget or opaque, never wrong-host).
 */
function isInteractiveWidget(graph: UnityGraph, widget: UnityGameObject): boolean {
  return widget.components.some((component) => isControlHost(graph, component) || isSelectable(component));
}

/** A component whose built-in identity is a control host (`button` — Button / Toggle). */
function isControlHost(graph: UnityGraph, component: UnityComponent): boolean {
  const identity = resolveComponentIdentity(graph, component);
  return identity.kind === "widget" && identity.host === "button";
}

/** A Selectable is any component that serializes `m_Transition` (`transition !== null`). */
function isSelectable(component: UnityComponent): boolean {
  return component.transition !== null;
}

function makeFinding(file: string): Finding {
  return {
    file,
    // A serialized asset has no meaningful source line for a logical widget; the anchor
    // is the file (the asset is the unit), mirroring the color-only rule's convention.
    line: 0,
    ruleId: MISSING_LABEL_RULE_ID,
    message:
      "Interactive uGUI widget has no accessible label — no text-bearing child " +
      "(`TextMeshProUGUI` / `Text`) supplies an accessible name. The control exposes " +
      "no name to assistive technology, so a screen-reader user cannot identify it. " +
      "Add a text child with the control's label, or set the accessible name explicitly.",
    wcag: RULE_WCAG,
    // No per-file contract seam on the Unity path yet ⇒ the no-contract default:
    // advisory, blocking opt-in via the CLI gate flags (ADR 0010).
    enforcement: NO_CONTRACT_ENFORCEMENT,
    provenance: "unity",
  };
}

/**
 * Findings for one Unity asset: one finding per interactive widget whose label resolves
 * to `Absent`. A `static` or `dynamic` label emits nothing (the precision invariant),
 * and an opaque asset (binary / unparseable) yields `[]` — opaque is reported by the
 * producer, not guessed at here.
 */
export function unityMissingLabelFindings(ctx: MissingLabelContext): Finding[] {
  if (ctx.parse.kind !== "graph") return [];
  const graph = ctx.parse.graph;
  const findings: Finding[] = [];
  for (const widget of graph.gameObjects.values()) {
    if (!isInteractiveWidget(graph, widget)) continue;
    if (resolveUnityLabel(graph, widget, ctx.source).kind === "absent") {
      findings.push(makeFinding(ctx.file));
    }
  }
  return findings;
}

/**
 * Run the missing-accessible-label rule over a whole {@link UnityScanResult} — the entry
 * point the aggregator (`unity-findings.ts`) calls. Consumes the producer's per-asset
 * parse output directly (no re-parse), and is forgiving: an opaque asset simply
 * contributes nothing. The raw source is re-read per asset (the resolver needs the
 * LocalizeStringEvent fields the AST does not capture).
 */
export async function scanMissingLabel(scan: UnityScanResult): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const asset of scan.assets) {
    const source = await readAssetSource(asset);
    findings.push(...unityMissingLabelFindings({ file: asset.file, parse: asset.parse, source }));
  }
  return findings;
}

/** Read an asset's raw source for the resolver's dynamic-detection pass. An opaque
 * asset is short-circuited (no graph to resolve), so its source is never read. */
async function readAssetSource(asset: UnityAsset): Promise<string> {
  if (asset.parse.kind !== "graph") return "";
  const { readFile } = await import("node:fs/promises");
  return readFile(asset.file, "utf8");
}
