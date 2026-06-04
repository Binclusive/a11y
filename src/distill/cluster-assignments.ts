/**
 * The LLM-authored clustering artifact, and the code-side loader that parses it.
 *
 * WHY this file exists: Slice 3 clustered findings with a keyword-regex
 * classifier + hand-authored per-SC pattern lists (`failure-patterns.ts`). That
 * was language-fragile (Turkish/English prose), manual per SC, and left ~11%
 * unclassified. The clustering *judgment* — "which findings are the same
 * failure-shape, in any phrasing or language" — is the one step a regex is bad
 * at and an LLM is good at. So we moved exactly that step OFF-LINE to the LLM.
 *
 * DETERMINISM BOUNDARY (critical): the LLM is used ONLY to produce this artifact
 * offline. It reads each SC's anonymized findings and (a) writes the generic,
 * English, anonymized output prose for each failure-shape and (b) assigns every
 * finding id to one shape. That artifact is committed, frozen, and
 * human-reviewable. EVERYTHING that must be auditable stays as CODE downstream:
 * the k>=3 distinct-org gate counts `org_id`s per cluster in `distill.ts`, then
 * strips them; the journey categorization, the tier assignment, and the ledger
 * are all code. So using LLM judgment to cluster does not leak nondeterminism
 * into the shipped pipeline — the cluster file is data, like a fixture.
 *
 * The artifact lives at `data/clusters/clusters-<SC>.json`. It carries NO
 * customer identifiers: cluster prose is generic English authored from
 * representative samples, and `assignments` maps anonymized finding ids (the
 * corpus `avt_*` ids, which are opaque and carry no org/url/element) to a
 * cluster id. org_id is NOT in this file — it is re-joined from the raw export
 * at distill time, used only for the gate, and never written to output.
 */

import { JOURNEY_CATEGORIES, type JourneyCategory } from "./journey-category";

/**
 * One failure-shape, as the LLM grouped it. The output prose fields
 * (`component`, `failureShape`, `fix`) are already generalized, English, and
 * anonymized — they are copied verbatim into the shipped pattern. `journeyTags`
 * here is the authored FALLBACK only; the shipped tags are derived from the
 * actual journeys observed for the cluster's findings (see `distill.ts`).
 */
export interface ClusterDef {
  /** Stable id, e.g. "4.1.2-button-no-name". Must be unique within the SC. */
  readonly id: string;
  /** Canonical SC(s) this shape belongs to (usually one). */
  readonly wcag: readonly string[];
  /** Generic component type, e.g. "icon-only button", "custom tab". */
  readonly component: string;
  /** Generic failure shape — what's wrong, no customer specifics. */
  readonly failureShape: string;
  /** Canonical, copy-paste, English fix. */
  readonly fix: string;
  /** Authored fallback journey tags, used only when the data yields none. */
  readonly journeyTags: readonly JourneyCategory[];
}

/** The on-disk shape of one `clusters-<SC>.json` file. */
export interface ClusterFile {
  readonly sc: string;
  /** The failure-shapes the LLM identified for this SC. */
  readonly clusters: readonly ClusterDef[];
  /**
   * Finding id -> cluster id. A finding the LLM judged to fit no shape is
   * simply absent (it becomes `unclassified` in the ledger — no silent drop).
   * Single-assignment: each id maps to at most one cluster, so org counts are
   * honest and clusters are mutually exclusive.
   */
  readonly assignments: Readonly<Record<string, string>>;
}

/** A parsed cluster file: defs by id + the finding->cluster assignment. */
export interface ParsedClusters {
  readonly sc: string;
  readonly defsById: ReadonlyMap<string, ClusterDef>;
  readonly assignments: ReadonlyMap<string, string>;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Narrow an unknown to a string-keyed record (no `as`): a non-null object. */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const CATEGORY_SET: ReadonlySet<string> = new Set(JOURNEY_CATEGORIES);

/** A list whose every entry is a known {@link JourneyCategory} — validated, not cast. */
const isJourneyCategoryArray = (v: unknown): v is JourneyCategory[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && CATEGORY_SET.has(x));

/**
 * Parse an unknown JSON value into a {@link ParsedClusters}, narrowing at the
 * boundary (no `as` on raw data). Throws on a malformed file rather than
 * smuggling `any` inward — a bad cluster file should fail loud at distill time.
 * Any assignment that references a cluster id with no def is rejected: a
 * dangling assignment would silently vanish, defeating the no-silent-drops rule.
 */
export function parseClusterFile(json: unknown): ParsedClusters {
  if (!isRecord(json)) {
    throw new Error("cluster file: expected an object");
  }
  const obj = json;
  if (typeof obj.sc !== "string") throw new Error("cluster file: missing string `sc`");
  if (!Array.isArray(obj.clusters)) throw new Error("cluster file: missing `clusters` array");
  if (!isRecord(obj.assignments)) {
    throw new Error("cluster file: missing `assignments` object");
  }

  const defsById = new Map<string, ClusterDef>();
  for (const c of obj.clusters) {
    if (!isRecord(c)) throw new Error("cluster file: a cluster is not an object");
    const def = c;
    if (
      typeof def.id !== "string" ||
      !isStringArray(def.wcag) ||
      typeof def.component !== "string" ||
      typeof def.failureShape !== "string" ||
      typeof def.fix !== "string" ||
      !isJourneyCategoryArray(def.journeyTags)
    ) {
      throw new Error(`cluster file: malformed cluster (${JSON.stringify(def.id)})`);
    }
    if (defsById.has(def.id)) throw new Error(`cluster file: duplicate cluster id ${def.id}`);
    defsById.set(def.id, {
      id: def.id,
      wcag: def.wcag,
      component: def.component,
      failureShape: def.failureShape,
      fix: def.fix,
      journeyTags: def.journeyTags,
    });
  }

  const assignments = new Map<string, string>();
  for (const [findingId, clusterId] of Object.entries(obj.assignments)) {
    if (typeof clusterId !== "string") {
      throw new Error(`cluster file: assignment for ${findingId} is not a string`);
    }
    if (!defsById.has(clusterId)) {
      throw new Error(
        `cluster file: assignment ${findingId} -> ${clusterId} has no matching cluster`,
      );
    }
    assignments.set(findingId, clusterId);
  }

  return { sc: obj.sc, defsById, assignments };
}
