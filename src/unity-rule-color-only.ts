/**
 * The Unity "color-only interactive state" rule — a per-widget structural-absence
 * check on the Unity producer (issue #73, child of #66), the Unity analog of the
 * Liquid structural rules in `liquid-rules.ts`.
 *
 * What it flags: a uGUI **Selectable** (Button, Toggle, Slider — any component that
 * carries the Selectable serialization, i.e. an `m_Transition` field) whose
 * `m_Transition` is **`1` (ColorTint)**. ColorTint conveys every interactive state —
 * normal / highlighted / pressed / selected / **disabled** — by COLOR ALONE, with no
 * non-color cue. That is a WCAG 1.4.1 (Use of Color) failure: a state distinguishable
 * only by color is invisible to color-blind and low-vision users and is never surfaced
 * to a screen reader.
 *
 * The `m_Transition` enum (Unity's `Selectable.Transition`):
 *   - `0` None        — no visual state cue at all (a *different* defect, out of scope here)
 *   - `1` ColorTint   — color-only → **finding**
 *   - `2` SpriteSwap  — the sprite (shape) changes per state → non-color cue → silent
 *   - `3` Animation   — an animator drives per-state visuals → non-color cue → silent
 *
 * Why this is the right cheap signal — real-corpus grounding (#66): in
 * `UnityTechnologies/open-project-1` @ 608eac9, **41 of 46 Selectables use
 * `m_Transition: 1`** (~89% prevalence). The transition mode is a single serialized
 * field on the resolved Selectable, so the check is cheap and high-frequency. The
 * real-world frequency is carried, like every other producer's findings, by the
 * corpus enrichment keyed off the WCAG SC (1.4.1) — not by a raw number on the
 * `Finding` itself.
 *
 * Precision invariant (the resolver's law, honored here): we fire ONLY when the
 * Selectable serialization is present AND `m_Transition` is unambiguously `1`. A
 * component with no `m_Transition` is not a Selectable (`transition === null`) and is
 * never touched; an opaque (binary / unparseable) asset contributes no finding rather
 * than a guess. We never flag SpriteSwap/Animation/None — each carries (or deliberately
 * omits) a non-color cue, so flagging it would be the false positive that gets the tool
 * uninstalled.
 *
 * Out of scope (a deeper rule, #66 notes): the contrast-ratio computation of the actual
 * tint colors. This slice flags the *transition mode*, the cheap structural signal.
 *
 * Consumes the `collect-unity` producer's output (the parsed `UnityGraph` per asset),
 * never a re-parse — {@link scanColorOnlyState} walks a {@link UnityScanResult} directly.
 */

import type { Finding } from "./core";
import type { UnityAsset, UnityScanResult } from "./collect-unity";
import type { UnityComponent } from "./unity-ast";

/** This rule's stable id (the `unity/` namespace mirrors `liquid/` rule ids). */
export const COLOR_ONLY_STATE_RULE_ID = "unity/color-only-state" as const;

/** The `m_Transition: 1` value — ColorTint, the color-only state transition. */
const COLOR_TINT = 1;

/** The WCAG Success Criteria this rule maps to: 1.4.1 Use of Color. The corpus
 * enrichment keys off this SC for the real-world frequency signal, exactly as the
 * other producers' findings do. */
const RULE_WCAG: readonly string[] = ["1.4.1"];

/** WCAG SCs for the color-only-state rule (the wcag bridge, analog of
 * `wcagForLiquidRule`). Stable shape: a function so a caller need not import the array. */
export function wcagForColorOnlyState(): readonly string[] {
  return RULE_WCAG;
}

/** What a caller supplies so a finding can be anchored to its asset. The producer's
 * {@link UnityAsset} already carries both fields, so {@link unityColorOnlyStateFindings}
 * accepts it directly. */
export interface ColorOnlyStateContext {
  /** The `.prefab` / `.unity` file the finding is anchored in. */
  readonly file: string;
  /** The asset's parse outcome from the producer (graph, or opaque). */
  readonly parse: UnityAsset["parse"];
}

/** A Selectable is any component that serializes `m_Transition` (`transition !== null`). */
function isSelectable(component: UnityComponent): component is UnityComponent & { transition: number } {
  return component.transition !== null;
}

function makeFinding(file: string): Finding {
  return {
    file,
    // A serialized asset has no meaningful source line for a logical component; the
    // anchor is the file (the asset is the unit), mirroring the axe path's line-0 convention.
    line: 0,
    ruleId: COLOR_ONLY_STATE_RULE_ID,
    message:
      "uGUI Selectable uses ColorTint transition (`m_Transition: 1`) — interactive state " +
      "(highlighted / pressed / selected / disabled) is conveyed by color alone. " +
      "Color-blind and low-vision users, and screen-reader users, get no state cue. " +
      "Use SpriteSwap or an Animation transition to add a non-color cue.",
    wcag: RULE_WCAG,
    // The static floor's default enforcement (the `decideEnforcement` no-contract
    // default is `block`); a Unity producer asset has no per-file config seam yet, so it
    // reports at the floor like the other producers' findings.
    enforcement: "block",
    provenance: "unity",
  };
}

/**
 * Findings for one Unity asset: one finding per ColorTint (`m_Transition: 1`)
 * Selectable in the asset's parsed graph. An opaque asset (binary / unparseable)
 * yields `[]` — opaque is reported by the producer, not guessed at here.
 */
export function unityColorOnlyStateFindings(ctx: ColorOnlyStateContext): Finding[] {
  if (ctx.parse.kind !== "graph") return [];
  const findings: Finding[] = [];
  for (const component of ctx.parse.graph.components.values()) {
    if (isSelectable(component) && component.transition === COLOR_TINT) {
      findings.push(makeFinding(ctx.file));
    }
  }
  return findings;
}

/**
 * Run the color-only-state rule over a whole {@link UnityScanResult} — the entry point
 * a CLI/dispatch would call. Consumes the producer's per-asset parse output directly
 * (no re-parse), and is forgiving: an opaque asset simply contributes nothing.
 */
export function scanColorOnlyState(scan: UnityScanResult): Finding[] {
  const findings: Finding[] = [];
  for (const asset of scan.assets) {
    findings.push(...unityColorOnlyStateFindings(asset));
  }
  return findings;
}
