import { describe, expect, it } from "vitest";
import { type ParsedClusters, parseClusterFile } from "../../src/distill/cluster-assignments";
import { distill, type RawFinding, tierForOrgs } from "../../src/distill/distill";
import { categorizeJourney } from "../../src/distill/journey-category";

let nextId = 0;
function finding(over: Partial<RawFinding>): RawFinding {
  return {
    id: `avt_${nextId++}`,
    wcag_criterion: "4.1.2",
    org_id: "org1",
    journey_name: null,
    journey_step: null,
    ...over,
  };
}

/**
 * Build a single-SC cluster map from finding-id -> cluster-id assignments. Each
 * referenced cluster id gets a stub def. This mirrors what the LLM-authored
 * `clusters-<SC>.json` provides; the distiller only ever consumes the parsed
 * form, so the engine test drives it through the same `parseClusterFile`.
 */
function clusterMap(
  sc: string,
  assignments: Record<string, string>,
): ReadonlyMap<string, ParsedClusters> {
  const clusterIds = [...new Set(Object.values(assignments))];
  const parsed = parseClusterFile({
    sc,
    clusters: clusterIds.map((id) => ({
      id,
      wcag: [sc],
      component: "c",
      failureShape: "f",
      fix: "x",
      journeyTags: [],
    })),
    assignments,
  });
  return new Map([[sc, parsed]]);
}

describe("distill: k>=3 org gate + ledger (no silent drops)", () => {
  it("keeps a cluster at 3 distinct orgs and drops one at 2", () => {
    const btn = [
      finding({ org_id: "a" }),
      finding({ org_id: "b" }),
      finding({ org_id: "c" }),
      finding({ org_id: "a" }), // same org, no new org
    ];
    const link = [finding({ org_id: "a" }), finding({ org_id: "b" })];
    const raw = [...btn, ...link];
    const assignments: Record<string, string> = {};
    for (const f of btn) assignments[f.id] = "4.1.2-button-no-name";
    for (const f of link) assignments[f.id] = "4.1.2-link-no-name";

    const { patterns, ledger } = distill(raw, clusterMap("4.1.2", assignments));

    const ids = patterns.map((p) => p.id);
    expect(ids).toContain("4.1.2-button-no-name");
    expect(ids).not.toContain("4.1.2-link-no-name");

    const linkDrop = ledger.belowK.find((d) => d.id === "4.1.2-link-no-name");
    expect(linkDrop).toEqual({ id: "4.1.2-link-no-name", orgs: 2, findings: 2 });
  });

  it("ledgers unmappable criteria and out-of-scope SCs instead of losing them", () => {
    const inScope = finding({ org_id: "d", wcag_criterion: "4.1.2" });
    const raw: RawFinding[] = [
      finding({ org_id: "a", wcag_criterion: "site-inaccessible" }),
      finding({ org_id: "b", wcag_criterion: "asd" }),
      finding({ org_id: "c", wcag_criterion: "1.1.1" }), // valid SC, out of scope
      inScope, // in scope but unassigned -> unclassified, not below-k
    ];
    const { ledger, patterns } = distill(raw, clusterMap("4.1.2", {}));
    expect(ledger.unmappableCriterion).toBe(2);
    expect(ledger.scOutOfScope).toBe(1);
    expect(ledger.unclassified).toBe(1);
    expect(patterns).toHaveLength(0);
  });

  it("ledgers in-scope findings the LLM assigned to no cluster as unclassified", () => {
    const raw: RawFinding[] = [finding({ org_id: "a" })];
    // empty assignment map: nothing claimed -> unclassified
    const { ledger } = distill(raw, clusterMap("4.1.2", {}));
    expect(ledger.unclassified).toBe(1);
  });

  it("counts distinct orgs only — org_id never appears in output", () => {
    const fs = [finding({ org_id: "a" }), finding({ org_id: "b" }), finding({ org_id: "c" })];
    const assignments = Object.fromEntries(fs.map((f) => [f.id, "4.1.2-button-no-name"]));
    const { patterns } = distill(fs, clusterMap("4.1.2", assignments));
    const serialized = JSON.stringify(patterns);
    expect(serialized).not.toContain("org_id");
    expect(serialized).not.toContain('"a"');
    expect(patterns[0]?.frequencyTier).toBe("occasional"); // 3 orgs
  });
});

describe("parseClusterFile (boundary parse of the LLM artifact)", () => {
  it("rejects an assignment that references a cluster with no def", () => {
    expect(() =>
      parseClusterFile({
        sc: "4.1.2",
        clusters: [
          {
            id: "4.1.2-a",
            wcag: ["4.1.2"],
            component: "c",
            failureShape: "f",
            fix: "x",
            journeyTags: [],
          },
        ],
        assignments: { avt_1: "4.1.2-missing" },
      }),
    ).toThrow(/no matching cluster/);
  });

  it("rejects a duplicate cluster id", () => {
    const def = {
      id: "4.1.2-a",
      wcag: ["4.1.2"],
      component: "c",
      failureShape: "f",
      fix: "x",
      journeyTags: [],
    };
    expect(() => parseClusterFile({ sc: "4.1.2", clusters: [def, def], assignments: {} })).toThrow(
      /duplicate cluster id/,
    );
  });

  it("parses a well-formed file and maps findings to clusters", () => {
    const parsed = parseClusterFile({
      sc: "4.1.2",
      clusters: [
        {
          id: "4.1.2-a",
          wcag: ["4.1.2"],
          component: "c",
          failureShape: "f",
          fix: "x",
          journeyTags: [],
        },
      ],
      assignments: { avt_1: "4.1.2-a", avt_2: "4.1.2-a" },
    });
    expect(parsed.assignments.get("avt_1")).toBe("4.1.2-a");
    expect(parsed.defsById.get("4.1.2-a")?.component).toBe("c");
  });
});

describe("tierForOrgs", () => {
  it("maps org counts to tiers", () => {
    expect(tierForOrgs(22)).toBe("very-common");
    expect(tierForOrgs(15)).toBe("very-common");
    expect(tierForOrgs(14)).toBe("common");
    expect(tierForOrgs(8)).toBe("common");
    expect(tierForOrgs(7)).toBe("occasional");
    expect(tierForOrgs(3)).toBe("occasional");
  });
});

describe("categorizeJourney (bilingual, closed enum)", () => {
  it("maps Turkish and English journeys to generic categories", () => {
    expect(categorizeJourney("E-posta ile kayıt (no-auth)")).toBe("registration");
    expect(categorizeJourney("Login (no-auth)")).toBe("sign-in");
    expect(categorizeJourney("Find tickets")).toBe("checkout");
    expect(categorizeJourney("Ana menü navigasyonu (detaylı)")).toBe("navigation");
    expect(categorizeJourney("Arama ve bir kategori üzerinden video bulup izleme")).toBe("search");
    expect(categorizeJourney("Tour the university home page")).toBe("browse-discovery");
    expect(categorizeJourney("Kredi bilgileri")).toBe("product-detail");
    expect(categorizeJourney("randevu alma akışı")).toBe("booking");
  });

  it("falls back to 'other' for junk / empty", () => {
    expect(categorizeJourney("asd")).toBe("other");
    expect(categorizeJourney("")).toBe("other");
    expect(categorizeJourney(null)).toBe("other");
  });
});
