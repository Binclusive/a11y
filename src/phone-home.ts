/**
 * Phone-home — the OPTIONAL, metadata-only ingest step that files a run's
 * findings to the Binclusive dashboard (issue #2108).
 *
 * ONE invariant governs this whole module: **phone-home NEVER blocks.** It is a
 * telemetry side-channel on a local-first tool — a dashboard update is a bonus,
 * never a gate. So every failure mode (no token, unreachable endpoint, timeout,
 * 4xx/5xx, a GraphQL `errors` array, a malformed body) is CAUGHT and returned as
 * a {@link PhoneHomeOutcome} value; nothing throws out of {@link phoneHome}, and
 * the caller always `exit 0`s. The outcome is a discriminated union so "it
 * failed" is a value the caller inspects, never an exception it must remember to
 * catch — impossible states (a "failed" result that also silently threw) are
 * unrepresentable.
 *
 * ABSENCE IS NOT FAILURE. No `B8E_TOKEN` (or no org/project/endpoint) means the
 * customer opted out of the dashboard — the run stays fully local and reports
 * `skipped`, not `failed`. Local-first: the dashboard is an upgrade, not a
 * dependency.
 *
 * SECRETS NEVER LOG. The bearer token is read once into the request header and
 * is never interpolated into any log line — the outcome carries only
 * presence/status/reason, never the token value.
 *
 * METADATA-ONLY ON THE WIRE. A finding projects to {@link CiFinding} carrying a
 * scanned target PATH (`url`), a WCAG criterion, a DOM/selector locator, a
 * severity band, and human-readable evidence — never a source line and never a
 * snippet. `url` is the same repo-relative path vocabulary as
 * {@link IngestEnvelope.scannedTargets}, which is what lets platform-side
 * scope-reconcile key `ticket.url ∈ scannedTargets` (issue #2166): a target that
 * was re-scanned and no longer fires is provably fixed.
 */
import { relative } from "node:path";
import type { Provenance as ContractProvenance } from "@binclusive/a11y-contract";
import type { EnrichedFinding } from "./corpus";
import { scopeChangedTsxFromEnv } from "./diff-scope";
import { contractSeverity, hasSelector, toContractProvenance } from "./emit-contract";

/** The production Kontrol GraphQL gateway. Overridable via `B8E_INGEST_URL`. */
const DEFAULT_INGEST_URL = "https://kontrol.binclusive.io/graphql";

/** Phone-home is a background courtesy — a slow endpoint must never stall CI. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * One occurrence on the wire — mirrors Kontrol's `CiFindingInput` exactly.
 * Metadata-only by construction: `url` is a scanned PATH (a target id), not
 * `file:line`, and there is no snippet/source field. `description`/`evidence`
 * are the finding's own human-readable message; `recommendation` is left empty
 * on the deterministic floor (an agent enrichment is local-only by design — see
 * `EnrichedFinding.agentNote`).
 */
export interface CiFinding {
  /** The scanned target this occurrence was found in — a repo-relative path. */
  readonly url: string;
  /** WCAG success-criterion id, e.g. "1.4.3". */
  readonly criterion: string;
  /** DOM selector / accessible-tree path locating the occurrence — not source. */
  readonly element: string;
  readonly severity: "critical" | "major" | "minor";
  /** Free-form impact label (axe runtime impact when present, else the band). */
  readonly impact: string;
  readonly evidence: string;
  readonly description: string;
  /** Remediation prose. Empty on the CI static floor (never a code patch). */
  readonly recommendation: string;
  /** ISO-8601 timestamp the run observed the occurrence. */
  readonly seenAt: string;
}

/**
 * The ingest envelope — ONE per provenance, because Kontrol's
 * `ingestExternalFindings` declares `provenance` at the envelope level, not
 * per-finding. `scannedTargets` is declared independently of `findings` so
 * scope-reconcile can tell "re-scanned and clean" from "not scanned this run".
 */
export interface IngestEnvelope {
  readonly orgID: string;
  readonly projectID: string;
  readonly auditID: string;
  readonly provenance: ContractProvenance;
  readonly scope: string;
  readonly scannedTargets: readonly string[];
  readonly findings: readonly CiFinding[];
}

/** Why phone-home did nothing — every arm is a NON-error opt-out or empty run. */
export type SkipReason =
  | "no-token"
  | "no-org"
  | "no-project"
  | "no-audit"
  | "no-endpoint"
  | "no-findings";

/**
 * Why a POST failed. A value, never a thrown exception — the caller reads it and
 * still exits 0. `network`/`timeout`/`http`/`graphql-errors`/`malformed-response`
 * are the full closed set of ways a well-formed POST can come back unusable.
 */
export type FailureReason =
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "graphql-errors"; readonly count: number }
  | { readonly kind: "malformed-response" };

/**
 * The result of a whole phone-home attempt. Discriminated so the caller branches
 * on a value; there is no "threw" arm because {@link phoneHome} never throws.
 * `sent` is reported when AT LEAST ONE envelope was accepted (a partial send is
 * still forward progress); `failed` only when every envelope failed.
 */
export type PhoneHomeOutcome =
  | { readonly status: "skipped"; readonly reason: SkipReason }
  | { readonly status: "sent"; readonly envelopes: number; readonly ingested: number }
  | { readonly status: "failed"; readonly reason: FailureReason };

/** Resolved, complete config — every field present (absence became a `skip`). */
export interface PhoneHomeConfig {
  readonly endpoint: string;
  readonly token: string;
  readonly orgID: string;
  readonly projectID: string;
  readonly auditID: string;
  readonly scope: string;
  readonly timeoutMs: number;
}

/** Injectable seams so the never-blocks behavior is unit-testable end to end. */
export interface PhoneHomeDeps {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly log: (message: string) => void;
  /** The targets this run actually scanned — the diff-scope (issue #2166). */
  readonly scanTargets: () => readonly string[];
}

function defaultDeps(env: NodeJS.ProcessEnv): PhoneHomeDeps {
  return {
    fetch: globalThis.fetch,
    now: () => new Date(),
    log: (message) => console.error(`phone-home: ${message}`),
    scanTargets: () => scopeChangedTsxFromEnv(env),
  };
}

// ── Config resolution: absence → a typed skip, never a partial config ──

type ConfigResolution =
  | { readonly kind: "ready"; readonly config: PhoneHomeConfig }
  | { readonly kind: "skip"; readonly reason: SkipReason };

/**
 * Resolve config from the CI env. A missing credential is an OPT-OUT (`skip`),
 * not an error: no token / no org / no project / no audit id each short-circuit
 * to a distinct reason so the log says exactly why the dashboard stayed dark.
 */
export function resolveConfig(env: NodeJS.ProcessEnv): ConfigResolution {
  const nonEmpty = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

  const token = env.B8E_TOKEN;
  if (!nonEmpty(token)) return { kind: "skip", reason: "no-token" };
  const orgID = env.B8E_ORG_ID;
  if (!nonEmpty(orgID)) return { kind: "skip", reason: "no-org" };
  const projectID = env.B8E_PROJECT_ID;
  if (!nonEmpty(projectID)) return { kind: "skip", reason: "no-project" };
  // The audit run these findings attach to. Explicit `B8E_AUDIT_ID` wins; the CI
  // run id is the honest fallback so a caller need not mint one by hand.
  const auditID = nonEmpty(env.B8E_AUDIT_ID) ? env.B8E_AUDIT_ID : env.GITHUB_RUN_ID;
  if (!nonEmpty(auditID)) return { kind: "skip", reason: "no-audit" };
  const endpoint = nonEmpty(env.B8E_INGEST_URL) ? env.B8E_INGEST_URL : DEFAULT_INGEST_URL;

  return {
    kind: "ready",
    config: {
      // Presence is checked on the trimmed value, so the STORED value must be
      // trimmed too — a credential with incidental surrounding whitespace passes
      // the presence gate but would be sent verbatim, causing avoidable auth /
      // validation failures downstream.
      endpoint: endpoint.trim(),
      token: token.trim(),
      orgID: orgID.trim(),
      projectID: projectID.trim(),
      auditID: auditID.trim(),
      // Free-form scan-scope label stamped on every finding. Not load-bearing for
      // reconcile (that keys on url + scannedTargets); a human breadcrumb.
      scope: nonEmpty(env.B8E_SCOPE) ? env.B8E_SCOPE.trim() : "ci-diff",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  };
}

// ── Projection: EnrichedFinding → CiFinding (metadata-only, path-as-url) ──

/**
 * Project one rich local finding onto the wire occurrence, dropping `file:line`
 * source but KEEPING the repo-relative path as `url`. The path is a target id
 * (the same vocabulary as `scannedTargets`), not source — so reconcile can match
 * it while no line number or snippet ever leaves the machine. Severity + selector
 * reuse the engine's single mapping (`emit-contract`), so the wire and SARIF can
 * never disagree on a finding's band.
 */
export function toCiFinding(f: EnrichedFinding, root: string, seenAt: string): CiFinding {
  const band = contractSeverity(f);
  return {
    // `path.relative` emits platform separators (`\` on Windows); force `/` so the
    // wire `url` stays the same git-style vocabulary as `scannedTargets` and the
    // `finding.url ∈ scannedTargets` reconcile invariant holds on every OS (#2180).
    url: relative(root, f.file).replaceAll("\\", "/"),
    criterion: f.wcag[0] ?? "",
    element: hasSelector(f.selector) ? f.selector : f.ruleId,
    severity: band,
    impact: f.severity ?? band,
    evidence: f.message,
    description: f.message,
    recommendation: "",
    seenAt,
  };
}

/**
 * Group a run's findings into per-provenance envelopes. Kontrol's provenance is
 * envelope-level, so a mixed run yields up to two envelopes (deterministic +
 * agent); an all-deterministic CI run yields one. `scannedTargets` is stamped on
 * every envelope regardless — it describes the RUN, not the findings.
 */
export function assembleEnvelopes(
  findings: readonly EnrichedFinding[],
  root: string,
  config: PhoneHomeConfig,
  scannedTargets: readonly string[],
  seenAt: string,
): IngestEnvelope[] {
  const deterministic: CiFinding[] = [];
  const agent: CiFinding[] = [];
  for (const f of findings) {
    const ci = toCiFinding(f, root, seenAt);
    (toContractProvenance(f.provenance) === "agent" ? agent : deterministic).push(ci);
  }

  const envelope = (provenance: ContractProvenance, items: CiFinding[]): IngestEnvelope => ({
    orgID: config.orgID,
    projectID: config.projectID,
    auditID: config.auditID,
    provenance,
    scope: config.scope,
    scannedTargets,
    findings: items,
  });

  const envelopes: IngestEnvelope[] = [];
  if (deterministic.length > 0) envelopes.push(envelope("deterministic", deterministic));
  if (agent.length > 0) envelopes.push(envelope("agent", agent));
  return envelopes;
}

// ── The POST: parse-don't-validate the response, catch every failure ──

const INGEST_MUTATION = `mutation IngestExternalFindings($input: IngestExternalFindingsInput!) {
  ingestExternalFindings(input: $input) { count }
}`;

type SendResult =
  | { readonly ok: true; readonly ingested: number }
  | { readonly ok: false; readonly reason: FailureReason };

/**
 * Interpret a GraphQL response body without trusting its shape. A `data.errors`
 * array, a missing payload, or a non-numeric `count` are each a distinct
 * unusable-response outcome — never a throw.
 */
function readIngestCount(body: unknown): { ok: true; count: number } | { ok: false; errors: number } | { ok: false } {
  if (typeof body !== "object" || body === null) return { ok: false };
  const root = body as Record<string, unknown>;
  if (Array.isArray(root.errors) && root.errors.length > 0) return { ok: false, errors: root.errors.length };
  const data = root.data;
  if (typeof data !== "object" || data === null) return { ok: false };
  const payload = (data as Record<string, unknown>).ingestExternalFindings;
  if (typeof payload !== "object" || payload === null) return { ok: false };
  const count = (payload as Record<string, unknown>).count;
  if (typeof count !== "number") return { ok: false };
  return { ok: true, count };
}

function toInputVariables(envelope: IngestEnvelope) {
  return {
    orgID: envelope.orgID,
    projectID: envelope.projectID,
    auditID: envelope.auditID,
    provenance: envelope.provenance,
    scope: envelope.scope,
    scannedTargets: envelope.scannedTargets,
    findings: envelope.findings.map((f) => ({ ...f })),
  };
}

/**
 * POST one envelope. NEVER throws: every fetch rejection, timeout, non-2xx, and
 * malformed body is folded into a {@link SendResult}. The bearer token is placed
 * in the header and never logged.
 */
async function sendEnvelope(
  config: PhoneHomeConfig,
  envelope: IngestEnvelope,
  deps: PhoneHomeDeps,
): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await deps.fetch(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ query: INGEST_MUTATION, variables: { input: toInputVariables(envelope) } }),
      signal: controller.signal,
    });

    if (!response.ok) return { ok: false, reason: { kind: "http", status: response.status } };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: { kind: "malformed-response" } };
    }

    const read = readIngestCount(body);
    if (read.ok) return { ok: true, ingested: read.count };
    if ("errors" in read) return { ok: false, reason: { kind: "graphql-errors", count: read.errors } };
    return { ok: false, reason: { kind: "malformed-response" } };
  } catch (error) {
    // AbortController fires an AbortError on timeout; everything else is network.
    if (error instanceof Error && error.name === "AbortError") return { ok: false, reason: { kind: "timeout" } };
    return { ok: false, reason: { kind: "network", message: error instanceof Error ? error.message : String(error) } };
  } finally {
    clearTimeout(timer);
  }
}

function describe(reason: FailureReason): string {
  switch (reason.kind) {
    case "network":
      return `network error (${reason.message})`;
    case "timeout":
      return "request timed out";
    case "http":
      return `HTTP ${reason.status}`;
    case "graphql-errors":
      return `${reason.count} GraphQL error(s)`;
    case "malformed-response":
      return "malformed response";
  }
}

/**
 * The public phone-home step. Resolves config, assembles per-provenance
 * envelopes, POSTs each, and returns a {@link PhoneHomeOutcome}. NEVER throws and
 * NEVER touches the process exit code — a dashboard update is a courtesy layered
 * on a local-first run. Absent credentials or an empty run → `skipped`; a
 * transport/server failure → `failed`; at least one accepted envelope → `sent`.
 */
export async function phoneHome(
  findings: readonly EnrichedFinding[],
  root: string,
  env: NodeJS.ProcessEnv,
  overrides?: Partial<PhoneHomeDeps>,
): Promise<PhoneHomeOutcome> {
  const deps: PhoneHomeDeps = { ...defaultDeps(env), ...overrides };

  const resolved = resolveConfig(env);
  if (resolved.kind === "skip") {
    deps.log(`skipped — ${resolved.reason}`);
    return { status: "skipped", reason: resolved.reason };
  }
  const { config } = resolved;

  const scannedTargets = deps.scanTargets();
  const seenAt = deps.now().toISOString();
  const envelopes = assembleEnvelopes(findings, root, config, scannedTargets, seenAt);

  // Kontrol's schema requires `findings.min(1)`, so a fully-clean run cannot post
  // an empty batch to activate reconcile — a known ceiling (see #2166 follow-up).
  if (envelopes.length === 0) {
    deps.log("skipped — no findings to send");
    return { status: "skipped", reason: "no-findings" };
  }

  let ingested = 0;
  let accepted = 0;
  let firstFailure: FailureReason | null = null;
  for (const envelope of envelopes) {
    const result = await sendEnvelope(config, envelope, deps);
    if (result.ok) {
      accepted += 1;
      ingested += result.ingested;
      deps.log(`sent ${envelope.provenance} envelope — ${result.ingested} ingested`);
    } else {
      if (firstFailure === null) firstFailure = result.reason;
      deps.log(`${envelope.provenance} envelope failed — ${describe(result.reason)} (ignored; run continues)`);
    }
  }

  if (accepted > 0) return { status: "sent", envelopes: accepted, ingested };
  // Every envelope failed. Still non-blocking — the caller reads this and exits 0.
  return { status: "failed", reason: firstFailure ?? { kind: "malformed-response" } };
}
