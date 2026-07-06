/**
 * The default adapter registry — the two shipped platforms bound behind the seam
 * (issue #2235): `github` (the first adapter, real inline PR comments) and `null`
 * (the generic stdout adapter, the ≥ 2 proof). New platforms (#2237 Buildkite,
 * #2238 GitLab) register here; nothing else changes.
 *
 * Each adapter is Ctx-erased through {@link bindAdapter} at registration, so the
 * registry stores platforms of different post-target types in one map with no cast.
 */
import { AdapterRegistry, bindAdapter, type BoundAdapter } from "./contract";
import { githubAdapter } from "./github-adapter";
import { nullAdapter } from "./null-adapter";

/** The bound adapters shipped by default. Order is irrelevant — selection is by key. */
export function defaultBoundAdapters(): BoundAdapter[] {
  return [bindAdapter(githubAdapter), bindAdapter(nullAdapter)];
}

/** The default registry: `github` + `null`, selectable by explicit platform key. */
export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry(defaultBoundAdapters());
}
