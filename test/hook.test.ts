import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/hook";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hook");
const VIOLATION = join(FIXTURES, "violation.tsx");
const CLEAN = join(FIXTURES, "clean.tsx");

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

describe("runHook — no-op cases", () => {
  it("no-ops on a clean .tsx (no findings)", async () => {
    const out = await runHook(payload(CLEAN));
    expect(out).toBeNull();
  });

  it("no-ops on a non-tsx file", async () => {
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
