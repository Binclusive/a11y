import { describe, expect, it } from "vitest";
import {
  type Contract,
  ContractParseError,
  emptyDeclarations,
  parseContract,
  serializeContract,
  validateDeclaredHosts,
} from "../src/contract";

const valid: Contract = {
  version: 1,
  stack: { framework: "next", router: "app", designSystem: "@b8e/design", language: "ts" },
  enforcement: { block: ["1.3.1", "4.1.2"], warn: ["2.4.4"] },
  learned: [
    {
      id: "always-label-icon-buttons",
      rule: "Always label icon-only buttons",
      wcag: ["4.1.2"],
      fix: "Add aria-label",
      source: "manual",
      addedAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  declarations: emptyDeclarations(),
};

describe("parseContract: valid documents", () => {
  it("round-trips a fully-populated contract", () => {
    const parsed = parseContract(JSON.parse(serializeContract(valid)));
    expect(parsed).toEqual(valid);
  });

  it("accepts a minimal contract with null router and empty learned", () => {
    const min = {
      version: 1,
      stack: { framework: "react", router: null, designSystem: "custom", language: "js" },
      enforcement: { block: [], warn: [] },
      learned: [],
    };
    // A zero-config contract carries no escape-hatch fields on disk; the parser
    // still returns an empty declarations block (the pipeline never branches on
    // presence).
    expect(parseContract(min)).toEqual({ ...min, declarations: emptyDeclarations() });
  });

  it("de-dupes warn against block — block always wins", () => {
    const doc = {
      version: 1,
      stack: { framework: "next", router: "pages", designSystem: "@mui/material", language: "ts" },
      enforcement: { block: ["1.3.1"], warn: ["1.3.1", "2.4.4"] },
      learned: [],
    };
    expect(parseContract(doc).enforcement).toEqual({ block: ["1.3.1"], warn: ["2.4.4"] });
  });

  it("coerces a missing learned.fix to null", () => {
    const doc = {
      version: 1,
      stack: { framework: "next", router: "app", designSystem: "custom", language: "ts" },
      enforcement: { block: [], warn: [] },
      learned: [
        { id: "r", rule: "do x", wcag: [], fix: null, source: "manual", addedAt: "2026-01-01" },
      ],
    };
    expect(parseContract(doc).learned[0]?.fix).toBeNull();
  });
});

describe("parseContract: malformed documents fail loud", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["non-object top level", 42],
    ["null top level", null],
    ["wrong version", { ...valid, version: 2 }],
    ["missing stack", { version: 1, enforcement: { block: [], warn: [] }, learned: [] }],
    ["bad router", { ...valid, stack: { ...valid.stack, router: "modal" } }],
    ["bad language", { ...valid, stack: { ...valid.stack, language: "rust" } }],
    ["non-string framework", { ...valid, stack: { ...valid.stack, framework: 7 } }],
    ["learned not an array", { ...valid, learned: {} }],
    ["non-string element in block", { ...valid, enforcement: { block: [1], warn: [] } }],
    [
      "learned rule missing id",
      { ...valid, learned: [{ rule: "x", wcag: [], fix: null, source: "m", addedAt: "z" }] },
    ],
    [
      "learned fix wrong type",
      {
        ...valid,
        learned: [{ id: "a", rule: "x", wcag: [], fix: 5, source: "m", addedAt: "z" }],
      },
    ],
  ];

  for (const [name, doc] of cases) {
    it(`throws ContractParseError on: ${name}`, () => {
      expect(() => parseContract(doc)).toThrow(ContractParseError);
    });
  }
});

describe("parseContract: optional escape-hatch declarations", () => {
  const baseDoc = {
    version: 1,
    stack: { framework: "next", router: "app", designSystem: "@acme/ui", language: "ts" },
    enforcement: { block: [], warn: [] },
    learned: [],
  };

  it("reads flat components / injectsChildren / ignore fields", () => {
    const d = parseContract({
      ...baseDoc,
      components: { Button: "button", FancyLink: "a" },
      injectsChildren: ["LocalTrans"],
      ignore: ["**/legacy/**", "alt-text"],
    }).declarations;
    expect(d.components).toEqual({ Button: "button", FancyLink: "a" });
    expect(d.injectsChildren).toEqual(["LocalTrans"]);
    expect(d.ignore).toEqual(["**/legacy/**", "alt-text"]);
  });

  it("a malformed single field degrades to empty/valid, never throws", () => {
    // Each optional field is the escape hatch — a bad entry is dropped, the rest
    // of the contract still loads. A bad line must NOT hard-fail the config.
    const d = parseContract({
      ...baseDoc,
      components: { Button: "button", Bad: 7 }, // Bad value dropped, Button kept
      injectsChildren: ["Good", 42], // 42 dropped
      ignore: 99, // wrong whole-field type → empty
    }).declarations;
    expect(d.components).toEqual({ Button: "button" });
    expect(d.injectsChildren).toEqual(["Good"]);
    expect(d.ignore).toEqual([]);
  });

  it("a contract with no declarations parses to empty declarations", () => {
    const d = parseContract(baseDoc).declarations;
    expect(d).toEqual({ components: {}, injectsChildren: [], ignore: [] });
  });
});

describe("validateDeclaredHosts: pure diagnostic helper", () => {
  it("returns no diagnostics for valid single-tag hosts", () => {
    expect(validateDeclaredHosts({ Button: "button", Link: "a", Field: "input" })).toEqual([]);
  });

  it("diagnoses the pasted declare-hint placeholder (value contains |)", () => {
    const diags = validateDeclaredHosts({
      Button: "button|a|input|textarea|select|label|div",
    });
    expect(diags).toHaveLength(1);
    expect(diags[0]).toContain('"Button"');
    expect(diags[0]).toContain("un-edited declare hint");
    expect(diags[0]).toContain('pick ONE host');
  });

  it("diagnoses hosts with spaces or uppercase (not a valid tag token)", () => {
    const diags = validateDeclaredHosts({ Widget: "Button", Wrap: "my element" });
    expect(diags).toHaveLength(2);
    expect(diags.every((d) => d.includes("not a valid intrinsic tag"))).toBe(true);
  });

  it("valid host 'button' produces no diagnostic, bad host is excluded", () => {
    // Only the bad entry gets a diagnostic; the valid one is silent.
    const diags = validateDeclaredHosts({
      Good: "button",
      Bad: "button|a|input|textarea|select|label|div",
    });
    expect(diags).toHaveLength(1);
    expect(diags[0]).toContain('"Bad"');
  });
});

describe("parseContract: invalid host values are filtered at load time", () => {
  const baseDoc = {
    version: 1,
    stack: { framework: "next", router: "app", designSystem: "@acme/ui", language: "ts" },
    enforcement: { block: [], warn: [] },
    learned: [],
  };

  it("pasted declare-hint placeholder is NOT applied as a host mapping", () => {
    const d = parseContract({
      ...baseDoc,
      components: {
        Button: "button|a|input|textarea|select|label|div",
        Link: "a",
      },
    }).declarations;
    // Invalid entry is stripped — only the valid one remains.
    expect(d.components).not.toHaveProperty("Button");
    expect(d.components.Link).toBe("a");
  });

  it("host with spaces or uppercase is NOT applied", () => {
    const d = parseContract({
      ...baseDoc,
      components: { Widget: "Button", Valid: "button" },
    }).declarations;
    expect(d.components).not.toHaveProperty("Widget");
    expect(d.components.Valid).toBe("button");
  });

  it("a valid host is applied silently and the count is correct", () => {
    const d = parseContract({
      ...baseDoc,
      components: { Btn: "button", FancyLink: "a" },
    }).declarations;
    expect(d.components).toEqual({ Btn: "button", FancyLink: "a" });
  });
});

describe("serializeContract", () => {
  it("emits 2-space JSON with a trailing newline", () => {
    const out = serializeContract(valid);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain('  "version": 1');
  });

  it("omits empty escape-hatch fields, emits them flat when present", () => {
    // Zero-config contract: no components/injectsChildren/ignore keys on disk.
    expect(serializeContract(valid)).not.toContain('"components"');

    const withDecls: Contract = {
      ...valid,
      declarations: { components: { Btn: "button" }, injectsChildren: ["T"], ignore: ["*.x.tsx"] },
    };
    const out = serializeContract(withDecls);
    expect(out).toContain('"components"');
    expect(out).toContain('"Btn": "button"');
    expect(out).toContain('"injectsChildren"');
    expect(out).toContain('"ignore"');
    // Round-trips back through the parser.
    expect(parseContract(JSON.parse(out)).declarations).toEqual(withDecls.declarations);
  });
});
