import { describe, expect, it } from "vitest";
import {
  type Finding,
  findingKey,
  keyOf,
  markerFor,
  parseFindings,
  type PrCommentClient,
  reconcile,
  renderBody,
  type ReviewComment,
  syncComments,
  syncCommentsBestEffort,
} from "../src/pr-comment";

/**
 * De-dup reconciler for inline PR review comments (issue #2131). The core is the
 * pure {@link reconcile}: given desired findings + the comments already on the
 * PR, it decides create / update / delete so a re-run converges to ONE comment
 * per finding instead of re-POSTing every push.
 */

const finding = (over: Partial<Finding> = {}): Finding => ({
  ruleId: "img-alt",
  file: "src/App.tsx",
  line: 12,
  message: "Image missing alt text.",
  ...over,
});

/** An existing comment as our own agent would have left it (marker embedded). */
const ourComment = (id: number, f: Finding): ReviewComment => ({ id, body: renderBody(f) });

describe("marker identity", () => {
  it("keys a finding by rule + location, not message", () => {
    expect(findingKey(finding())).toBe("img-alt:src/App.tsx:12");
    // same rule + spot, different wording → same key (updates in place)
    expect(findingKey(finding({ message: "different wording" }))).toBe(findingKey(finding()));
    // moved line → different key (delete-old + create-new)
    expect(findingKey(finding({ line: 20 }))).not.toBe(findingKey(finding()));
  });

  it("embeds a hidden marker that round-trips to the key", () => {
    const f = finding();
    expect(markerFor(f)).toBe("<!-- binclusive-a11y-agent:img-alt:src/App.tsx:12 -->");
    expect(keyOf(renderBody(f))).toBe(findingKey(f));
  });

  it("returns null for a comment that is not ours (no marker) — human comments are off-limits", () => {
    expect(keyOf("Looks good to me, ship it!")).toBeNull();
    expect(keyOf("**a11y** but hand-written, no marker")).toBeNull();
  });
});

describe("marker identity — selector disambiguates co-located same-rule findings (#2131 review grill #1)", () => {
  it("gives two same-rule, same-file, same-line findings DISTINCT keys when their selectors differ", () => {
    const a = finding({ selector: "html > body > img:nth-child(1)" });
    const b = finding({ selector: "html > body > img:nth-child(2)" });
    // same ruleId:file:line, but distinct selectors ⇒ distinct keys (no collapse)
    expect(findingKey(a)).not.toBe(findingKey(b));
    // same selector ⇒ same key (still updates in place across pushes)
    expect(findingKey(finding({ selector: "img.logo" }))).toBe(findingKey(finding({ selector: "img.logo" })));
  });

  it("leaves a selector-less (source-pass) finding's key at the bare ruleId:file:line", () => {
    expect(findingKey(finding())).toBe("img-alt:src/App.tsx:12");
    // whitespace-only selector is NOT a selector — no disambiguation, base key stands
    expect(findingKey(finding({ selector: "   " }))).toBe("img-alt:src/App.tsx:12");
  });

  it("encodes the selector marker-safely — no `-->` or newline can break the HTML-comment marker", () => {
    // a selector engineered to break a naive marker: contains `-->` and a newline
    const nasty = finding({ selector: "div --> </script>\n<img>" });
    const marker = markerFor(nasty);
    expect(marker).toMatch(/^<!-- binclusive-a11y-agent:.* -->$/);
    // the marker still round-trips: the comment is recognized as ours by its key
    expect(keyOf(renderBody(nasty))).toBe(findingKey(nasty));
    // no premature close, no newline smuggled into the single-line marker
    expect(marker.slice(4, -3)).not.toContain("-->");
    expect(marker).not.toContain("\n");
  });
});

describe("reconcile — create vs update vs delete", () => {
  it("creates a comment for a brand-new finding on an empty PR", () => {
    const plan = reconcile([finding()], []);
    expect(plan.create).toHaveLength(1);
    expect(plan.update).toHaveLength(0);
    expect(plan.remove).toHaveLength(0);
  });

  it("does NOT create a duplicate when the finding is already commented (AC1)", () => {
    const f = finding();
    const plan = reconcile([f], [ourComment(1, f)]);
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    // identical body → left untouched, no API churn
    expect(plan.unchanged).toEqual([1]);
    expect(plan.remove).toHaveLength(0);
  });

  it("updates in place when the same finding's message drifted — no second comment (AC1)", () => {
    const before = finding({ message: "old wording" });
    const after = finding({ message: "new wording" });
    const plan = reconcile([after], [ourComment(1, before)]);
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toEqual([{ id: 1, finding: after }]);
    expect(plan.remove).toHaveLength(0);
  });

  it("removes the comment of a finding that has since been fixed (AC2)", () => {
    const fixed = finding();
    // this run reports NO findings, but the fixed finding's comment is still on the PR
    const plan = reconcile([], [ourComment(7, fixed)]);
    expect(plan.remove).toEqual([7]);
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
  });

  it("never touches comments that are not ours", () => {
    const human: ReviewComment = { id: 99, body: "please fix this manually" };
    const plan = reconcile([], [human]);
    expect(plan.remove).toHaveLength(0);
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
  });

  it("cleans up leftover duplicates from before dedup existed (keeps one, removes the rest)", () => {
    const f = finding();
    // three copies of the same finding from old spamming runs
    const plan = reconcile([f], [ourComment(1, f), ourComment(2, f), ourComment(3, f)]);
    expect(plan.create).toHaveLength(0);
    // one canonical copy kept (unchanged), the two extras removed
    expect(plan.unchanged).toEqual([1]);
    expect(plan.remove.sort()).toEqual([2, 3]);
  });

  it("posts BOTH of two co-located same-rule findings with distinct selectors — no silent drop (#2131 grill #1)", () => {
    const a = finding({ selector: "img:nth-child(1)" });
    const b = finding({ selector: "img:nth-child(2)" });
    const plan = reconcile([a, b], []);
    // pre-fix, both keyed to `img-alt:src/App.tsx:12` → the second was dropped;
    // now distinct selectors ⇒ distinct keys ⇒ two creates.
    expect(plan.create).toHaveLength(2);
    expect(plan.create).toEqual([a, b]);
    expect(plan.remove).toHaveLength(0);
  });

  it("handles a mixed run: one kept, one new, one fixed", () => {
    const kept = finding({ ruleId: "img-alt", line: 12 });
    const fixed = finding({ ruleId: "label", line: 30 });
    const fresh = finding({ ruleId: "contrast", line: 45 });
    const plan = reconcile([kept, fresh], [ourComment(1, kept), ourComment(2, fixed)]);
    expect(plan.unchanged).toEqual([1]);
    expect(plan.create).toEqual([fresh]);
    expect(plan.remove).toEqual([2]);
  });
});

describe("reconcile — idempotency", () => {
  it("converges: re-running the same scan is an all-unchanged no-op (never accumulates)", () => {
    const fs = [finding({ line: 1 }), finding({ line: 2 })];
    const existing = fs.map((f, i) => ourComment(i + 1, f));
    const plan = reconcile(fs, existing);
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    expect(plan.remove).toHaveLength(0);
    expect(plan.unchanged.sort()).toEqual([1, 2]);
  });
});

/** In-memory GitHub client — the mocked comments API the sync drives. */
class FakeClient implements PrCommentClient {
  created: Finding[] = [];
  updated: { id: number; finding: Finding }[] = [];
  removed: number[] = [];
  constructor(private existing: ReviewComment[] = []) {}
  list(): Promise<ReviewComment[]> {
    return Promise.resolve(this.existing);
  }
  create(f: Finding): Promise<void> {
    this.created.push(f);
    return Promise.resolve();
  }
  update(id: number, f: Finding): Promise<void> {
    this.updated.push({ id, finding: f });
    return Promise.resolve();
  }
  remove(id: number): Promise<void> {
    this.removed.push(id);
    return Promise.resolve();
  }
}

describe("syncComments — drives the mocked comments API", () => {
  it("first run on an empty PR creates each finding once", async () => {
    const client = new FakeClient([]);
    await syncComments([finding({ line: 1 }), finding({ line: 2 })], client);
    expect(client.created).toHaveLength(2);
    expect(client.updated).toHaveLength(0);
    expect(client.removed).toHaveLength(0);
  });

  it("second push (same findings) issues NO create/update/delete — pure no-op", async () => {
    const fs = [finding({ line: 1 }), finding({ line: 2 })];
    const client = new FakeClient(fs.map((f, i) => ourComment(i + 1, f)));
    await syncComments(fs, client);
    expect(client.created).toHaveLength(0);
    expect(client.updated).toHaveLength(0);
    expect(client.removed).toHaveLength(0);
  });

  it("a fixed finding gets its comment deleted on the next run", async () => {
    const fixed = finding();
    const client = new FakeClient([ourComment(5, fixed)]);
    await syncComments([], client);
    expect(client.removed).toEqual([5]);
    expect(client.created).toHaveLength(0);
  });
});

/**
 * A client whose `list()` fails — the partial-pagination-failure case. Reconciling
 * against a truncated list would re-CREATE comments on unfetched pages (duplicates),
 * so a list failure must ABORT the sync (throw) before any create/update/delete.
 */
class ListFailsClient implements PrCommentClient {
  created: Finding[] = [];
  updated: { id: number; finding: Finding }[] = [];
  removed: number[] = [];
  list(): Promise<ReviewComment[]> {
    return Promise.reject(new Error("list page 2 -> 500 (a page fetch failed)"));
  }
  create(f: Finding): Promise<void> {
    this.created.push(f);
    return Promise.resolve();
  }
  update(id: number, f: Finding): Promise<void> {
    this.updated.push({ id, finding: f });
    return Promise.resolve();
  }
  remove(id: number): Promise<void> {
    this.removed.push(id);
    return Promise.resolve();
  }
}

describe("syncComments — aborts on a partial-list failure (#2131 grill #4)", () => {
  it("a list-page fetch failure aborts the sync — NO create/update/delete (no duplicate POSTs)", async () => {
    const client = new ListFailsClient();
    // syncComments propagates the list failure (the abort); it must not have written anything
    await expect(syncComments([finding({ line: 1 }), finding({ line: 2 })], client)).rejects.toThrow(/list page/);
    expect(client.created).toHaveLength(0);
    expect(client.updated).toHaveLength(0);
    expect(client.removed).toHaveLength(0);
  });
});

describe("syncCommentsBestEffort — never throws, so the CI job always exits 0 (#2131 grill #5)", () => {
  it("swallows a list-abort throw and returns null (no create/update/delete)", async () => {
    const client = new ListFailsClient();
    const plan = await syncCommentsBestEffort([finding()], client);
    expect(plan).toBeNull();
    expect(client.created).toHaveLength(0);
  });

  it("swallows a throw raised mid-sync (in create) — resolves rather than rejecting", async () => {
    const client: PrCommentClient = {
      list: () => Promise.resolve([]),
      create: () => Promise.reject(new Error("POST exploded")),
      update: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    // the raw syncComments rejects…
    await expect(syncComments([finding()], client)).rejects.toThrow(/exploded/);
    // …but the best-effort boundary the CLI runs never does — the process still exits 0
    await expect(syncCommentsBestEffort([finding()], client)).resolves.toBeNull();
  });
});

describe("parseFindings — boundary parse of the report JSON", () => {
  it("narrows well-formed findings and drops malformed entries", () => {
    const parsed = parseFindings({
      findings: [
        { ruleId: "img-alt", file: "a.tsx", line: 3, message: "m", wcag: ["1.1.1"] },
        { ruleId: "no-line", file: "b.tsx" }, // dropped: no numeric line
        { file: "c.tsx", line: 4 }, // dropped: no ruleId
        "garbage",
      ],
    });
    // criterion falls back to the first wcag tag (for the #2132 rollup) when the
    // report predates the explicit `criterion` field.
    expect(parsed).toEqual([
      { ruleId: "img-alt", file: "a.tsx", line: 3, message: "m", wcag: ["1.1.1"], criterion: "1.1.1" },
    ]);
  });

  it("carries the contract severity + criterion through for the rollup, narrowing an unknown severity out", () => {
    const parsed = parseFindings({
      findings: [
        { ruleId: "img-alt", file: "a.tsx", line: 3, message: "m", wcag: ["1.1.1"], severity: "critical", criterion: "1.1.1" },
        { ruleId: "bogus-sev", file: "b.tsx", line: 4, message: "m", severity: "catastrophic" }, // severity dropped: not the contract enum
      ],
    });
    expect(parsed[0]?.severity).toBe("critical");
    expect(parsed[0]?.criterion).toBe("1.1.1");
    expect(parsed[1]?.severity).toBeUndefined();
  });

  it("preserves the selector across the boundary so it can distinguish co-located findings (#2131 grill #1)", () => {
    const parsed = parseFindings({
      findings: [
        { ruleId: "image-alt", file: "/page", line: 0, message: "m", selector: "img:nth-child(1)" },
        { ruleId: "image-alt", file: "/page", line: 0, message: "m", selector: "img:nth-child(2)" },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.selector).toBe("img:nth-child(1)");
    expect(parsed[1]?.selector).toBe("img:nth-child(2)");
    // the whole point: distinct selectors survive into distinct keys
    expect(findingKey(parsed[0] as Finding)).not.toBe(findingKey(parsed[1] as Finding));
  });

  it("drops a non-string selector rather than smuggling it inward", () => {
    const [f] = parseFindings({ findings: [{ ruleId: "r", file: "f", line: 1, message: "m", selector: 42 }] });
    expect(f?.selector).toBeUndefined();
  });

  it("returns [] for non-object / missing findings", () => {
    expect(parseFindings(null)).toEqual([]);
    expect(parseFindings({})).toEqual([]);
    expect(parseFindings({ findings: "nope" })).toEqual([]);
  });
});
