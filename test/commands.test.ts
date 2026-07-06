import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractBlock } from "../src/agents-block";
import { appendLearned, CONTRACT_FILE, gen, init, learn } from "../src/commands";
import type { Contract } from "../src/contract";
import { emptyDeclarations, parseContract } from "../src/contract";

const base: Contract = {
  version: 1,
  stack: { framework: "next", router: "app", designSystem: "@b8e/design", language: "ts" },
  enforcement: { block: ["1.3.1"], warn: [] },
  learned: [],
  declarations: emptyDeclarations(),
};

describe("appendLearned (pure): append + dedupe", () => {
  it("appends a new rule with a slug id and the given timestamp", () => {
    const { next, added } = appendLearned(
      base,
      { rule: "Label icon-only buttons", wcag: ["4.1.2"], fix: "aria-label", source: "review" },
      "2026-06-01T12:00:00.000Z",
    );
    expect(added).toBe(true);
    expect(next.learned).toHaveLength(1);
    expect(next.learned[0]).toMatchObject({
      id: "label-icon-only-buttons",
      rule: "Label icon-only buttons",
      wcag: ["4.1.2"],
      fix: "aria-label",
      source: "review",
      addedAt: "2026-06-01T12:00:00.000Z",
    });
  });

  it("is a no-op for an identical rule, normalizing case + whitespace", () => {
    const once = appendLearned(
      base,
      { rule: "Label icon buttons", wcag: [], fix: null, source: "manual" },
      "t1",
    ).next;
    const { next, added } = appendLearned(
      once,
      { rule: "  LABEL   icon   buttons  ", wcag: [], fix: null, source: "manual" },
      "t2",
    );
    expect(added).toBe(false);
    expect(next.learned).toHaveLength(1);
  });
});

describe("init / learn / gen (IO) against a temp repo", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "a11y-contract-"));
    // A minimal Next app-router TS repo.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { next: "15", react: "18" } }),
    );
    await writeFile(join(dir, "tsconfig.json"), "{}");
    await writeFile(join(dir, "CLAUDE.md"), "# Pre-existing\n\nKeep this line.\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("init writes a parseable contract and managed blocks; CLAUDE.md content survives", async () => {
    const r = await init(dir);
    const onDisk = parseContract(JSON.parse(await readFile(join(dir, CONTRACT_FILE), "utf8")));
    expect(onDisk.stack.framework).toBe("next");
    expect(onDisk.stack.language).toBe("ts");
    // The corpus left the engine (ADR 0041 §G): no frequency signal drives a
    // default block set, so a fresh contract blocks nothing (opt-in per SC).
    expect(onDisk.enforcement.block).toEqual([]);
    expect(onDisk.enforcement.warn).toEqual([]);

    const claude = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("# Pre-existing");
    expect(claude).toContain("Keep this line.");
    expect(extractBlock(claude)).not.toBeNull();

    const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(extractBlock(agents)).not.toBeNull();
    expect(r.preservedLearned).toBe(0);
  });

  it("re-running init preserves learned[] and enforcement, refreshes stack", async () => {
    await init(dir);
    await learn(dir, { rule: "Custom rule", wcag: ["1.3.1"], fix: null, source: "manual" });
    // Hand-edit enforcement to prove it is preserved across init.
    const before = parseContract(JSON.parse(await readFile(join(dir, CONTRACT_FILE), "utf8")));
    const edited = { ...before, enforcement: { block: ["9.9.9"], warn: [] } };
    await writeFile(join(dir, CONTRACT_FILE), `${JSON.stringify(edited, null, 2)}\n`);

    const r = await init(dir);
    expect(r.preservedLearned).toBe(1);
    expect(r.contract.learned[0]?.rule).toBe("Custom rule");
    expect(r.contract.enforcement.block).toEqual(["9.9.9"]);
  });

  it("re-running init preserves declarations (components / injectsChildren / ignore)", async () => {
    await init(dir);
    // Hand-add the escape-hatch declarations + a manual designSystem override —
    // exactly what a customer commits by hand.
    const before = parseContract(JSON.parse(await readFile(join(dir, CONTRACT_FILE), "utf8")));
    const edited = {
      ...before,
      stack: { ...before.stack, designSystem: "@acme/ui" },
      components: { Button: "button", FancyLink: "a" },
      injectsChildren: ["LocalTrans"],
      ignore: ["**/legacy/**", "alt-text"],
    };
    await writeFile(join(dir, CONTRACT_FILE), `${JSON.stringify(edited, null, 2)}\n`);

    const r = await init(dir);
    // Every declared field survives the re-init untouched.
    expect(r.contract.declarations.components).toEqual({ Button: "button", FancyLink: "a" });
    expect(r.contract.declarations.injectsChildren).toEqual(["LocalTrans"]);
    expect(r.contract.declarations.ignore).toEqual(["**/legacy/**", "alt-text"]);
    // A manual designSystem override is not downgraded to the generic fallback.
    expect(r.contract.stack.designSystem).toBe("@acme/ui");

    // And they round-trip back to disk — a second re-init is still stable.
    const onDisk = parseContract(JSON.parse(await readFile(join(dir, CONTRACT_FILE), "utf8")));
    expect(onDisk.declarations.components).toEqual({ Button: "button", FancyLink: "a" });
    expect(onDisk.declarations.injectsChildren).toEqual(["LocalTrans"]);
    expect(onDisk.declarations.ignore).toEqual(["**/legacy/**", "alt-text"]);
  });

  it("plain init writes NO components map and no suggestions (default unchanged)", async () => {
    await writeFile(
      join(dir, "page.tsx"),
      'import { Button } from "@acme/ui";\nexport default () => <Button>x</Button>;\n',
    );
    const r = await init(dir);
    expect(r.suggestions).toBeNull();
    expect(r.contract.declarations.components).toEqual({});
    // The serialized contract omits an empty components map entirely.
    const text = await readFile(join(dir, CONTRACT_FILE), "utf8");
    expect(text).not.toContain('"components"');
  });

  it("init --suggest scaffolds the components map and reports the guesses", async () => {
    // A page using external @acme/ui leaf primitives + a composite + a toggle.
    await writeFile(
      join(dir, "page.tsx"),
      [
        'import { Button, TextField, Select, Modal, Checkbox } from "@acme/ui";',
        "export default () => (",
        "  <Modal>",
        "    <Button>x</Button>",
        '    <TextField label="n" />',
        "    <Select />",
        "    <Checkbox />",
        "  </Modal>",
        ");",
      ].join("\n"),
    );

    const r = await init(dir, { suggest: true });
    expect(r.suggestions).not.toBeNull();

    // Confident leaf hosts are merged into the written contract.
    expect(r.contract.declarations.components.Button).toBe("button");
    expect(r.contract.declarations.components.TextField).toBe("input");
    expect(r.contract.declarations.components.Select).toBe("select");
    // Composite + toggle are NOT mapped — they stay in declare.
    expect(r.contract.declarations.components.Modal).toBeUndefined();
    expect(r.contract.declarations.components.Checkbox).toBeUndefined();

    // The map round-trips to disk so the user can review/edit it before commit.
    const onDisk = parseContract(JSON.parse(await readFile(join(dir, CONTRACT_FILE), "utf8")));
    expect(onDisk.declarations.components).toMatchObject({
      Button: "button",
      TextField: "input",
      Select: "select",
    });

    // The suggestion report flags Select for review and leaves Modal in declare.
    const select = r.suggestions?.suggestions.find((s) => s.name === "Select");
    expect(select?.confidence).toBe("verify");
    expect(r.suggestions?.skipped).toContain("Modal");
  });

  it("init --suggest never overrides a manually-declared host", async () => {
    await writeFile(
      join(dir, "page.tsx"),
      'import { Button } from "@acme/ui";\nexport default () => <Button>x</Button>;\n',
    );
    // Customer already declared Button as a div — the guess must not clobber it.
    await init(dir);
    const before = parseContract(JSON.parse(await readFile(join(dir, CONTRACT_FILE), "utf8")));
    await writeFile(
      join(dir, CONTRACT_FILE),
      `${JSON.stringify({ ...before, components: { Button: "div" } }, null, 2)}\n`,
    );

    const r = await init(dir, { suggest: true });
    expect(r.contract.declarations.components.Button).toBe("div");
  });

  it("a malformed declarations field is dropped, the rest of the contract still loads", async () => {
    await init(dir);
    const before = parseContract(JSON.parse(await readFile(join(dir, CONTRACT_FILE), "utf8")));
    // `components` is the wrong type (array, not object) AND one ignore entry is
    // a number — both bad. The contract must still load with the good parts.
    const edited = {
      ...before,
      components: ["not", "an", "object"],
      injectsChildren: ["GoodHelper", 42],
      ignore: ["good-glob/*", 7],
    };
    await writeFile(join(dir, CONTRACT_FILE), `${JSON.stringify(edited, null, 2)}\n`);

    const r = await init(dir);
    // Bad `components` → empty; bad elements dropped, good ones kept.
    expect(r.contract.declarations.components).toEqual({});
    expect(r.contract.declarations.injectsChildren).toEqual(["GoodHelper"]);
    expect(r.contract.declarations.ignore).toEqual(["good-glob/*"]);
    // The rest of the contract is intact — a bad field never crashed the load.
    expect(r.contract.learned).toEqual([]);
    // Corpus-free default: enforcement blocks nothing by default (ADR 0041 §G).
    expect(r.contract.enforcement.block).toEqual([]);
  });

  it("learn appends, dedupes, and keeps the block in sync", async () => {
    await init(dir);
    const first = await learn(dir, {
      rule: "Label icon-only buttons",
      wcag: ["4.1.2"],
      fix: "aria-label",
      source: "review",
    });
    expect(first.added).toBe(true);

    const dup = await learn(dir, {
      rule: "label icon-only buttons",
      wcag: ["4.1.2"],
      fix: null,
      source: "review",
    });
    expect(dup.added).toBe(false);

    const onDisk = parseContract(JSON.parse(await readFile(join(dir, CONTRACT_FILE), "utf8")));
    expect(onDisk.learned).toHaveLength(1);

    const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("Label icon-only buttons");
  });

  it("gen --check passes after init, fails after a hand-edit to binclusive.json", async () => {
    await init(dir);
    const clean = await gen(dir, true);
    expect(clean.inSync).toBe(true);
    expect(clean.entries.every((e) => e.status === "ok")).toBe(true);

    // Change the contract WITHOUT regenerating → on-disk block now drifts.
    const c = parseContract(JSON.parse(await readFile(join(dir, CONTRACT_FILE), "utf8")));
    const drifted = { ...c, stack: { ...c.stack, designSystem: "@mui/material" } };
    await writeFile(join(dir, CONTRACT_FILE), `${JSON.stringify(drifted, null, 2)}\n`);

    const dirty = await gen(dir, true);
    expect(dirty.inSync).toBe(false);
    expect(dirty.entries.some((e) => e.status === "drift")).toBe(true);

    // Regenerate → back in sync.
    await gen(dir, false);
    const fixed = await gen(dir, true);
    expect(fixed.inSync).toBe(true);
  });
});
