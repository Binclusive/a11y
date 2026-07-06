/**
 * The platform-adapter seam (issue #2235) — the ONE contract two CI platforms
 * plug into, so a second platform is added behind this boundary instead of
 * forking `entrypoint.sh`. It has two halves:
 *
 *   1. a DIFF-CONTEXT RESOLVER — "what changed + where to post", derived from the
 *      platform's environment (the GitHub adapter reads `GITHUB_EVENT_PATH`-derived
 *      env; a future GitLab/Buildkite adapter reads its own), and
 *   2. a FINDINGS REPORTER — consumes the canonical `@binclusive/a11y-contract`
 *      finding shape ({@link Finding}, the engine's `check --json` output) and
 *      surfaces it on the platform's native review UI.
 *
 * An adapter pairs the two over ONE platform-native post-target type `Ctx`
 * ({@link PlatformAdapter}). The `Ctx` never crosses the seam: {@link bindAdapter}
 * erases it into a {@link BoundAdapter} by capturing the resolver's target in the
 * closure it hands to the reporter, so a heterogeneous registry
 * ({@link AdapterRegistry}) can store adapters of different `Ctx` types with no
 * cast and no `any`.
 *
 * Opt-in by construction: when the resolver finds no PR/MR context (no token / not
 * a PR event) it yields a `null` post-target, and {@link dispatch} no-ops the
 * reporter — artifacts still emit, the gate still exits 0.
 */
import { type Finding, parseFindings } from "./finding";

export { type Finding, parseFindings };
export type { Severity } from "./finding";

/** A best-effort logger; adapters log to stderr and never throw. */
export type Logger = (msg: string) => void;

/**
 * Half 1 of the contract. Resolve the platform's change-context from the process
 * env: the changed `.tsx` files to scan and the platform-native post-target, or
 * `null` when there is no PR/MR context (⇒ the reporter no-ops). `Ctx` is the
 * adapter's own post-target type — opaque to the seam.
 */
export interface DiffContextResolver<Ctx> {
  resolve(env: NodeJS.ProcessEnv): DiffContext<Ctx>;
}

/** The resolved change-context: what changed + where to post (if anywhere). */
export interface DiffContext<Ctx> {
  /** Changed `.tsx` paths to scan; empty ⇒ the caller falls back to a wholesale scan. */
  readonly changedTsx: readonly string[];
  /**
   * The platform-native surface findings post to, or `null` when no PR/MR context
   * is present. `null` is the opt-in no-op signal — the reporter is never invoked.
   */
  readonly postTarget: Ctx | null;
}

/**
 * Half 2 of the contract. Surface `findings` on the platform's native review UI,
 * posting to the resolved `target`. Best-effort: an implementation logs and
 * swallows failures rather than throwing, so a reporter error never fails the
 * advisory gate.
 */
export interface FindingsReporter<Ctx> {
  report(findings: readonly Finding[], target: Ctx, log: Logger): Promise<void>;
}

/** A platform adapter pairs the two halves over one post-target type `Ctx`. */
export interface PlatformAdapter<Ctx> {
  /** The explicit platform key used to select this adapter (e.g. `github`, `null`). */
  readonly key: string;
  readonly resolver: DiffContextResolver<Ctx>;
  readonly reporter: FindingsReporter<Ctx>;
}

/**
 * A reporter already bound to a resolved target — a thunk that posts `findings`,
 * or `null` when there is no post-target (the opt-in no-op).
 */
export type BoundReporter = (findings: readonly Finding[], log: Logger) => Promise<void>;

/** The Ctx-erased adapter the registry stores and {@link dispatch} drives. */
export interface BoundAdapter {
  readonly key: string;
  /** Resolve change-context from env, returning changed files + a bound reporter (null ⇒ no-op). */
  resolve(env: NodeJS.ProcessEnv): { readonly changedTsx: readonly string[]; readonly report: BoundReporter | null };
}

/**
 * Erase an adapter's `Ctx` by pairing its resolver with its reporter in a
 * closure: resolve the target once, then partially-apply the reporter into a
 * {@link BoundReporter} that captures it. The `Ctx` never appears in
 * {@link BoundAdapter}'s type, so adapters of different post-target types are
 * assignment-compatible in one registry — with no cast (the narrowed `target`
 * is captured in a const, not asserted).
 */
export function bindAdapter<Ctx>(adapter: PlatformAdapter<Ctx>): BoundAdapter {
  return {
    key: adapter.key,
    resolve(env) {
      const ctx = adapter.resolver.resolve(env);
      if (ctx.postTarget === null) {
        return { changedTsx: ctx.changedTsx, report: null };
      }
      const target = ctx.postTarget;
      const report: BoundReporter = (findings, log) => adapter.reporter.report(findings, target, log);
      return { changedTsx: ctx.changedTsx, report };
    },
  };
}

/** A registry of bound adapters, selectable by explicit platform key. */
export class AdapterRegistry {
  private readonly byKey: Map<string, BoundAdapter>;

  constructor(adapters: readonly BoundAdapter[]) {
    this.byKey = new Map(adapters.map((a) => [a.key, a]));
  }

  /** Select an adapter by its explicit platform key; `undefined` when unknown. */
  select(key: string): BoundAdapter | undefined {
    return this.byKey.get(key);
  }

  /** The keys of every registered adapter (for diagnostics / listing). */
  keys(): string[] {
    return [...this.byKey.keys()];
  }
}

/**
 * Drive one bound adapter: given the findings and the resolved change-context,
 * invoke the reporter — or no-op when the resolver yielded no post-target. This
 * is the dispatch the CLI runs; it locks the seam's opt-in contract in one place.
 */
export async function dispatch(
  resolved: { readonly report: BoundReporter | null },
  findings: readonly Finding[],
  log: Logger,
): Promise<void> {
  if (resolved.report === null) {
    log("no post context — reporter no-op (findings still emitted)");
    return;
  }
  await resolved.report(findings, log);
}

/** The default platform when no explicit key is given — GitHub, so the shipped Action is behavior-preserving. */
export const DEFAULT_PLATFORM_KEY = "github";

/**
 * Resolve the platform key from env (or a CLI flag value passed as `override`),
 * defaulting to {@link DEFAULT_PLATFORM_KEY}. `A11Y_PLATFORM` is the explicit
 * selector; a bare, empty, or unset value falls through to the default.
 */
export function resolvePlatformKey(env: NodeJS.ProcessEnv, override?: string): string {
  const explicit = override && override !== "" ? override : env.A11Y_PLATFORM;
  return explicit && explicit !== "" ? explicit : DEFAULT_PLATFORM_KEY;
}
