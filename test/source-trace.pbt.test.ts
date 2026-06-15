// Property-based hardening of the render-shape resolver (`traceComponent`).
//
// The precision invariant that protects against false positives:
//
//   For ANY wrapper, traceComponent returns either `null` (opaque) OR a host
//   that EXACTLY matches the single forwarded root host of the source. It must
//   NEVER map a wrapper to the WRONG host — a wrong host makes jsx-a11y run the
//   wrong rules at the call site, which is the cry-wolf finding that gets an
//   a11y tool uninstalled. Opaque is always safe; wrong-host is a bug.
//
// Two properties, so an "always return null" implementation can't pass trivially:
//   P1 Soundness  — every resolution equals the source's ground-truth host.
//   P2 Completeness — the canonical resolvable shapes (forward / forwardRef /
//                     Slot / shallow barrel) DO resolve, they don't go opaque.
//
// We drive the REAL public path (resolution + barrel-following + Slot
// transparency, the fix/shadcn-barrel-classification concern) by writing each
// generated module graph to a unique temp dir — unique paths sidestep the
// process-lifetime fileCache, so no run sees another's stale AST.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { traceComponent } from "../src/source-trace";

const ROOT = mkdtempSync(join(tmpdir(), "trace-pbt-"));
let counter = 0;
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

interface Scenario {
  readonly label: string;
  readonly files: Record<string, string>;
  readonly specifier: string;
  readonly exportName: string;
  /** The ground-truth host this source renders, or null when it MUST stay opaque. */
  readonly expectedHost: string | null;
  /** Canonical shape that the resolver is expected to resolve (anti-degenerate). */
  readonly mustResolve: boolean;
}

// Lowercase intrinsic host elements — what a wrapper can resolve TO.
const HOSTS = ["button", "a", "input", "nav", "span", "div", "ul", "h1", "h2", "label", "section"] as const;
const arbHost = fc.constantFrom(...HOSTS);
const arbHostPair = fc.tuple(arbHost, arbHost).filter(([x, y]) => x !== y);

const CONSUMER = "export const x = 1;\n";

function scenario(s: Omit<Scenario, "files"> & { files: Record<string, string> }): Scenario {
  return { ...s, files: { "consumer.tsx": CONSUMER, ...s.files } };
}

// --- RESOLVABLE shapes (expectedHost = host, mustResolve = true) ---------------

// `const W = (props) => <host {...props} />` — the canonical thin wrapper.
const forwardArrow = (host: string): Scenario =>
  scenario({
    label: `forwardArrow<${host}>`,
    files: { "w.tsx": `export const W = (props: any) => <${host} {...props} />;\n` },
    specifier: "./w",
    exportName: "W",
    expectedHost: host,
    mustResolve: true,
  });

// `forwardRef((props, ref) => <host ref={ref} {...props} />)`.
const forwardRefShape = (host: string): Scenario =>
  scenario({
    label: `forwardRef<${host}>`,
    files: {
      "w.tsx": `import * as React from "react";\nexport const W = React.forwardRef((props: any, ref: any) => <${host} ref={ref} {...props} />);\n`,
    },
    specifier: "./w",
    exportName: "W",
    expectedHost: host,
    mustResolve: true,
  });

// shadcn if/else Slot form: {Slot, host} -> Slot is transparent -> {host}.
const slotIfElse = (host: string): Scenario =>
  scenario({
    label: `slotIfElse<${host}>`,
    files: {
      "w.tsx":
        `import { Slot } from "@radix-ui/react-slot";\nimport * as React from "react";\n` +
        `export const W = React.forwardRef(({ asChild = false, ...props }: any, ref: any) => {\n` +
        `  if (asChild) { return <Slot ref={ref} {...props} />; }\n` +
        `  return <${host} ref={ref} {...props} />;\n});\n`,
    },
    specifier: "./w",
    exportName: "W",
    expectedHost: host,
    mustResolve: true,
  });

// cal.com ternary Slot form: `const Tag = asChild ? Slot : "host"; <Tag {...props} />`.
const slotTernary = (host: string): Scenario =>
  scenario({
    label: `slotTernary<${host}>`,
    files: {
      "w.tsx":
        `import { Slot } from "@radix-ui/react-slot";\n` +
        `export const W = ({ asChild, ...props }: any) => {\n` +
        `  const Tag = asChild ? Slot : "${host}";\n` +
        `  return <Tag {...props} />;\n};\n`,
    },
    specifier: "./w",
    exportName: "W",
    expectedHost: host,
    mustResolve: true,
  });

// Barrel re-export chain of depth k. Re-export budget is MAX_DEPTH=3, so chains
// of <=3 barrels reach the definition; deeper chains must go opaque (but never
// wrong). expectedHost stays the true host either way — soundness holds for both.
const barrel = (host: string, k: number): Scenario => {
  const files: Record<string, string> = {
    "w.tsx": `export const W = (props: any) => <${host} {...props} />;\n`,
  };
  for (let i = 0; i < k; i++) {
    const next = i === k - 1 ? "./w" : `./b${i + 1}`;
    files[`b${i}.tsx`] = `export { W } from "${next}";\n`;
  }
  return scenario({
    label: `barrel<${host}, depth=${k}>`,
    files,
    specifier: "./b0",
    exportName: "W",
    expectedHost: host,
    mustResolve: k <= 3,
  });
};

// --- OPAQUE shapes (expectedHost = null, mustResolve = false) -------------------

// No prop-forwarding -> call-site props never reach the host -> must stay opaque.
const noForward = (host: string): Scenario =>
  scenario({
    label: `noForward<${host}>`,
    files: { "w.tsx": `export const W = () => <${host} title="x" />;\n` },
    specifier: "./w",
    exportName: "W",
    expectedHost: null,
    mustResolve: false,
  });

// Two genuinely distinct hosts, no Slot -> ambiguous composite -> opaque.
const composite = ([h1, h2]: [string, string]): Scenario =>
  scenario({
    label: `composite<${h1},${h2}>`,
    files: {
      "w.tsx":
        `export const W = (props: any) => {\n` +
        `  if (props.x) { return <${h1} {...props} />; }\n` +
        `  return <${h2} {...props} />;\n};\n`,
    },
    specifier: "./w",
    exportName: "W",
    expectedHost: null,
    mustResolve: false,
  });

// Arrow conditional body `cond ? <h1/> : <h2/>` — jsxTagOf can't read a
// conditional, so nothing is recorded -> opaque. (Must never guess a branch.)
const ambiguous = ([h1, h2]: [string, string]): Scenario =>
  scenario({
    label: `ambiguous<${h1},${h2}>`,
    files: {
      "w.tsx": `export const W = (props: any) => props.wide ? <${h1} {...props} /> : <${h2} {...props} />;\n`,
    },
    specifier: "./w",
    exportName: "W",
    expectedHost: null,
    mustResolve: false,
  });

// A local `Slot` NOT from Radix carries no pass-through semantics -> {MySlot,
// host} stays two-host -> opaque. Proves transparency keys on import origin.
const fakeSlot = (host: string): Scenario =>
  scenario({
    label: `fakeSlot<${host}>`,
    files: {
      "w.tsx":
        `import { Slot as MySlot } from "./my-slot";\n` +
        `export const W = (props: any) => {\n` +
        `  if (props.x) { return <MySlot {...props} />; }\n` +
        `  return <${host} {...props} />;\n};\n`,
    },
    specifier: "./w",
    exportName: "W",
    expectedHost: null,
    mustResolve: false,
  });

const arbScenario: fc.Arbitrary<Scenario> = fc.oneof(
  arbHost.map(forwardArrow),
  arbHost.map(forwardRefShape),
  arbHost.map(slotIfElse),
  arbHost.map(slotTernary),
  arbHost.map(noForward),
  arbHostPair.map(composite),
  arbHostPair.map(ambiguous),
  arbHost.map(fakeSlot),
  fc.tuple(arbHost, fc.integer({ min: 1, max: 5 })).map(([h, k]) => barrel(h, k)),
);

function runTrace(s: Scenario): ReturnType<typeof traceComponent> {
  const dir = join(ROOT, `r${counter++}`);
  mkdirSync(dir);
  for (const [name, content] of Object.entries(s.files)) writeFileSync(join(dir, name), content);
  return traceComponent(s.specifier, s.exportName, join(dir, "consumer.tsx"));
}

describe("source-trace: render-shape resolver is sound (never the wrong host)", () => {
  it("P1 — every resolution equals the source's ground-truth host", () => {
    fc.assert(
      fc.property(arbScenario, (s) => {
        const result = runTrace(s);
        if (result !== null) {
          // The crux: a non-opaque answer is ALWAYS the correct host. For opaque
          // shapes expectedHost is null, so any resolution here is a precision bug.
          expect(result.host, `${s.label}: resolved to a wrong host`).toBe(s.expectedHost);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("P2 — canonical resolvable shapes do not go opaque", () => {
    fc.assert(
      fc.property(
        arbScenario.filter((s) => s.mustResolve),
        (s) => {
          const result = runTrace(s);
          expect(result, `${s.label}: should resolve, went opaque`).not.toBeNull();
          expect(result?.host).toBe(s.expectedHost);
        },
      ),
      { numRuns: 300 },
    );
  });
});
