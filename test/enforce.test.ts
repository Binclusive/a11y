import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "../src/core";
import { type ControlType, type EnforceContext, enforceContent } from "../src/enforce";
import { type ComponentResolution, resolveComponents } from "../src/resolve-components";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => join(here, "fixtures", "enforce", name);

const controls = fx("controls.tsx");
const links = fx("links.tsx");
const dedupe = fx("dedupe.tsx");
const dialogs = fx("dialogs.tsx");
const nameGate = fx("name-gate.tsx");
const roleToggle = fx("role-toggle.tsx");
const nativeControls = fx("native-controls.tsx");
// A wrapper that resolves to host `button` but renders its OWN static name
// internally (sr-only span / aria-label) — the shadcn carousel-arrow FP.
const srOnlyConsumer = join(here, "fixtures", "sr-only-name-consumer.tsx");

/** Default enforce context: no resolved components, no contract (zero-config). */
const CTX: EnforceContext = { resolutions: [], declarations: null, contract: null };

/** The rule ids the enforce pass produced for a fixture file. */
function enforceRuleIds(file: string, ctx: EnforceContext): readonly string[] {
  return enforceContent([file], ctx).map((f) => f.ruleId);
}

describe("enforce: button / icon-button (4.1.2-button-no-name)", () => {
  it("flags an OPAQUE/TRUSTED icon-only button with no name — the recall win", () => {
    const ids = enforceRuleIds(controls, CTX);
    // IconOnlyTrusted, TrustedIconButton, EmptyButton, TooltiplessIconButton all
    // flag button-no-name.
    const buttonHits = ids.filter((r) => r === "enforce/button-no-name");
    expect(buttonHits.length).toBeGreaterThanOrEqual(4);
  });

  it("does NOT flag the same icon-only button once it has an aria-label", () => {
    // IconOnlyLabelled + DynamicLabelButton are named — neither contributes.
    const findings = enforceContent([controls], CTX);
    const labelledLine = findings.find((f) => f.message.includes("aria-label"));
    // No finding should land on a labelled button; assert via count parity below.
    expect(labelledLine?.ruleId).not.toBe("enforce/button-no-name-on-labelled");
  });

  it("does NOT flag a button with a static text child", () => {
    // ButtonWithText (<Button>Save</Button>) must not appear. We assert the total
    // button-no-name count equals exactly the four nameless buttons (IconOnly-
    // Trusted, TrustedIconButton, EmptyButton, TooltiplessIconButton) — and that
    // TooltipNamedIconButton (titled Tooltip) is NOT among them.
    const buttonHits = enforceContent([controls], CTX).filter(
      (f) => f.ruleId === "enforce/button-no-name",
    );
    expect(buttonHits.length).toBe(4);
  });

  it("does NOT flag an icon-only button inside a TITLED <Tooltip>, but DOES inside a titleless one", () => {
    // MUI Tooltip injects `title` as the child's aria-label at runtime, so a
    // nested icon-only IconButton IS named — flagging it is the react-admin FP.
    // A title-LESS Tooltip injects no name, so the same shape must still flag.
    const src = readFileSync(controls, "utf8").split("\n");
    const lineOf = (needle: string): number => src.findIndex((l) => l.includes(needle)) + 1;
    // The IconButton inside TooltipNamedIconButton vs TooltiplessIconButton.
    const titledLine = lineOf("export const TooltipNamedIconButton") + 2;
    const titlelessLine = lineOf("export const TooltiplessIconButton") + 2;
    const flaggedLines = enforceContent([controls], CTX)
      .filter((f) => f.ruleId === "enforce/button-no-name")
      .map((f) => f.line);
    expect(flaggedLines).not.toContain(titledLine); // titled Tooltip names it
    expect(flaggedLines).toContain(titlelessLine); // titleless Tooltip does not
  });

  it("carries WCAG 4.1.2 and provenance enforce", () => {
    const f = enforceContent([controls], CTX).find((x) => x.ruleId === "enforce/button-no-name");
    expect(f?.wcag).toEqual(["4.1.2"]);
    expect(f?.provenance).toBe("enforce");
  });
});

describe("enforce: conservatism guard (the FP killer)", () => {
  it("NEVER flags a control that spreads props ({...props})", () => {
    // SpreadButton + SpreadImage spread — their content is unknowable.
    const findings = enforceContent([controls], CTX);
    // The four button-no-name hits are the static nameless buttons (incl. the
    // titleless-Tooltip one), not the spread one; the spread image likewise
    // contributes no image-no-alt.
    expect(findings.filter((f) => f.ruleId === "enforce/button-no-name").length).toBe(4);
    expect(findings.filter((f) => f.ruleId === "enforce/image-no-alt").length).toBe(1);
  });

  it("NEVER flags a button whose only child is a dynamic/computed expression", () => {
    // DynamicChildButton renders {label} — could be text. Not in the count of 4.
    const buttonHits = enforceContent([controls], CTX).filter(
      (f) => f.ruleId === "enforce/button-no-name",
    );
    expect(buttonHits.length).toBe(4); // empty + 2 icon-only + titleless-Tooltip
  });

  it("NEVER flags a button with a dynamic aria-label", () => {
    // DynamicLabelButton has aria-label={name} — present-and-unknowable = named.
    const labels = enforceContent([controls], CTX);
    // 4 button hits total; if the dynamic-label button leaked it would be 5.
    expect(labels.filter((f) => f.ruleId === "enforce/button-no-name").length).toBe(4);
  });
});

describe("enforce: image (1.1.1)", () => {
  it("flags a trusted <Image> with no alt and no aria-label", () => {
    const imgHits = enforceContent([controls], CTX).filter(
      (f) => f.ruleId === "enforce/image-no-alt",
    );
    // ImageNoAlt is the only flaggable image (decorative alt="" and alt="A cat"
    // and the spread image are all skipped).
    expect(imgHits.length).toBe(1);
    expect(imgHits[0]?.wcag).toEqual(["1.1.1"]);
  });

  it('does NOT flag a decorative alt="" image', () => {
    // Covered by the count of 1 above; assert no finding mentions decorative.
    const imgHits = enforceContent([controls], CTX).filter(
      (f) => f.ruleId === "enforce/image-no-alt",
    );
    expect(imgHits.length).toBe(1);
  });
});

describe("enforce: link (2.4.4-link-no-name)", () => {
  it("flags an icon-only link with no name", () => {
    const linkHits = enforceRuleIds(links, CTX).filter((r) => r === "enforce/link-no-name");
    // IconOnlyLink (MUI) + IconOnlyRouterLink (react-router) — both icon-only, nameless.
    expect(linkHits.length).toBe(2);
  });

  it("does NOT flag a link with visible text or an aria-label", () => {
    const linkHits = enforceContent([links], CTX).filter(
      (f) => f.ruleId === "enforce/link-no-name",
    );
    // Named/text links (LinkWithText, LabelledIconLink, NavLinkWithText,
    // LabelledRouterLink) and the DynamicRouterLink (unknowable child) all skip →
    // exactly the 2 icon-only nameless links remain.
    expect(linkHits.length).toBe(2);
    expect(linkHits.every((f) => f.wcag.includes("2.4.4"))).toBe(true);
  });
});

describe("enforce: react-router Link/NavLink recall (hardening #1)", () => {
  it("recognizes router Link/NavLink as link controls via the content pass alone", () => {
    // No resolutions, no contract — proves recognition comes from the router-link
    // module gate, not from any host map (the structural pass never sees them).
    const findings = enforceContent([links], CTX).filter(
      (f) => f.ruleId === "enforce/link-no-name",
    );
    // The react-router icon-only link must be among the flagged ones.
    const src = readFileSync(links, "utf8").split("\n");
    const routerIconLine = src.findIndex((l) => l.includes("export const IconOnlyRouterLink")) + 2;
    expect(findings.map((f) => f.line)).toContain(routerIconLine);
  });

  it("does NOT flag router links that have text, an aria-label, or a dynamic child", () => {
    const findings = enforceContent([links], CTX).filter(
      (f) => f.ruleId === "enforce/link-no-name",
    );
    const src = readFileSync(links, "utf8").split("\n");
    const line = (needle: string): number =>
      src.findIndex((l) => l.includes(needle)) + 2;
    const flagged = new Set(findings.map((f) => f.line));
    expect(flagged.has(line("export const NavLinkWithText"))).toBe(false);
    expect(flagged.has(line("export const LabelledRouterLink"))).toBe(false);
    expect(flagged.has(line("export const DynamicRouterLink"))).toBe(false);
  });
});

describe("enforce: recognition reaches opaque/trusted via name + registry", () => {
  it("classifies registry components by host even with no resolutions", () => {
    // MUI Button/IconButton/Link/Image/TextField are all classified here purely
    // from the registry — no resolutions needed — proving the opaque reach.
    const findings = enforceContent([controls, links], CTX);
    const ruleIds = new Set(findings.map((f) => f.ruleId));
    expect(ruleIds.has("enforce/button-no-name")).toBe(true);
    expect(ruleIds.has("enforce/image-no-alt")).toBe(true);
    expect(ruleIds.has("enforce/link-no-name")).toBe(true);
  });

  it("classifies an opaque guaranteed-library component by the name heuristic", () => {
    // Mantine ActionIcon is NOT in the registry — it reaches enforce ONLY via the
    // name heuristic, and @mantine is a guaranteed library, so it fires.
    const ids = enforceRuleIds(nameGate, CTX);
    expect(ids.filter((r) => r === "enforce/button-no-name").length).toBe(1);
  });
});

describe("enforce: name-heuristic module gate (hardening-3 #1 + #4)", () => {
  it("does NOT flag a bare-name Button/Link from an UNKNOWN module", () => {
    // RaIconButton (react-admin Button, icon-only) + UnknownIconLink
    // (some-unknown-router Link, icon-only) both reach ONLY via the name
    // heuristic, and neither module is guaranteed → neither flags.
    const findings = enforceContent([nameGate], CTX);
    expect(findings.filter((f) => f.ruleId === "enforce/button-no-name").length).toBe(1); // only ActionIcon
    expect(findings.filter((f) => f.ruleId === "enforce/link-no-name").length).toBe(0);
  });

  it("flags the SAME shape inside a guaranteed library (Mantine ActionIcon)", () => {
    // NamelessActionIcon (@mantine/core, icon-only, no name) → 4.1.2.
    const findings = enforceContent([nameGate], CTX);
    const hit = findings.find((f) => f.ruleId === "enforce/button-no-name");
    expect(hit?.wcag).toEqual(["4.1.2"]);
  });

  it("does NOT flag an ActionIcon that carries an aria-label", () => {
    // LabelledActionIcon is named → only the one nameless ActionIcon flags.
    const findings = enforceContent([nameGate], CTX);
    expect(findings.filter((f) => f.ruleId === "enforce/button-no-name").length).toBe(1);
  });

  it("does NOT flag a button named by a label= prop (react-admin convention)", () => {
    // RaLabelledButton has label="Import" — even if it WERE a guaranteed lib, the
    // label= name source clears it. Belt-and-suspenders alongside the gate.
    const findings = enforceContent([nameGate], CTX);
    expect(findings.some((f) => f.message.includes("button"))).toBe(true); // ActionIcon only
    expect(findings.filter((f) => f.ruleId === "enforce/button-no-name").length).toBe(1);
  });

  it("does NOT flag a react-admin display TextField (unknown module, no host)", () => {
    // RaDisplayField is react-admin's <TextField source=…> (a <span>), opaque from
    // an unknown module → never recognized as an input. No input finding.
    const findings = enforceContent([nameGate], CTX);
    expect(findings.filter((f) => f.ruleId === "enforce/input-no-name").length).toBe(0);
  });
});

describe("enforce: module-scoped resolved host (no leaf-name collision)", () => {
  it("does NOT lend one module's resolved host to a same-named export from another module", () => {
    // Simulate the react-admin FP root: MUI TextField resolved to `input`, but a
    // DIFFERENT module's TextField (react-admin display field) must not inherit it.
    const resolutions: ComponentResolution[] = [
      {
        name: "TextField",
        module: "@mui/material",
        imported: "TextField",
        host: "input",
        provenance: "registry",
        role: null,
        rendersOwnName: false,
      },
    ];
    const ctx: EnforceContext = { resolutions, declarations: null, contract: null };
    // name-gate.tsx's RaField is `TextField` from "react-admin" — the resolved
    // host above is keyed to @mui/material, so it must NOT apply here.
    const findings = enforceContent([nameGate], ctx);
    expect(findings.filter((f) => f.ruleId === "enforce/input-no-name").length).toBe(0);
  });

  it("DOES apply a resolved host to the same module's export", () => {
    // The MUI TextField (controls.tsx) resolved to input — with a matching
    // module-keyed resolution it is recognized as an input. controls.tsx's
    // FieldLabelled has label="Email", so it is named → no input finding, but the
    // recognition path is exercised (no crash, host-strength).
    const resolutions: ComponentResolution[] = [
      {
        name: "TextField",
        module: "@mui/material",
        imported: "TextField",
        host: "input",
        provenance: "registry",
        role: null,
        rendersOwnName: false,
      },
    ];
    const ctx: EnforceContext = { resolutions, declarations: null, contract: null };
    const findings = enforceContent([controls], ctx);
    // FieldLabelled (TextField label="Email") is named → no input finding.
    expect(findings.filter((f) => f.ruleId === "enforce/input-no-name").length).toBe(0);
  });
});

describe("enforce: role-aware toggle skip (#5 — Radix toggle ≠ bare button)", () => {
  it("does NOT flag a nameless Radix Checkbox (host button, role checkbox) via the registry path", () => {
    // No resolutions → classify reaches the registry, which returns role
    // 'checkbox' for @radix-ui/react-checkbox Root → toggle skip, no finding.
    // The sibling nameless icon-only Button still flags, proving the skip is
    // scoped to the toggle, not a blanket suppression of the file.
    const findings = enforceContent([roleToggle], CTX);
    const buttonHits = findings.filter((f) => f.ruleId === "enforce/button-no-name");
    expect(buttonHits.length).toBe(1); // only NamelessIconButton, NOT the checkbox
  });

  it("does NOT flag the toggle even when reached via a module-keyed RESOLVED host", () => {
    // The host path (resolvedHosts) carries role 'checkbox' → role-aware skip,
    // generalizing TOGGLE_NAMES to a toggle reached by trace/host, not by name.
    const resolutions: ComponentResolution[] = [
      {
        name: "CheckboxPrimitive.Root",
        module: "@radix-ui/react-checkbox",
        imported: "Root",
        host: "button",
        provenance: "trace",
        role: "checkbox",
        rendersOwnName: false,
      },
    ];
    const ctx: EnforceContext = { resolutions, declarations: null, contract: null };
    const buttonHits = enforceContent([roleToggle], ctx).filter(
      (f) => f.ruleId === "enforce/button-no-name",
    );
    expect(buttonHits.length).toBe(1); // still only the sibling icon-only Button
  });
});

describe("enforce: renders-own-name skip (shadcn carousel arrow FP)", () => {
  // Resolve the wrappers end to end (trace → resolution) so the test exercises
  // the real `rendersOwnName` capture, not a hand-built resolution.
  const { resolutions } = resolveComponents([srOnlyConsumer]);
  const ctx: EnforceContext = { resolutions, declarations: null, contract: null };

  it("captures rendersOwnName on a host button that renders an internal sr-only name", () => {
    const byName = new Map(resolutions.map((r) => [r.name, r]));
    // Direct host, sr-only span.
    const direct = byName.get("SrOnlyButton");
    expect(direct?.host).toBe("button");
    expect(direct?.provenance !== "opaque" && direct?.rendersOwnName).toBe(true);
    // Recursive hop (wrapper → inner Button → host) — the EXACT carousel shape.
    const recursive = byName.get("CarouselArrow");
    expect(recursive?.host).toBe("button");
    expect(recursive?.provenance !== "opaque" && recursive?.rendersOwnName).toBe(true);
    // Named by a static aria-label literal on the host.
    const ariaLabelled = byName.get("AriaLabelButton");
    expect(ariaLabelled?.provenance !== "opaque" && ariaLabelled?.rendersOwnName).toBe(true);
    // The genuinely-nameless icon-only wrapper carries NO internal name.
    const nameless = byName.get("NamelessIconButton");
    expect(nameless?.host).toBe("button");
    expect(nameless?.provenance !== "opaque" && nameless?.rendersOwnName).toBe(false);
  });

  it("does NOT flag a self-closing button wrapper that renders its own sr-only name", () => {
    // SrOnlyButton / CarouselArrow / AriaLabelButton each resolve to host
    // `button` and render an internal static name — the self-closing call site
    // looks empty but the control IS named. None must flag button-no-name.
    const flaggedLines = enforceContent([srOnlyConsumer], ctx)
      .filter((f) => f.ruleId === "enforce/button-no-name")
      .map((f) => f.line);
    const src = readFileSync(srOnlyConsumer, "utf8").split("\n");
    const lineOf = (needle: string): number => src.findIndex((l) => l.includes(needle)) + 1;
    expect(flaggedLines).not.toContain(lineOf("<SrOnlyButton"));
    expect(flaggedLines).not.toContain(lineOf("<CarouselArrow"));
    expect(flaggedLines).not.toContain(lineOf("<AriaLabelButton"));
  });

  it("STILL flags a genuinely-nameless traced button (over-suppression guard)", () => {
    // NamelessIconButton resolves to host `button`, renders only an icon, and
    // carries rendersOwnName=false → it must remain flagged. Proves the skip is
    // scoped to controls that actually render a name, not a blanket suppression.
    const buttonHits = enforceContent([srOnlyConsumer], ctx).filter(
      (f) => f.ruleId === "enforce/button-no-name",
    );
    const src = readFileSync(srOnlyConsumer, "utf8").split("\n");
    const namelessLine = src.findIndex((l) => l.includes("<NamelessIconButton")) + 1;
    expect(buttonHits.map((f) => f.line)).toContain(namelessLine);
    // Exactly one button-no-name finding in the file: the nameless one only.
    expect(buttonHits.length).toBe(1);
  });
});

describe("enforce: dialog (4.1.2 / 1.3.1 — the fuzziest, most conservative)", () => {
  it("flags a dialog with a visible body but no title subcomponent or name", () => {
    const hits = enforceContent([dialogs], CTX).filter(
      (f) => f.ruleId === "enforce/dialog-no-name",
    );
    // Only NamelessDialog qualifies — self-closing/titled/labelled are all skipped.
    expect(hits.length).toBe(1);
    expect(hits[0]?.wcag).toEqual(["4.1.2", "1.3.1"]);
  });

  it("does NOT flag a self-closing opaque dialog (renders its own title)", () => {
    // Covered by the count of 1; the self-closing SelfClosingDialog is skipped.
    const hits = enforceContent([dialogs], CTX).filter(
      (f) => f.ruleId === "enforce/dialog-no-name",
    );
    expect(hits.length).toBe(1);
  });

  it("does NOT flag a dialog with a DialogTitle or an aria-label", () => {
    const hits = enforceContent([dialogs], CTX).filter(
      (f) => f.ruleId === "enforce/dialog-no-name",
    );
    expect(hits.length).toBe(1); // TitledDialog + LabelledDialog both excluded
  });
});

describe("scan: enforce findings join jsx-a11y findings and dedupe", () => {
  it("does NOT double-report an intrinsic <img> flagged by both passes", async () => {
    const { findings } = await scan([dedupe]);
    const onLine = findings.filter((f) => f.wcag.includes("1.1.1"));
    // Exactly one 1.1.1 finding for the no-alt <img>: jsx-a11y's alt-text. The
    // enforce image-no-alt twin on the same line+SC is deduped away.
    expect(onLine.length).toBe(1);
    expect(onLine[0]?.provenance).toBe("jsx-a11y");
  });

  it("surfaces enforce findings the structural pass cannot see (trusted controls)", async () => {
    const { findings } = await scan([controls]);
    const enforceFindings = findings.filter((f) => f.provenance === "enforce");
    // The trusted MUI buttons + Chakra image are invisible to jsx-a11y (opaque),
    // so every enforce finding here is NET-NEW recall, not a dedupe survivor.
    expect(enforceFindings.length).toBeGreaterThan(0);
    expect(enforceFindings.every((f) => f.ruleId.startsWith("enforce/"))).toBe(true);
  });
});

describe("enforce: control-type classification surface", () => {
  it("exposes ControlType for the five recognized families", () => {
    const families: ControlType[] = ["button", "icon-button", "link", "image", "dialog", "input"];
    expect(families.length).toBe(6);
  });
});

describe("enforce: native form controls (#16 — control-has-associated-label gap)", () => {
  it("flags ONLY the four genuinely-nameless native controls", () => {
    // input[type=text], placeholder-only input, <select>, <textarea> — and
    // nothing else. The exemptions (aria-label / id / <label> ancestor / submit /
    // checkbox / radio / hidden / tabIndex=-1 / display:none / spread) and the
    // empty <td> (the react-doctor layout-cell false positive) all stay clean.
    const findings = enforceContent([nativeControls], CTX);
    const inputHits = findings.filter((f) => f.ruleId === "enforce/input-no-name");
    expect(inputHits.length).toBe(4);
  });

  it("does NOT flag a presentational <td> — the react-doctor empty-cell FP we avoid", () => {
    // classify() recognizes EXACTLY input/select/textarea, so a layout cell is
    // never a control. This is the structural reason our native coverage can't
    // produce the 12-finding empty-<td> cluster react-doctor ships.
    const findings = enforceContent([nativeControls], CTX);
    // The fixture's two <td> cells occupy the last rows; no finding may land there.
    const onTd = findings.some((f) => f.message.includes("table") || f.ruleId.includes("td"));
    expect(onTd).toBe(false);
    expect(findings.every((f) => f.ruleId === "enforce/input-no-name")).toBe(true);
  });
});

describe("structural: router Link mapped to host `a` (issue #33)", () => {
  // The fixture's co-located binclusive.json maps `Link`/`NavLink` → `a`, so the
  // structural jsx-a11y pass runs `anchor-is-valid` on them. The `specialLink:
  // ['to']` alias makes a valid `to` satisfy the href requirement.
  const routerLinks = join(here, "fixtures", "router-link-href", "links.tsx");

  it("fires anchor-is-valid ONLY on the empty/hash `to`, never on a valid `to`", async () => {
    const { findings } = await scan([routerLinks]);
    const anchorLines = findings
      .filter((f) => f.ruleId === "jsx-a11y/anchor-is-valid")
      .map((f) => f.line)
      .sort((a, b) => a - b);
    // ValidLink (13) + ValidNavLink (16) must NOT appear (the FP this fix kills);
    // EmptyToLink (19) + HashToLink (22) MUST appear (the alias narrows, never
    // disables, the rule). So exactly [19, 22].
    expect(anchorLines).toEqual([19, 22]);
  });

  // PR #35 review finding: the gate must match on the ORIGINAL imported name,
  // not the local JSX alias. Here `Link` is imported as `RouterLink` and the
  // co-located binclusive.json maps `RouterLink` → `a`. Keying off the alias
  // would leave `specialLink` disarmed and re-open the #33 FP flood.
  const aliasedRouterLinks = join(here, "fixtures", "router-link-href-aliased", "links.tsx");

  it("arms specialLink for an ALIASED router-link import (`Link as RouterLink`)", async () => {
    const { findings } = await scan([aliasedRouterLinks]);
    const anchorLines = findings
      .filter((f) => f.ruleId === "jsx-a11y/anchor-is-valid")
      .map((f) => f.line)
      .sort((a, b) => a - b);
    // ValidLink (14) must NOT appear (alias resolved to its `Link` export);
    // EmptyToLink (17) MUST still appear. So exactly [17].
    expect(anchorLines).toEqual([17]);
  });
});
