/**
 * The code-graph implementation of the structural-lookup seam (#2097).
 *
 * This fills the {@link LookupTool} interface `lookup.ts` left open: it answers a
 * reasoner's structural questions ("which module is this / what does it export",
 * "who calls this function") by shelling out to the published
 * `@binclusive/code-graph` CLI and returning its deterministic JSON. Calling it as
 * a subprocess — rather than importing its internals — keeps the boundary at
 * code-graph's stdout contract: one JSON document per query, nothing else.
 *
 * The tool spends NO model tokens, so it is metered on the count-based per-finding
 * budget by {@link meterLookup} in the runner — this tool never returns `capped`
 * itself (only the meter wrapper does). It is also TOTAL: every failure mode (an
 * unknown query kind, a missing file, no tsconfig for the edge pass, a subprocess
 * crash or timeout) becomes a `{ found: false }` envelope in `data`, never a
 * throw. The AI lane is non-blocking; a structure lookup that can't answer is a
 * gap the reasoner works around, not an error that ends the pass.
 *
 * The CLI is resolved from the installed `@binclusive/code-graph` dependency, so
 * the customer's cwd never matters and the same compiled artifact runs in the
 * Docker image as locally. The published package ships a compiled ESM bin
 * (`dist/index.js`), so it runs under plain `node` — no tsx loader needed.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { LookupQuery, LookupResult, LookupTool } from "./lookup";

const require = createRequire(import.meta.url);
/**
 * The published code-graph CLI entry. Resolved by subpath from the installed
 * dependency — the package exposes its bin as `dist/index.js` (no `main`/`exports`
 * map), so the explicit subpath is how a consumer reaches it.
 */
const CODE_GRAPH_CLI = require.resolve("@binclusive/code-graph/dist/index.js");

/** A slow subprocess must not stall a pass; the pull loop stays responsive. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The structural questions code-graph can answer for the agent lane. The seam's
 * {@link LookupQuery.kind} is an open `string`; these are the values this tool
 * understands (with a couple of natural aliases). Anything else is a `found:
 * false` envelope, not a throw — the reasoner never crashes on a typo.
 */
export type CodeGraphQueryKind =
  /** One module + its functions/imports/importedBy — "what is in this file". */
  | "file"
  /** Callers of one function id (direct + transitive) — "where does this flow / who uses it". */
  | "callers"
  /** Whole-project structural health summary — "orient me in this codebase". */
  | "summary";

/**
 * What a code-graph lookup yields, carried in {@link LookupResult}'s `data`. The
 * reasoner narrows on `found`; `json` is the deterministic structural document
 * code-graph emitted for that query kind (shape documented per kind in SPEC.md).
 */
export type CodeGraphLookupData =
  | { readonly found: true; readonly kind: CodeGraphQueryKind; readonly json: unknown }
  | { readonly found: false; readonly reason: string };

export interface CodeGraphLookupConfig {
  /**
   * Absolute path to the directory code-graph analyzes — the customer's checked
   * -out repo (or the diff-scoped subtree). Every query is relative to this root.
   */
  readonly root: string;
  /** Per-lookup wall-clock budget. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Build a {@link LookupTool} backed by the vendored code-graph CLI. Inject the
 * result into the runner's `RunInput.lookup`; the harness caps how many times the
 * reasoner may call it per finding.
 */
export function createCodeGraphLookup(config: CodeGraphLookupConfig): LookupTool {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async lookup(query: LookupQuery): Promise<LookupResult> {
      const plan = planQuery(config.root, query);
      if (plan === null) {
        return ok({ found: false, reason: `unsupported lookup kind: ${query.kind}` });
      }

      const { code, stdout } = await runCli(plan.argv, timeoutMs);
      if (code !== 0) {
        // code-graph clean-exits 2 with a one-line reason (bad path, no tsconfig
        // for the edge pass, …); 1 is a CI-gate fail we don't drive here.
        return ok({ found: false, reason: `code-graph exited ${code}` });
      }

      // A missing --file / an empty result writes a stderr warning and NO stdout
      // at exit 0, so empty-or-unparseable stdout is a genuine "not found".
      const parsed = parseJson(stdout);
      if (!parsed.ok) {
        return ok({ found: false, reason: parsed.reason });
      }
      return ok({ found: true, kind: plan.kind, json: parsed.value });
    },
  };
}

/** Wrap code-graph's answer in the seam's `ok` result (never `capped` here). */
function ok(data: CodeGraphLookupData): LookupResult {
  return { status: "ok", data };
}

/** Normalize the open `kind` string onto a supported query, with aliases. */
function normalizeKind(kind: string): CodeGraphQueryKind | null {
  switch (kind) {
    case "file":
    case "module":
      return "file";
    case "callers":
    case "blast":
    case "usages":
      return "callers";
    case "summary":
    case "overview":
      return "summary";
    default:
      return null;
  }
}

/** Translate a query into the code-graph argv, or `null` for an unknown kind. */
function planQuery(
  root: string,
  query: LookupQuery,
): { readonly kind: CodeGraphQueryKind; readonly argv: readonly string[] } | null {
  const kind = normalizeKind(query.kind);
  if (kind === null) return null;

  switch (kind) {
    case "file":
      // Module + its functions, as JSON (root-relative file path in target).
      return { kind, argv: [root, "--file", query.target, "--json"] };
    case "callers":
      // Blast radius needs the opt-in edge pass (calls/calledBy) — requires a
      // reachable tsconfig; code-graph clean-exits 2 when there is none.
      return { kind, argv: [root, "--edges", "--blast", query.target, "--json"] };
    case "summary":
      // The bare invocation already emits the JSON summary; target is ignored.
      return { kind, argv: [root] };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Run the vendored CLI under tsx, capturing stdout. Total: never rejects. */
function runCli(
  argv: readonly string[],
  timeoutMs: number,
): Promise<{ readonly code: number; readonly stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CODE_GRAPH_CLI, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    // Drain stderr so a chatty warning can't fill the pipe buffer and deadlock.
    child.stderr.resume();

    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

type ParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

/** Parse code-graph's stdout as JSON. Empty output = a not-found lookup. */
function parseJson(stdout: string): ParseResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { ok: false, reason: "no result" };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, reason: "code-graph output was not JSON" };
  }
}
