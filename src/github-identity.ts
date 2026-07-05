/**
 * The one identity resolver both PR-comment surfaces authenticate through (issue
 * #2130). Inline per-finding comments (`pr-comment-cli.ts`) and the single rollup
 * comment (`pr-summary-cli.ts`) MUST post under the *same* GitHub identity, so the
 * auth decision lives here once rather than duplicated at each callsite.
 *
 * Default-safe by construction — the load-bearing invariant:
 *
 *   - Binclusive GitHub App credentials configured (App id + private key in env) →
 *     mint a short-lived installation access token and post under the branded App
 *     identity (name + avatar), not `github-actions[bot]`.
 *   - App credentials ABSENT → return the Action's own `GITHUB_TOKEN` unchanged.
 *     Unset ⇒ byte-for-byte the current behavior, so this is safe to merge before
 *     the App exists.
 *
 * Non-blocking, always: any mint failure (a bad key, a missing installation, a
 * network error, a non-2xx from GitHub) is logged and FALLS BACK to the default
 * token — the resolver never throws, so a failed identity swap never gates the
 * merge. A failed brand is a lost avatar, never a failed check.
 *
 * No new runtime dependency: the App JWT is RS256-signed with node's built-in
 * `crypto`, and every GitHub call goes through the same global `fetch` the comment
 * clients already use. The signer and fetch are injected ({@link MintDeps}) so both
 * branches — App-configured and App-absent — are unit-testable without a real key
 * or a live network.
 */
import { createSign } from "node:crypto";

/** Which identity a resolved token posts under. */
export type PostingIdentity = "binclusive-github-app" | "github-actions";

/** A resolved posting token paired with the identity GitHub will attribute it to. */
export interface TokenResolution {
  /** The bearer token to authenticate the comment POST/PATCH/DELETE calls with. */
  readonly token: string;
  /** `binclusive-github-app` when a branded installation token was minted, else `github-actions`. */
  readonly identity: PostingIdentity;
}

/**
 * Binclusive GitHub App credentials, present only when the customer installed the
 * App and supplied its id + private key. `installationId` is optional — when
 * absent it is discovered from the repo the run targets.
 */
export interface AppConfig {
  readonly appId: string;
  readonly privateKey: string;
  readonly installationId?: string;
}

/** The repo + API host a token is being resolved for. */
export interface ResolveContext {
  /** `owner/name`, from `GITHUB_REPOSITORY`. */
  readonly repo: string;
  /** The GitHub REST base, e.g. `https://api.github.com` (GHES uses a different host). */
  readonly api: string;
}

/**
 * Injected effects so both branches are testable offline: `fetchImpl` is the HTTP
 * surface (real global `fetch` in prod, a fake in tests), and `mintJwt` produces
 * the App JWT (real RS256 signer in prod, a stub in tests so no key is needed).
 */
export interface MintDeps {
  readonly fetchImpl: typeof fetch;
  readonly mintJwt: (appId: string, privateKey: string) => string;
}

const APP_ID_ENV = "BINCLUSIVE_APP_ID";
const APP_KEY_ENV = "BINCLUSIVE_APP_PRIVATE_KEY";
const APP_INSTALL_ENV = "BINCLUSIVE_APP_INSTALLATION_ID";

/**
 * Read the App credentials from the environment, or `null` when unconfigured
 * (either secret missing/blank). `null` is the default-safe signal that routes
 * the resolver straight to the `GITHUB_TOKEN` fallback — the App absence is the
 * common case until Can creates and installs the App.
 *
 * The private key is stored in a secret as PEM; some secret stores collapse its
 * newlines to the literal `\n` escape, so those are restored — a no-op on a key
 * that already carries real newlines.
 */
export function readAppConfig(env: NodeJS.ProcessEnv): AppConfig | null {
  const appId = env[APP_ID_ENV]?.trim();
  const rawKey = env[APP_KEY_ENV];
  if (!appId || !rawKey || rawKey.trim() === "") return null;
  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
  const installationId = env[APP_INSTALL_ENV]?.trim();
  return { appId, privateKey, ...(installationId ? { installationId } : {}) };
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/**
 * RS256-sign a GitHub App JWT (App-authentication credential) with node's built-in
 * `crypto` — no JWT library. `iat` is backdated 60s to absorb clock skew between
 * the runner and GitHub, and `exp` is capped at 10 minutes (GitHub rejects longer);
 * the JWT is used only to immediately mint an installation token, then discarded.
 */
export function mintAppJwt(appId: string, privateKey: string, now: () => number = Date.now): string {
  const iat = Math.floor(now() / 1000) - 60;
  const exp = iat + 600;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** The real signer + global fetch — the production {@link MintDeps}. */
export const defaultMintDeps: MintDeps = {
  fetchImpl: (...args) => fetch(...args),
  mintJwt: (appId, privateKey) => mintAppJwt(appId, privateKey),
};

function appJwtHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "binclusive-a11y-agent",
  };
}

/**
 * Mint a short-lived installation access token for the App on `ctx.repo`. Throws on
 * any failure (missing installation, non-2xx, unparseable body) so the caller's
 * try/catch routes to the default-token fallback — this function never silently
 * returns a bad token. When `installationId` is absent it is discovered from the
 * repo, so a customer only needs to install the App, not look up its id.
 */
export async function mintInstallationToken(
  app: AppConfig,
  ctx: ResolveContext,
  deps: MintDeps,
): Promise<string> {
  const jwt = deps.mintJwt(app.appId, app.privateKey);
  const headers = appJwtHeaders(jwt);

  let installationId = app.installationId;
  if (!installationId) {
    const res = await deps.fetchImpl(`${ctx.api}/repos/${ctx.repo}/installation`, { headers });
    if (!res.ok) {
      throw new Error(`installation lookup -> ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    const body: unknown = await res.json();
    const id = (body as { id?: unknown })?.id;
    if (typeof id !== "number" && typeof id !== "string") {
      throw new Error("installation lookup returned no id");
    }
    installationId = String(id);
  }

  const res = await deps.fetchImpl(`${ctx.api}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers,
  });
  if (!res.ok) {
    throw new Error(`installation token -> ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const body: unknown = await res.json();
  const token = (body as { token?: unknown })?.token;
  if (typeof token !== "string" || token === "") {
    throw new Error("installation token response carried no token");
  }
  return token;
}

/**
 * The single entrypoint both comment surfaces call to decide *who* posts. Returns
 * the branded App identity + a freshly minted installation token when the App is
 * configured and the mint succeeds; otherwise the Action's own `GITHUB_TOKEN`
 * under the `github-actions` identity — the zero-behavior-change default. Never
 * throws: a mint failure logs and degrades to the default token so the run exits 0.
 */
export async function resolvePostingToken(
  env: NodeJS.ProcessEnv,
  ctx: ResolveContext,
  log: (msg: string) => void = () => {},
  deps: MintDeps = defaultMintDeps,
): Promise<TokenResolution> {
  const defaultToken = env.GITHUB_TOKEN ?? "";
  const app = readAppConfig(env);
  if (!app) {
    return { token: defaultToken, identity: "github-actions" };
  }
  try {
    const token = await mintInstallationToken(app, ctx, deps);
    log("posting under the Binclusive GitHub App identity");
    return { token, identity: "binclusive-github-app" };
  } catch (e) {
    // Non-blocking: a failed brand falls back to the default token, never the run.
    log(`GitHub App token mint failed, falling back to GITHUB_TOKEN: ${e instanceof Error ? e.message : String(e)}`);
    return { token: defaultToken, identity: "github-actions" };
  }
}
