import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatOpaqueHint } from "../src/cli";
import {
  contractForFiles,
  enforcementFor,
  fileIgnoreMatcher,
  ignoredRuleIds,
  NO_CONTRACT_ENFORCEMENT,
} from "../src/config-scan";
import type { Contract } from "../src/contract";
import { scan } from "../src/core";
import { resolveComponents } from "../src/resolve-components";
import { transInjectedLineRanges } from "../src/suppression-ranges";

function sf(code: string): ts.SourceFile {
  return ts.createSourceFile("t.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** A contract with declarations filled in for the pure-predicate tests. */
function contractWith(decls: Partial<Contract["declarations"]>): Contract {
  return {
    version: 1,
    stack: { framework: "next", router: "app", designSystem: "@acme/ui", language: "ts" },
    enforcement: { block: ["1.3.1", "4.1.2"], warn: ["2.4.4"] },
    learned: [],
    declarations: { components: {}, injectsChildren: [], ignore: [], ...decls },
  };
}

describe("declarations.components: merge into the map as declared coverage", () => {
  it("a declared host resolves a wrapper the tracer leaves opaque, and overrides", () => {
    // `<Opaque/>` has no source on disk and isn't in the registry → opaque.
    const code = `
      import { Opaque } from "@acme/ui";
      import { TextField } from "@mui/material";
      export const X = () => (<><Opaque /><TextField /></>);
    `;
    const file = join(tmpdir(), "decl-merge.tsx");
    // Resolve directly from an in-memory-style fixture via a real temp file.
    return (async () => {
      await writeFile(file, code);
      try {
        const declared = { Opaque: "button", TextField: "a" };
        const { map, coverage, resolutions } = resolveComponents([file], declared);

        // Declared host fills the gap the tracer couldn't.
        expect(map.Opaque).toBe("button");
        // Declared OVERRIDES the registry (MUI TextField would be `input`).
        expect(map.TextField).toBe("a");

        const byName = new Map(resolutions.map((r) => [r.name, r]));
        expect(byName.get("Opaque")?.provenance).toBe("declared");
        expect(byName.get("TextField")?.provenance).toBe("declared");
        expect(coverage.declared).toBe(2);
        expect(coverage.opaque).toBe(0);
      } finally {
        await rm(file, { force: true });
      }
    })();
  });

  it("a declared COMPOUND member (`Dialog.Close`) resolves via the dotted name it has in JSX", async () => {
    // A namespace import rendered as a compound member. Before the fix the
    // declared lookup keyed on the LEAF only (`Close`), so `"Dialog.Close"`
    // never matched and the member stayed in the `declare` bucket. The dotted
    // name is exactly what the customer SEES in JSX.
    const code = `
      import * as Dialog from "@acme/ui/Dialog";
      export const X = () => (<Dialog.Root><Dialog.Close /></Dialog.Root>);
    `;
    const file = join(tmpdir(), "decl-compound.tsx");
    await writeFile(file, code);
    try {
      const declared = { "Dialog.Close": "button" };
      const { map, coverage, resolutions } = resolveComponents([file], declared);

      const byName = new Map(resolutions.map((r) => [r.name, r]));
      // The declared dotted member resolves — no longer opaque/declare.
      expect(byName.get("Dialog.Close")?.provenance).toBe("declared");
      expect(byName.get("Dialog.Close")?.host).toBe("button");
      expect(coverage.declared).toBe(1);
      // jsx-a11y matches a `NS.Member` tag on its leaf, so the host lands under
      // the leaf key for the structural pass to fire.
      expect(map.Close).toBe("button");
    } finally {
      await rm(file, { force: true });
    }
  });

  it("a bare-leaf declaration (`Close`) still resolves a compound member (back-compat)", async () => {
    const code = `
      import * as Dialog from "@acme/ui/Dialog";
      export const X = () => <Dialog.Close />;
    `;
    const file = join(tmpdir(), "decl-leaf-fallback.tsx");
    await writeFile(file, code);
    try {
      const { map, resolutions } = resolveComponents([file], { Close: "button" });
      expect(resolutions[0]?.provenance).toBe("declared");
      expect(map.Close).toBe("button");
    } finally {
      await rm(file, { force: true });
    }
  });

  it("the dotted form scopes to ONE wrapper — an unrelated `*.Close` stays opaque", async () => {
    // `"Dialog.Close"` must NOT bleed onto `Menu.Close`. This is the precision
    // win over the bare-leaf workaround, which matched every `*.Close`.
    const code = `
      import * as Dialog from "@acme/ui/Dialog";
      import * as Menu from "@acme/ui/Menu";
      export const X = () => (<><Dialog.Close /><Menu.Close /></>);
    `;
    const file = join(tmpdir(), "decl-compound-scoped.tsx");
    await writeFile(file, code);
    try {
      const { resolutions } = resolveComponents([file], { "Dialog.Close": "button" });
      const byName = new Map(resolutions.map((r) => [r.name, r]));
      expect(byName.get("Dialog.Close")?.provenance).toBe("declared");
      // Menu.Close was NOT declared by its dotted name → not resolved as declared.
      expect(byName.get("Menu.Close")?.provenance).not.toBe("declared");
    } finally {
      await rm(file, { force: true });
    }
  });

  it("a declared component that no file uses is ignored (coverage tracks code)", async () => {
    const code = `import { Opaque } from "@acme/ui"; export const X = () => <Opaque />;`;
    const file = join(tmpdir(), "decl-stale.tsx");
    await writeFile(file, code);
    try {
      const { coverage } = resolveComponents([file], { Opaque: "button", Unused: "input" });
      // Only the used wrapper counts; the stale `Unused` declaration is dropped.
      expect(coverage.total).toBe(1);
      expect(coverage.declared).toBe(1);
    } finally {
      await rm(file, { force: true });
    }
  });
});

describe("injectsChildren: suppress a custom helper's content FP, keep real empties", () => {
  it("treats a declared helper like <Trans> — element + its components are injected", () => {
    const ranges = transInjectedLineRanges(
      sf('const X = <MyTrans defaults="<0>hi</0>" components={[<a href="/x" />]} />;'),
      ["MyTrans"],
    );
    // Both the helper element AND the injected <a/> are covered.
    expect(ranges.length).toBe(2);
  });

  it("does NOT cover a helper that isn't declared", () => {
    expect(transInjectedLineRanges(sf("const X = <MyTrans>hi</MyTrans>;"), []).length).toBe(0);
  });
});

describe("ignore: file globs + rule ids", () => {
  it("fileIgnoreMatcher matches basenames and path globs, skips rule ids", () => {
    const matches = fileIgnoreMatcher(["**/legacy/**", "*.stories.tsx", "alt-text"]);
    expect(matches("/repo/src/legacy/old.tsx")).toBe(true);
    expect(matches("/repo/src/Button.stories.tsx")).toBe(true);
    expect(matches("/repo/src/Button.tsx")).toBe(false);
    // A rule-id entry is NOT a file glob → never matches a path.
    expect(fileIgnoreMatcher(["alt-text"])("/repo/alt-text.tsx")).toBe(false);
  });

  it("ignoredRuleIds normalizes bare + prefixed ids, drops file globs", () => {
    const ids = ignoredRuleIds(["alt-text", "jsx-a11y/anchor-is-valid", "**/legacy/**"]);
    expect(ids.has("jsx-a11y/alt-text")).toBe(true);
    expect(ids.has("jsx-a11y/anchor-is-valid")).toBe(true);
    expect(ids.size).toBe(2); // the glob is not a rule id
  });
});

describe("enforcementFor: block vs warn from the contract", () => {
  it("is block iff any SC is in enforcement.block; else warn", () => {
    const c = contractWith({});
    expect(enforcementFor(["1.3.1"], c)).toBe("block");
    expect(enforcementFor(["2.4.4"], c)).toBe("warn");
    expect(enforcementFor(["9.9.9"], c)).toBe("warn"); // unmapped → warn
  });

  it("is ADVISORY (warn) for everything when there is no contract — first-run default (ADR 0010)", () => {
    // Zero-config first run must NOT block-all: advisory-by-default so a day-one
    // scan exits 0 and reports without red-building. Blocking is opt-in only.
    expect(enforcementFor(["2.4.4"], null)).toBe("warn");
    expect(enforcementFor(["1.3.1"], null)).toBe("warn"); // an SC a contract COULD block — still advisory with no contract
    expect(enforcementFor([], null)).toBe("warn");
    expect(NO_CONTRACT_ENFORCEMENT).toBe("warn");
  });
});

describe("formatOpaqueHint: declare-bucket components become a copy-paste config to-do", () => {
  it("names the component, its module, and the components field with host options", () => {
    const hint = formatOpaqueHint({
      name: "Card",
      module: "@/components/card",
      host: null,
      provenance: "opaque",
      opaqueKind: "declare",
      library: null,
    });
    expect(hint).toContain("Card (from @/components/card) — unrecognized.");
    expect(hint).toContain('binclusive.json → "components": { "Card": "<host>" }');
    // The host can't be known → options are listed; "pick ONE" is explicit.
    expect(hint).toContain("pick ONE of:");
    expect(hint).toContain("button");
    expect(hint).toContain("input");
  });
});

describe("scan end-to-end against a config-driven temp repo", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "a11y-config-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write a binclusive.json with the given declarations into the temp repo. */
  async function writeContract(decls: Partial<Contract["declarations"]>): Promise<void> {
    const doc: Record<string, unknown> = {
      version: 1,
      stack: { framework: "next", router: "app", designSystem: "@acme/ui", language: "ts" },
      enforcement: { block: ["1.1.1"], warn: ["2.4.4"] },
      learned: [],
    };
    if (decls.components) doc.components = decls.components;
    if (decls.injectsChildren) doc.injectsChildren = decls.injectsChildren;
    if (decls.ignore) doc.ignore = decls.ignore;
    await writeFile(join(dir, "binclusive.json"), `${JSON.stringify(doc, null, 2)}\n`);
  }

  it("injectsChildren suppresses the custom-helper FP but a real empty <a/> still flags", async () => {
    await writeContract({ injectsChildren: ["LocalTrans"] });
    // `<LocalTrans>` injects content at runtime → the inner <a/> is NOT empty.
    // The standalone `<a href="/empty" />` IS empty → must still flag.
    const file = join(dir, "page.tsx");
    await writeFile(
      file,
      [
        'export const Page = () => (<><LocalTrans components={[<a href="/ok" />]} />',
        '<a href="/empty" /></>);',
      ].join("\n"),
    );
    const { findings } = await scan([file]);
    const anchorContent = findings.filter((f) => f.ruleId === "jsx-a11y/anchor-has-content");
    // Exactly one — the genuinely-empty anchor. No false negative on the real bug.
    expect(anchorContent.length).toBe(1);
  });

  it("ignore file glob drops a whole file; ignore rule id drops that rule's findings", async () => {
    const skipped = join(dir, "skip.tsx");
    const kept = join(dir, "keep.tsx");
    await writeFile(skipped, 'export const A = () => <a href="/x" />;'); // would flag
    await writeFile(kept, 'export const B = () => <a href="/y" />;'); // would flag

    // 1. Glob ignore drops the file entirely.
    await writeContract({ ignore: ["skip.tsx"] });
    const globbed = await scan([skipped, kept]);
    expect(globbed.findings.some((f) => f.file === skipped)).toBe(false);
    expect(globbed.findings.some((f) => f.file === kept)).toBe(true);

    // 2. Rule-id ignore drops every anchor-has-content finding, file kept.
    await writeContract({ ignore: ["anchor-has-content"] });
    const ruled = await scan([kept]);
    expect(ruled.findings.some((f) => f.ruleId === "jsx-a11y/anchor-has-content")).toBe(false);
  });

  it("declared components rise into mapped coverage and findings apply to them", async () => {
    await writeContract({ components: { Btn: "button" } });
    const file = join(dir, "ui.tsx");
    // `<Btn/>` is opaque without a declaration (no source on disk, not in the
    // registry). Declared as `button` → it rises into `declared` coverage.
    await writeFile(file, 'import { Btn } from "@acme/ui";\nexport const C = () => <Btn>Go</Btn>;');
    const { coverage, resolved } = await scan([file]);
    expect(coverage.declared).toBe(1);
    expect(resolved.map.Btn).toBe("button");
    // Confirm the contract was found and applied.
    const c = contractForFiles([file]);
    expect(c?.declarations.components.Btn).toBe("button");
  });

  it("no binclusive.json → zero-config: every finding is ADVISORY (warn), nothing suppressed (ADR 0010)", async () => {
    const file = join(dir, "bare.tsx");
    await writeFile(file, 'export const D = () => <a href="/z" />;');
    const { findings, contract } = await scan([file]);
    expect(contract).toBeNull();
    // Findings are still surfaced — only their gate disposition is advisory, so a
    // first-run scan reports without red-building (blocking is opt-in).
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.enforcement === "warn")).toBe(true);
  });
});
