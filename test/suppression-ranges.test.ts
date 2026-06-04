import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { scan } from "../src/core";
import {
  ariaHiddenLineRanges,
  isContentSuppressed,
  transInjectedLineRanges,
} from "../src/suppression-ranges";

const here = dirname(fileURLToPath(import.meta.url));
const page = join(here, "fixtures", "workspace-fixture", "apps", "web", "src", "app", "page.tsx");

function sf(code: string): ts.SourceFile {
  return ts.createSourceFile("t.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

describe("transInjectedLineRanges: which usages count as runtime-injected", () => {
  it("captures array-form `<Trans components={[<El/>]}>` entries", () => {
    const ranges = transInjectedLineRanges(
      sf('const X = <Trans defaults="<0>hi</0>" components={[<a href="/x" />]} />;'),
    );
    expect(ranges.length).toBe(1);
  });

  it("captures object-form `<Trans components={{ a: <El/> }}>` values", () => {
    const ranges = transInjectedLineRanges(
      sf('const X = <Trans defaults="<a>hi</a>" components={{ a: <a href="/x" /> }} />;'),
    );
    expect(ranges.length).toBe(1);
  });

  it("captures a render-delegation element when the host supplies children", () => {
    const ranges = transInjectedLineRanges(
      sf('const X = <Wrap render={<a href="/x" />}>hi</Wrap>;'),
    );
    expect(ranges.length).toBe(1);
  });

  it("does NOT capture a render-delegation element on a childless host", () => {
    // No children to inject -> a genuinely empty anchor, must stay flaggable.
    const ranges = transInjectedLineRanges(sf('const X = <Wrap render={<a href="/x" />} />;'));
    expect(ranges.length).toBe(0);
  });

  it("does NOT capture a plain element outside any injection prop", () => {
    expect(transInjectedLineRanges(sf('const X = <a href="/x" />;')).length).toBe(0);
  });
});

describe("isContentSuppressed: scope is content rules only", () => {
  const ranges = [{ start: 5, end: 7 }];
  it("suppresses a content rule on a covered line", () => {
    expect(isContentSuppressed("jsx-a11y/anchor-has-content", 6, ranges)).toBe(true);
    expect(isContentSuppressed("jsx-a11y/anchor-is-valid", 5, ranges)).toBe(true);
    expect(isContentSuppressed("jsx-a11y/heading-has-content", 7, ranges)).toBe(true);
  });
  it("never suppresses a non-content rule, even on a covered line", () => {
    expect(isContentSuppressed("jsx-a11y/aria-props", 6, ranges)).toBe(false);
    expect(isContentSuppressed("jsx-a11y/no-static-element-interactions", 6, ranges)).toBe(false);
  });
  it("does not suppress a content rule outside every range", () => {
    expect(isContentSuppressed("jsx-a11y/anchor-has-content", 9, ranges)).toBe(false);
  });
});

describe("ariaHiddenLineRanges: only literal-truthy aria-hidden counts", () => {
  it('captures `aria-hidden={true}`, `aria-hidden="true"`, and bare aria-hidden', () => {
    expect(ariaHiddenLineRanges(sf('const X = <a href="/x" aria-hidden={true} />;')).length).toBe(
      1,
    );
    expect(ariaHiddenLineRanges(sf('const X = <a href="/x" aria-hidden="true" />;')).length).toBe(
      1,
    );
    expect(ariaHiddenLineRanges(sf('const X = <a href="/x" aria-hidden />;')).length).toBe(1);
  });

  it("does NOT capture `aria-hidden={false}` or a dynamic value", () => {
    // A conditionally/dynamically hidden element must keep flagging when shown.
    expect(ariaHiddenLineRanges(sf('const X = <a href="/x" aria-hidden={false} />;')).length).toBe(
      0,
    );
    expect(ariaHiddenLineRanges(sf('const X = <a href="/x" aria-hidden={hidden} />;')).length).toBe(
      0,
    );
  });

  it("does NOT capture an element without aria-hidden", () => {
    expect(ariaHiddenLineRanges(sf('const X = <a href="/x" />;')).length).toBe(0);
  });
});

describe("scan: aria-hidden empty anchor is clean, plain empty anchor flags", () => {
  it("suppresses the aria-hidden empty <a/> but still flags the plain one", async () => {
    const ariaPage = join(here, "fixtures", "aria-hidden.tsx");
    const { findings } = await scan([ariaPage]);
    const anchorContent = findings.filter((f) => f.ruleId === "jsx-a11y/anchor-has-content");
    // Exactly one: the plain `<a href="/real" />`. The aria-hidden one is removed
    // from the a11y tree, so its "empty link" finding is a false positive.
    expect(anchorContent.length).toBe(1);
    const text = ts.sys.readFile(ariaPage) ?? "";
    const realLine = text.split("\n").findIndex((l) => l.includes('href="/real"')) + 1;
    expect(anchorContent[0]?.line).toBe(realLine);
  });
});

describe("scan: Trans-injected link is clean, genuinely-empty anchor flags", () => {
  it("flags the empty <a/> but not the Trans-injected one", async () => {
    const { findings } = await scan([page]);
    const anchorContent = findings.filter((f) => f.ruleId === "jsx-a11y/anchor-has-content");
    // Exactly one empty-anchor finding — the `<a href="/empty" />` in the
    // fixture. The Trans-injected `<LocalLink href="/register"/>` is suppressed.
    expect(anchorContent.length).toBe(1);
    // It points at the genuinely-empty anchor, not the Trans block.
    const fixtureText = ts.sys.readFile(page) ?? "";
    const emptyLine = fixtureText.split("\n").findIndex((l) => l.includes('href="/empty"')) + 1;
    expect(anchorContent[0]?.line).toBe(emptyLine);
  });
});
