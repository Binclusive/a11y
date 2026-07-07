import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type EnforceContext, enforceContent } from "../src/enforce";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "prefer-tag-over-role.tsx");
const CTX: EnforceContext = { resolutions: [], declarations: null, contract: null };

describe("enforce: prefer-tag-over-role (#15 — scoped to landmark roles)", () => {
  const findings = enforceContent([fixture], CTX).filter(
    (f) => f.ruleId === "enforce/prefer-tag-over-role",
  );

  it("flags ONLY the two bare intrinsics with a native-equivalent landmark role", () => {
    // `<div role="region">` → <section>, `<span role="navigation">` → <nav>.
    // Already-native (<section role=region>, <nav role=navigation>), widget roles
    // (img/status/combobox/presentation), the dynamic role, and the <td> all stay
    // clean — that is the "scoped, not the 90%-noise stock rule" guarantee.
    expect(findings.length).toBe(2);
    expect(findings.every((f) => f.wcag.includes("1.3.1"))).toBe(true);
  });

  it("names the native tag to use in each message", () => {
    const msg = findings.map((f) => f.message).join(" | ");
    expect(msg).toContain("<section>");
    expect(msg).toContain("<nav>");
  });
});
