/**
 * PRIVATE corpus package entry — the moat.
 *
 * The OSS engine (`@binclusive/a11y`) never STATIC-imports this package; it
 * resolves the JSON data at runtime through a guarded `createRequire` and
 * degrades to baseline-only coverage when the package is absent (OSS users
 * without registry access). So the load-bearing surface consumed by the engine
 * is the raw data files under `./data/**`, addressed by subpath:
 *
 *   @binclusive/a11y-corpus/data/corpus-snapshot.json
 *   @binclusive/a11y-corpus/data/corpus/patterns-<SC>.json
 *
 * This module re-exports the distillation pipeline (the moat-BUILDING code) for
 * regenerating that data — it is not on the engine's runtime path.
 */

export * from "./distill/distill";
export { parseClusterFile, type ParsedClusters } from "./distill/cluster-assignments";
export { categorizeJourney, type JourneyCategory } from "./distill/journey-category";
export { normalizeCriterion } from "./distill/normalize-sc";
