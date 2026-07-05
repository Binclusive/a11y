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
    expect(parsed).toEqual([{ ruleId: "img-alt", file: "a.tsx", line: 3, message: "m", wcag: ["1.1.1"] }]);
  });

  it("returns [] for non-object / missing findings", () => {
    expect(parseFindings(null)).toEqual([]);
    expect(parseFindings({})).toEqual([]);
    expect(parseFindings({ findings: "nope" })).toEqual([]);
  });
});
