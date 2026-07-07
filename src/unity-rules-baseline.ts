/**
 * The Unity PROJECT-LEVEL structural-absence rule set (#72, child of #66) — the
 * cheapest, highest-frequency negative findings for a Unity game, the analog of the
 * Liquid structural-absence rules (`liquid-rules.ts`, #47/L2) one altitude up.
 *
 * Where the Liquid/uGUI rules are PER-WIDGET (one finding per offending node), these
 * are WHOLE-PROJECT checks: each scans the entire pinned checkout once and emits ONE
 * project-scoped finding, anchored on the project root, not a per-file flood. Two
 * rules ship here:
 *
 *   1. `unity/no-screen-reader-support` — zero references to the hand-authored
 *      `UnityEngine.Accessibility` surface (`AccessibilityHierarchy` /
 *      `AccessibilityNode` / `AssistiveSupport`) anywhere in the project's `.cs`
 *      sources. Unity auto-bridges nothing into an accessibility tree for either uGUI
 *      or UI Toolkit, so absence = "the game is unusable with a screen reader." This
 *      is grounded: `UnityTechnologies/open-project-1` @ 608eac9 has zero such
 *      references across the whole repo (#66 ground truth).
 *   2. `unity/no-input-rebinding` — no `.inputactions` asset anywhere AND no
 *      `PerformInteractiveRebinding` call in `.cs`, i.e. no path for a player to
 *      remap controls (a WCAG-relevant motor-accessibility gap).
 *
 * Each rule maps to a WCAG SC via the bridge below (the analog of
 * `liquid-rules.ts`'s `RULE_WCAG` and `wcag-tags.ts`), and emits a
 * {@link UnityProjectFinding} that mirrors the canonical `Finding` shape (file, line,
 * ruleId, message, wcag, enforcement, provenance) so the future corpus harness (#69)
 * and report can treat it uniformly. This module is intentionally SELF-CONTAINED and
 * is not yet wired into any shared CLI/dispatch — that wiring is a separate child.
 *
 * Forgiving by construction (mirrors `scanUnity`): a missing project dir is an empty
 * scan (no findings, never a throw), and one unreadable file never aborts the walk.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EnforcementLevel } from "./config-scan";

/**
 * Build/library dirs that are not project source — skipped on the walk, mirroring
 * `collect-unity.ts`'s `SKIP_DIRS`. `Library` and `Temp` are Unity's generated
 * caches; an Accessibility reference that lives only in a generated cache is not the
 * project authoring screen-reader support, so excluding them keeps the rule honest.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  "Library",
  "Temp",
  "obj",
]);

/**
 * A project-scoped accessibility finding. Mirrors the canonical `Finding` shape
 * (`core.ts`) field-for-field on the surface the report and enforcement gate read —
 * but is self-contained to this module (no import of `Finding`) so its file surface
 * stays disjoint from the sibling per-widget Unity rules until a later child wires a
 * shared dispatch. `provenance` is the fixed literal `"unity"`, the producer tag the
 * Unity static pass carries; `line` is `0` because a whole-project finding has no
 * single source line (it is anchored on the project root in `file`).
 */
export interface UnityProjectFinding {
  /** The project root directory the finding is scoped to (absolute, resolved). */
  readonly file: string;
  /** Always `0` — a project-level finding has no single source line. */
  readonly line: 0;
  /** This rule's stable id (e.g. `unity/no-screen-reader-support`). */
  readonly ruleId: string;
  /** Human-readable description of the absence and its accessibility impact. */
  readonly message: string;
  /** The WCAG success criteria this rule maps to (via {@link wcagForUnityRule}). */
  readonly wcag: readonly string[];
  /** The enforcement level for this finding (defaults to `block`). */
  readonly enforcement: EnforcementLevel;
  /** The producer tag — always `"unity"` for the Unity static pass. */
  readonly provenance: "unity";
}

/**
 * The WCAG SC bridge: each Unity project-rule id → its success criteria. The analog
 * of `liquid-rules.ts`'s `RULE_WCAG` (our rule ids are our own, so the mapping is
 * direct). A no-screen-reader-support gap breaks Name/Role/Value (4.1.2) — controls
 * expose no name/role to assistive tech — and Info-and-Relationships (1.3.1); a
 * no-rebinding gap is the motor-accessibility floor, Keyboard (2.1.1) and Pointer
 * Gestures / single-pointer remappability (2.5.1).
 */
const RULE_WCAG: Readonly<Record<string, readonly string[]>> = {
  "unity/no-screen-reader-support": ["1.3.1", "4.1.2"],
  "unity/no-input-rebinding": ["2.1.1", "2.5.1"],
};

/** WCAG SCs for a Unity project-rule id (empty if unknown — never throws). */
export function wcagForUnityRule(ruleId: string): readonly string[] {
  return RULE_WCAG[ruleId] ?? [];
}

/** Build a project-scoped finding with its rule's WCAG mapping pre-attached. */
function makeFinding(
  root: string,
  ruleId: string,
  message: string,
  enforcement: EnforcementLevel,
): UnityProjectFinding {
  return {
    file: root,
    line: 0,
    ruleId,
    message,
    wcag: RULE_WCAG[ruleId] ?? [],
    enforcement,
    provenance: "unity",
  };
}

/** File extensions the project-level scan inspects, by concern. */
const CS_EXTENSION = ".cs";
const INPUTACTIONS_EXTENSION = ".inputactions";

/**
 * Any reference to the hand-authored `UnityEngine.Accessibility` module surface.
 * Word-boundary anchored so an unrelated identifier that merely contains the substring
 * is not a false match. These three types are the load-bearing surface a project must
 * touch to register a screen-reader accessibility tree.
 *
 * Deliberately conservative: a match anywhere in `.cs` source — including a comment —
 * is treated as a (present) reference, so the absence rule UNDER-reports rather than
 * risk a false positive. A false "no screen-reader support" on a project that does
 * author it is the failure mode that gets the tool uninstalled (the precision
 * invariant the Liquid rules share); under-reporting on a project that only *mentions*
 * the API in a comment is the safe direction.
 */
const ACCESSIBILITY_API_RE = /\b(AccessibilityHierarchy|AccessibilityNode|AssistiveSupport)\b/;

/** The Input System call that drives interactive control rebinding. */
const REBINDING_API_RE = /\bPerformInteractiveRebinding\b/;

/** What the one-pass project walk gathers — the evidence both rules reason over. */
interface ProjectEvidence {
  /** True if any non-skipped `.cs` references the `UnityEngine.Accessibility` surface. */
  hasAccessibilityRef: boolean;
  /** True if any `.inputactions` asset exists outside the skipped dirs. */
  hasInputActionsAsset: boolean;
  /** True if any non-skipped `.cs` calls `PerformInteractiveRebinding`. */
  hasRebindingCall: boolean;
}

/**
 * One forgiving recursive walk gathering the evidence both rules need. Skips the
 * generated-cache dirs (`SKIP_DIRS`), reads each `.cs` once for both string probes,
 * and notes the presence of any `.inputactions` asset. A missing/unreadable directory
 * yields the empty evidence rather than throwing; one unreadable file is skipped, not
 * fatal — the same forgiving contract `scanUnity` gives the CLI.
 *
 * Short-circuits each probe once satisfied: once all three signals are positive the
 * walk can stop reading file contents (it still need not, but avoids needless I/O).
 */
async function gatherEvidence(dir: string, evidence: ProjectEvidence): Promise<void> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await gatherEvidence(full, evidence);
      continue;
    }
    if (!entry.isFile()) continue;

    if (entry.name.endsWith(INPUTACTIONS_EXTENSION)) {
      evidence.hasInputActionsAsset = true;
      continue;
    }
    if (entry.name.endsWith(CS_EXTENSION)) {
      // Only read if a probe still needs an answer — once both `.cs` signals are
      // positive, file contents can't change the verdict.
      if (evidence.hasAccessibilityRef && evidence.hasRebindingCall) continue;
      let source: string;
      try {
        source = await readFile(full, "utf8");
      } catch {
        continue; // one unreadable file never aborts the scan
      }
      if (!evidence.hasAccessibilityRef && ACCESSIBILITY_API_RE.test(source)) {
        evidence.hasAccessibilityRef = true;
      }
      if (!evidence.hasRebindingCall && REBINDING_API_RE.test(source)) {
        evidence.hasRebindingCall = true;
      }
    }
  }
}

/** Options for the project-level scan; `enforcement` defaults to `block`. */
export interface UnityBaselineOptions {
  readonly enforcement?: EnforcementLevel;
}

/**
 * Run the Unity project-level structural-absence rules over a whole project directory,
 * returning the project-scoped findings (zero, one, or two). The single entry point
 * the future corpus harness (#69) calls per project.
 *
 *   - `unity/no-screen-reader-support` fires iff NO `.cs` references the
 *     `UnityEngine.Accessibility` surface anywhere in the project.
 *   - `unity/no-input-rebinding` fires iff the project has NEITHER a `.inputactions`
 *     asset NOR a `PerformInteractiveRebinding` call (either present → silent).
 *
 * A missing directory yields `[]` (an empty scan), never a throw.
 */
export async function runUnityBaselineRules(
  dir: string,
  options: UnityBaselineOptions = {},
): Promise<UnityProjectFinding[]> {
  const root = resolve(dir);
  const enforcement: EnforcementLevel = options.enforcement ?? "block";

  // A non-existent project root is "no project to evaluate", not "a project with
  // everything absent" — return an empty scan rather than firing every absence rule
  // on nothing. (An EXISTING but empty/Accessibility-free project still fires, which
  // is the #66 ground-truth case.)
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return [];
  } catch {
    return [];
  }

  const evidence: ProjectEvidence = {
    hasAccessibilityRef: false,
    hasInputActionsAsset: false,
    hasRebindingCall: false,
  };
  await gatherEvidence(root, evidence);

  const findings: UnityProjectFinding[] = [];

  if (!evidence.hasAccessibilityRef) {
    findings.push(
      makeFinding(
        root,
        "unity/no-screen-reader-support",
        "No screen-reader support present — the project references none of " +
          "`AccessibilityHierarchy`, `AccessibilityNode`, or `AssistiveSupport` " +
          "(the `UnityEngine.Accessibility` API). Unity bridges nothing into an " +
          "accessibility tree automatically, so the game is unusable with a screen " +
          "reader. Build an `AccessibilityHierarchy` of `AccessibilityNode`s and " +
          "register it via `AssistiveSupport`.",
        enforcement,
      ),
    );
  }

  if (!evidence.hasInputActionsAsset && !evidence.hasRebindingCall) {
    findings.push(
      makeFinding(
        root,
        "unity/no-input-rebinding",
        "No input remapping present — the project ships no `.inputactions` asset and " +
          "makes no `PerformInteractiveRebinding` call, so a player cannot remap " +
          "controls. Fixed controls are a motor-accessibility barrier; expose a " +
          "rebinding path via the Input System.",
        enforcement,
      ),
    );
  }

  return findings;
}
