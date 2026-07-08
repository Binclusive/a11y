/**
 * The default adapter registry — the shipped platforms bound behind the seam
 * (issue #2235): `github` (the first adapter, real inline PR comments), `null`
 * (the generic stdout adapter, the ≥ 2 proof), `gitlab` (MR notes, #213), and
 * `buildkite` (build annotations via `buildkite-agent`, #212). New platforms
 * register here; nothing else changes.
 *
 * Each adapter is Ctx-erased through {@link bindAdapter} at registration, so the
 * registry stores platforms of different post-target types in one map with no cast.
 */
import { buildkiteAdapter } from "./buildkite-adapter";
import { AdapterRegistry, bindAdapter, type BoundAdapter } from "./contract";
import { githubAdapter } from "./github-adapter";
import { gitlabAdapter } from "./gitlab-adapter";
import { nullAdapter } from "./null-adapter";

/** The bound adapters shipped by default. Order is irrelevant — selection is by key. */
export function defaultBoundAdapters(): BoundAdapter[] {
  return [bindAdapter(githubAdapter), bindAdapter(nullAdapter), bindAdapter(gitlabAdapter), bindAdapter(buildkiteAdapter)];
}

/** The default registry: `github` + `null` + `gitlab` + `buildkite`, selectable by explicit platform key. */
export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry(defaultBoundAdapters());
}
