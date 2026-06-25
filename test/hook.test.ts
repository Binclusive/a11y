import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/hook";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hook");
const VIOLATION = join(FIXTURES, "violation.tsx");
const CLEAN = join(FIXTURES, "clean.tsx");
const LINK_GENERIC = join(FIXTURES, "link-generic.tsx");
const IMG_AND_LINK = join(FIXTURES, "img-and-link.tsx");

/** Build a PostToolUse payload pointing at `filePath` (absolute). */
function payload(filePath: string, toolName = "Edit"): unknown {
  return {
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    cwd: FIXTURES,
    tool_input: { file_path: filePath },
  };
}

describe("runHook — inject case", () => {
  it("emits additionalContext with the finding + fix for an edited .tsx", async () => {
    const out = await runHook(payload(VIOLATION));

    expect(out).not.toBeNull();
    expect(out?.hookSpecificOutput.hookEventName).toBe("PostToolUse");

    const ctx = out?.hookSpecificOutput.additionalContext ?? "";
    // Imperative framing so the model fixes the edit it just made.
    expect(ctx).toContain("You just edited");
    expect(ctx).toContain("fix them now");
    // The terse line: rule · WCAG SC · tier · fix.
    expect(ctx).toContain("anchor-has-content");
    expect(ctx).toContain("WCAG 2.4.4");
    expect(ctx).toContain("[very-common]");
    // The representative corpus fix is carried, not just the eslint message.
    expect(ctx.toLowerCase()).toContain("discernible text");
    // Path is relativized to the cwd — no absolute leakage into the whisper.
    expect(ctx).toContain("violation.tsx");
    expect(ctx).not.toContain(FIXTURES);
  });

  it("works for Write and MultiEdit shapes (all use tool_input.file_path)", async () => {
    for (const tool of ["Write", "MultiEdit"]) {
      const out = await runHook(payload(VIOLATION, tool));
      expect(out, `${tool} should inject`).not.toBeNull();
      expect(out?.hookSpecificOutput.additionalContext).toContain("anchor-has-content");
    }
  });
});

describe("runHook — recall self-check (Phase 1.5)", () => {
  it("speaks up on a floor-CLEAN file with a generic-text Link (recall only)", async () => {
    // <Link>click here</Link> has text, so the floor stays silent — but the corpus
    // recall layer grounds the generic-link-text shape. The advisory fires alone.
    const out = await runHook(payload(LINK_GENERIC));
    expect(out).not.toBeNull();
    const ctx = out?.hookSpecificOutput.additionalContext ?? "";
    expect(ctx).toContain("Self-check");
    expect(ctx).toContain("advisory");
    expect(ctx.toLowerCase()).toContain("non-descriptive link");
    // No floor whisper — the file is floor-clean.
    expect(ctx).not.toContain("fix them now");
    // Path relativized, no absolute leak.
    expect(ctx).toContain("link-generic.tsx");
    expect(ctx).not.toContain(FIXTURES);
  });

  it("surfaces ONLY certified patterns — no R1 cross-token noise (e.g. keyboard)", async () => {
    // The keyboard pattern (2.1.1) shares a `link` token with the Link resolution,
    // so R1 pulls it — but it isn't certified, so the advisory must NOT show it.
    const out = await runHook(payload(LINK_GENERIC));
    const ctx = out?.hookSpecificOutput.additionalContext ?? "";
    expect(ctx.toLowerCase()).not.toContain("keyboard");
    expect(ctx.toLowerCase()).not.toContain("space");
  });

  it("combines the precise floor whisper AND the advisory self-check when both apply", async () => {
    // img-and-link.tsx: a 1.1.1 floor finding (img missing alt) AND a 2.4.4 recall
    // (generic-text <Link>) the floor is silent on — so SC-disjoint keeps both.
    const out = await runHook(payload(IMG_AND_LINK));
    const ctx = out?.hookSpecificOutput.additionalContext ?? "";
    expect(ctx).toContain("fix them now"); // floor voice
    expect(ctx).toContain("alt"); // the image/alt floor finding
    expect(ctx).toContain("Self-check"); // recall voice
    // The two blocks are separated, floor first.
    expect(ctx.indexOf("fix them now")).toBeLessThan(ctx.indexOf("Self-check"));
  });

  it("does NOT double up the floor's own SC", async () => {
    // violation.tsx is a 2.4.4 floor finding. The 2.4.4 recall pattern is suppressed
    // because the floor already covers 2.4.4 — the two blocks stay disjoint by SC.
    const out = await runHook(payload(VIOLATION));
    const ctx = out?.hookSpecificOutput.additionalContext ?? "";
    expect(ctx).toContain("fix them now"); // floor present
    expect(ctx).not.toContain("Self-check"); // recall suppressed (2.4.4 floor-covered)
  });
});

describe("runHook — Unity (.prefab/.unity) (#92)", () => {
  // The real Unity fixture project (shared with unity-findings.test.ts).
  const UNITY_PROJECT = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "unity-project",
  );
  const BUTTON_NO_LABEL = join(UNITY_PROJECT, "ButtonNoLabel.prefab");
  const BINARY = join(UNITY_PROJECT, "Binary.prefab");

  /** A PostToolUse payload for a Unity asset, cwd at the project root. */
  function unityPayload(filePath: string, toolName = "Edit"): unknown {
    return {
      hook_event_name: "PostToolUse",
      tool_name: toolName,
      cwd: UNITY_PROJECT,
      tool_input: { file_path: filePath },
    };
  }

  it("fires on a .prefab edit, emitting the whisper for the edited asset's Unity findings", async () => {
    const out = await runHook(unityPayload(BUTTON_NO_LABEL));

    expect(out).not.toBeNull();
    expect(out?.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const ctx = out?.hookSpecificOutput.additionalContext ?? "";
    expect(ctx).toContain("You just edited");
    expect(ctx).toContain("ButtonNoLabel.prefab");
    // The missing-accessible-label Unity finding (Absent state) surfaces in the whisper.
    expect(ctx).toContain("unity/missing-accessible-label");
  });

  it("works for Write and MultiEdit shapes too (all use tool_input.file_path)", async () => {
    for (const tool of ["Write", "MultiEdit"]) {
      const out = await runHook(unityPayload(BUTTON_NO_LABEL, tool));
      expect(out?.hookSpecificOutput.additionalContext).toContain("ButtonNoLabel.prefab");
    }
  });

  it("scopes the whisper to the edited asset (an opaque/clean asset emits nothing)", async () => {
    // Binary.prefab is opaque → contributes no findings → the per-file whisper no-ops.
    const out = await runHook(unityPayload(BINARY));
    expect(out).toBeNull();
  });
});

describe("runHook — no-op cases", () => {
  it("no-ops on a clean .tsx (no findings)", async () => {
    const out = await runHook(payload(CLEAN));
    expect(out).toBeNull();
  });

  it("no-ops on a non-tsx, non-Unity file", async () => {
    const out = await runHook(payload(join(FIXTURES, "violation.ts")));
    expect(out).toBeNull();
  });

  it("no-ops on malformed input (not an object)", async () => {
    expect(await runHook("not json")).toBeNull();
    expect(await runHook(42)).toBeNull();
    expect(await runHook(null)).toBeNull();
    expect(await runHook([])).toBeNull();
  });

  it("no-ops when tool_input / file_path is missing", async () => {
    expect(await runHook({ tool_name: "Edit", cwd: FIXTURES })).toBeNull();
    expect(await runHook({ tool_name: "Edit", tool_input: {} })).toBeNull();
  });

  it("resolves a relative file_path against cwd", async () => {
    // Same violation, addressed relatively — must still find it.
    const out = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      cwd: FIXTURES,
      tool_input: { file_path: "violation.tsx" },
    });
    expect(out).not.toBeNull();
    expect(out?.hookSpecificOutput.additionalContext).toContain("anchor-has-content");
  });
});
