import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  type AppConfig,
  type MintDeps,
  mintAppJwt,
  mintInstallationToken,
  readAppConfig,
  resolvePostingToken,
} from "../src/github-identity";

/**
 * The one identity resolver both PR-comment surfaces authenticate through (#2130).
 * The load-bearing property under test is default-safety: with no App configured
 * the resolver returns the Action's GITHUB_TOKEN unchanged, and ANY mint failure
 * degrades to that same token without throwing — a failed brand is never a failed
 * check. The branded path (App-configured → minted installation token) is exercised
 * with an injected fetch + JWT stub so no real key or network is needed.
 */

const ctx = { repo: "acme/widgets", api: "https://api.github.com" } as const;

/** A fake fetch that dispatches on URL, so the two-call mint flow is scriptable. */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, make] of Object.entries(routes)) {
      if (url.includes(pattern)) return make();
    }
    throw new Error(`unrouted fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("readAppConfig", () => {
  it("returns null when the App is unconfigured (the default-safe common case)", () => {
    expect(readAppConfig({})).toBeNull();
    expect(readAppConfig({ BINCLUSIVE_APP_ID: "123" })).toBeNull(); // key missing
    expect(readAppConfig({ BINCLUSIVE_APP_PRIVATE_KEY: "pem" })).toBeNull(); // id missing
    expect(readAppConfig({ BINCLUSIVE_APP_ID: "123", BINCLUSIVE_APP_PRIVATE_KEY: "   " })).toBeNull(); // blank key
  });

  it("reads id + key and restores literal \\n escapes in the PEM", () => {
    const cfg = readAppConfig({
      BINCLUSIVE_APP_ID: "42",
      BINCLUSIVE_APP_PRIVATE_KEY: "-----BEGIN-----\\nline\\n-----END-----",
      BINCLUSIVE_APP_INSTALLATION_ID: "99",
    });
    expect(cfg).toEqual({ appId: "42", privateKey: "-----BEGIN-----\nline\n-----END-----", installationId: "99" });
  });

  it("omits installationId when unset (it is discovered from the repo)", () => {
    const cfg = readAppConfig({ BINCLUSIVE_APP_ID: "42", BINCLUSIVE_APP_PRIVATE_KEY: "pem" });
    expect(cfg).toEqual({ appId: "42", privateKey: "pem" });
    expect(cfg && "installationId" in cfg).toBe(false);
  });
});

describe("mintAppJwt", () => {
  it("produces an RS256 JWT verifiable with the matching public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = () => 1_700_000_000_000;
    const jwt = mintAppJwt("app-1", privateKey.export({ type: "pkcs1", format: "pem" }).toString(), now);

    const [h, p, sig] = jwt.split(".");
    expect(h && p && sig).toBeTruthy();
    const payload = JSON.parse(Buffer.from(p as string, "base64url").toString("utf8"));
    expect(payload.iss).toBe("app-1");
    expect(payload.iat).toBe(Math.floor(now() / 1000) - 60); // clock-skew backdate
    expect(payload.exp - payload.iat).toBe(600); // ≤ 10 min cap

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(sig as string, "base64url"))).toBe(true);
  });
});

describe("resolvePostingToken — App absent (default-safe fallback)", () => {
  it("returns GITHUB_TOKEN under the github-actions identity, unchanged", async () => {
    const res = await resolvePostingToken({ GITHUB_TOKEN: "ghs_default" }, ctx);
    expect(res).toEqual({ token: "ghs_default", identity: "github-actions" });
  });

  it("returns an empty token (not a throw) when neither the App nor GITHUB_TOKEN is set", async () => {
    const res = await resolvePostingToken({}, ctx);
    expect(res).toEqual({ token: "", identity: "github-actions" });
  });

  it("never touches the network when the App is unconfigured", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const deps: MintDeps = { fetchImpl, mintJwt: () => "unused" };
    await resolvePostingToken({ GITHUB_TOKEN: "ghs_default" }, ctx, () => {}, deps);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("resolvePostingToken — App configured (branded identity)", () => {
  const app = { BINCLUSIVE_APP_ID: "42", BINCLUSIVE_APP_PRIVATE_KEY: "pem", GITHUB_TOKEN: "ghs_default" };

  it("mints an installation token and posts under the branded App identity", async () => {
    const deps: MintDeps = {
      fetchImpl: fakeFetch({ "/access_tokens": () => json({ token: "ghs_installation" }) }),
      mintJwt: () => "signed.jwt.value",
    };
    const res = await resolvePostingToken(
      { ...app, BINCLUSIVE_APP_INSTALLATION_ID: "99" },
      ctx,
      () => {},
      deps,
    );
    expect(res).toEqual({ token: "ghs_installation", identity: "binclusive-github-app" });
  });

  it("discovers the installation from the repo when no installation id is set", async () => {
    const fetchImpl = fakeFetch({
      "/repos/acme/widgets/installation": () => json({ id: 12345 }),
      "/app/installations/12345/access_tokens": () => json({ token: "ghs_installation" }),
    });
    const deps: MintDeps = { fetchImpl, mintJwt: () => "signed.jwt.value" };
    const res = await resolvePostingToken(app, ctx, () => {}, deps);
    expect(res).toEqual({ token: "ghs_installation", identity: "binclusive-github-app" });
  });
});

describe("resolvePostingToken — non-blocking fallback on mint failure", () => {
  const app = { BINCLUSIVE_APP_ID: "42", BINCLUSIVE_APP_PRIVATE_KEY: "pem", GITHUB_TOKEN: "ghs_default" };

  it("falls back to GITHUB_TOKEN when the token endpoint errors (never throws)", async () => {
    const deps: MintDeps = {
      fetchImpl: fakeFetch({ "/access_tokens": () => json({ message: "bad" }, 401) }),
      mintJwt: () => "signed.jwt.value",
    };
    const res = await resolvePostingToken({ ...app, BINCLUSIVE_APP_INSTALLATION_ID: "99" }, ctx, () => {}, deps);
    expect(res).toEqual({ token: "ghs_default", identity: "github-actions" });
  });

  it("falls back when the network throws", async () => {
    const deps: MintDeps = {
      fetchImpl: (() => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      mintJwt: () => "signed.jwt.value",
    };
    const res = await resolvePostingToken({ ...app, BINCLUSIVE_APP_INSTALLATION_ID: "99" }, ctx, () => {}, deps);
    expect(res).toEqual({ token: "ghs_default", identity: "github-actions" });
  });

  it("falls back (empty token) when the App is configured but there is no GITHUB_TOKEN to fall back to", async () => {
    const deps: MintDeps = {
      fetchImpl: fakeFetch({ "/access_tokens": () => json({}, 500) }),
      mintJwt: () => "signed.jwt.value",
    };
    const res = await resolvePostingToken({ BINCLUSIVE_APP_ID: "42", BINCLUSIVE_APP_PRIVATE_KEY: "pem", BINCLUSIVE_APP_INSTALLATION_ID: "99" }, ctx, () => {}, deps);
    expect(res).toEqual({ token: "", identity: "github-actions" });
  });
});

describe("mintInstallationToken — throws so the caller can fall back", () => {
  const app: AppConfig = { appId: "42", privateKey: "pem", installationId: "99" };
  const deps = (fetchImpl: typeof fetch): MintDeps => ({ fetchImpl, mintJwt: () => "jwt" });

  it("throws when the token response carries no token", async () => {
    await expect(
      mintInstallationToken(app, ctx, deps(fakeFetch({ "/access_tokens": () => json({ notToken: 1 }) }))),
    ).rejects.toThrow(/no token/);
  });

  it("throws on a non-2xx installation lookup", async () => {
    await expect(
      mintInstallationToken(
        { appId: "42", privateKey: "pem" },
        ctx,
        deps(fakeFetch({ "/installation": () => json({ message: "not found" }, 404) })),
      ),
    ).rejects.toThrow(/installation lookup/);
  });
});
