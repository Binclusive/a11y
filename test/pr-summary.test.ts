import { describe, expect, it } from "vitest";
import type { Finding } from "../src/pr-comment";
import {
  computeRollup,
  isRollupComment,
  reconcileRollup,
  renderJobSummary,
  ROLLUP_MARKER,
  renderRollupComment,
  type RollupClient,
  type RollupComment,
  syncRollup,
  syncRollupBestEffort,
} from "../src/pr-summary";

/**
 * The consolidated PR summary / rollup (issue #2132). The counts derive from the
 * contract's `severity` + `criterion` metadata and are computed over the findings
 * deduped by the SAME identity the inline reconciler uses, so the rollup total
 * equals the inline-comment count on a converged PR. Exactly ONE rollup comment
 * is kept, found by a stable marker and updated in place — never re-posted.
 */

const finding = (over: Partial<Finding> = {}): Finding => ({
  ruleId: "img-alt",
  file: "src/App.tsx",
  line: 12,
  message: "Image missing alt text.",
  severity: "critical",
  criterion: "1.1.1",
  ...over,
});

describe("computeRollup", () => {
  it("totals and breaks down by severity and WCAG criterion", () => {
    const r = computeRollup([
      finding({ line: 1, severity: "critical", criterion: "1.1.1" }),
      finding({ line: 2, severity: "major", criterion: "1.4.3" }),
      finding({ line: 3, severity: "major", criterion: "1.4.3" }),
      finding({ line: 4, severity: "minor", criterion: "2.4.4" }),
    ]);
    expect(r.total).toBe(4);
    expect(r.bySeverity).toEqual({ critical: 1, major: 2, minor: 1 });
    expect(r.unknownSeverity).toBe(0);
    // descending by count, then criterion id
    expect(r.byCriterion).toEqual([
      { criterion: "1.4.3", count: 2 },
      { criterion: "1.1.1", count: 1 },
      { criterion: "2.4.4", count: 1 },
    ]);
  });

  it("dedups by the inline findingKey so the rollup total equals the inline-comment count", () => {
    // same rule/spot, different wording → one inline comment → count once
    const r = computeRollup([finding(), finding({ message: "reworded" })]);
    expect(r.total).toBe(1);
    expect(r.bySeverity.critical).toBe(1);
  });

  it("buckets a finding with no contract severity as unclassified, never inventing one", () => {
    const r = computeRollup([finding({ severity: undefined })]);
    expect(r.unknownSeverity).toBe(1);
    expect(r.bySeverity).toEqual({ critical: 0, major: 0, minor: 0 });
  });

  it("groups findings with no WCAG mapping under a single bucket", () => {
    const r = computeRollup([
      finding({ line: 1, criterion: undefined }),
      finding({ line: 2, criterion: "" }),
    ]);
    expect(r.byCriterion).toEqual([{ criterion: "(no WCAG mapping)", count: 2 }]);
  });

  it("is empty for no findings", () => {
    const r = computeRollup([]);
    expect(r.total).toBe(0);
    expect(r.byCriterion).toEqual([]);
  });
});

describe("render", () => {
  it("renders the rollup comment with the stable marker so a later push can find it", () => {
    const body = renderRollupComment(computeRollup([finding()]), [finding()]);
    expect(isRollupComment(body)).toBe(true);
    expect(body).toContain(ROLLUP_MARKER);
    expect(body).toContain("**1** finding");
    expect(body).toContain("| critical | 1 |");
    expect(body).toContain("| 1.1.1 | 1 |");
  });

  it("links each finding to its changed file when a linker is supplied", () => {
    const linkFor = (f: Finding) => `https://example.test/${f.file}#L${f.line}`;
    const body = renderRollupComment(computeRollup([finding()]), [finding()], { linkFor });
    expect(body).toContain("[src/App.tsx:12](https://example.test/src/App.tsx#L12)");
  });

  it("collapses a long finding list into an 'and N more' line", () => {
    const findings = Array.from({ length: 5 }, (_, i) => finding({ line: i + 1 }));
    const body = renderRollupComment(computeRollup(findings), findings, { maxRows: 3 });
    expect(body).toContain("…and 2 more");
  });

  it("renders a clean empty-state summary and still carries no marker leakage into text", () => {
    const summary = renderJobSummary(computeRollup([]), []);
    expect(summary).toContain("No accessibility findings");
    // the job summary is not reconciled, so it carries no marker
    expect(summary).not.toContain(ROLLUP_MARKER);
  });
});

const rollupComment = (id: number, findings: readonly Finding[]): RollupComment => ({
  id,
  body: renderRollupComment(computeRollup(findings), findings),
});

describe("reconcileRollup", () => {
  it("creates when the PR has no rollup yet", () => {
    const plan = reconcileRollup(renderRollupComment(computeRollup([finding()]), [finding()]), []);
    expect(plan).toEqual({ create: true, update: null, unchanged: null, remove: [] });
  });

  it("updates the existing rollup in place — never a second POST", () => {
    const before = rollupComment(7, [finding({ severity: "minor" })]);
    const desired = renderRollupComment(computeRollup([finding()]), [finding()]);
    const plan = reconcileRollup(desired, [before]);
    expect(plan.create).toBe(false);
    expect(plan.update).toBe(7);
  });

  it("leaves an already-correct rollup untouched (idempotent)", () => {
    const current = rollupComment(7, [finding()]);
    const plan = reconcileRollup(current.body, [current]);
    expect(plan).toEqual({ create: false, update: null, unchanged: 7, remove: [] });
  });

  it("keeps the first rollup and removes leftover duplicates from before dedup existed", () => {
    const a = rollupComment(1, [finding()]);
    const b = rollupComment(2, [finding()]);
    const plan = reconcileRollup(a.body, [a, b]);
    expect(plan.unchanged).toBe(1);
    expect(plan.remove).toEqual([2]);
  });

  it("never touches a human comment (no marker)", () => {
    const human: RollupComment = { id: 99, body: "Looks good, shipping." };
    const plan = reconcileRollup(renderRollupComment(computeRollup([finding()]), [finding()]), [human]);
    expect(plan.create).toBe(true);
    expect(plan.remove).toEqual([]);
  });
});

/** An in-memory rollup client recording the calls syncRollup drives. */
class FakeClient implements RollupClient {
  comments: RollupComment[];
  readonly calls: string[] = [];
  private nextId = 100;
  constructor(initial: RollupComment[] = []) {
    this.comments = [...initial];
  }
  list(): Promise<RollupComment[]> {
    return Promise.resolve([...this.comments]);
  }
  create(body: string): Promise<void> {
    this.calls.push("create");
    this.comments.push({ id: this.nextId++, body });
    return Promise.resolve();
  }
  update(id: number, body: string): Promise<void> {
    this.calls.push(`update:${id}`);
    this.comments = this.comments.map((c) => (c.id === id ? { id, body } : c));
    return Promise.resolve();
  }
  remove(id: number): Promise<void> {
    this.calls.push(`remove:${id}`);
    this.comments = this.comments.filter((c) => c.id !== id);
    return Promise.resolve();
  }
}

describe("syncRollup — converges to exactly one rollup", () => {
  it("posts once, then updates in place on the next push (no double-post)", async () => {
    const client = new FakeClient();
    await syncRollup([finding({ severity: "minor" })], client);
    expect(client.calls).toEqual(["create"]);
    expect(client.comments.filter((c) => isRollupComment(c.body))).toHaveLength(1);

    // second push with a changed set → update the SAME comment, never a new one
    await syncRollup([finding({ severity: "critical" })], client);
    expect(client.calls).toEqual(["create", "update:100"]);
    expect(client.comments.filter((c) => isRollupComment(c.body))).toHaveLength(1);
  });

  it("cleans up pre-existing duplicate rollups down to one", async () => {
    const dupes = [rollupComment(1, [finding()]), rollupComment(2, [finding()])];
    const client = new FakeClient(dupes);
    await syncRollup([finding({ severity: "major" })], client);
    expect(client.comments.filter((c) => isRollupComment(c.body))).toHaveLength(1);
    expect(client.calls).toContain("remove:2");
  });
});

describe("best-effort — never throws", () => {
  it("swallows a list failure and returns null so the job still exits 0", async () => {
    const throwing: RollupClient = {
      list: () => Promise.reject(new Error("boom")),
      create: () => Promise.resolve(),
      update: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const plan = await syncRollupBestEffort([finding()], throwing);
    expect(plan).toBeNull();
  });
});
