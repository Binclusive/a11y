/**
 * `binclusive.json` — the per-repo accessibility contract.
 *
 * This is the customer's committed source of truth: the detected stack, which
 * WCAG SC the team blocks vs. warns on, and the team's own learned rules. The
 * AI tools (and the generated AGENTS.md / CLAUDE.md block) consume it; nothing
 * here is ever sent off the machine, and NO secret/API key ever lands in this
 * file — it is committed to the customer's git.
 *
 * Disk reads are boundary-parsed: the file is loaded as `unknown` and narrowed
 * by {@link parseContract}, which fails LOUD on a malformed file rather than
 * smuggling `any` inward (same discipline as `corpus.ts`).
 */

/** The only schema version we emit/accept today. Bump on a breaking shape change. */
export const CONTRACT_VERSION = 1 as const;

/** Which Next.js router the repo uses, or `null` when not a Next app. */
export type Router = "app" | "pages" | null;

/** Source language of the repo, decided by tsconfig presence. */
export type Language = "ts" | "js";

/**
 * The detected stack. Every field is a best-effort signal from
 * `package.json` + on-disk layout; see `detectStack` for what each draws on.
 * `designSystem` is `"custom"` when no dominant component-source module wins.
 */
export interface Stack {
  readonly framework: string;
  readonly router: Router;
  readonly designSystem: string;
  readonly language: Language;
}

/**
 * Enforcement policy, keyed by WCAG SC string. `block` SC fail the build;
 * `warn` SC surface but don't. An SC should appear in at most one list — the
 * parser de-dupes `warn` against `block` so `block` always wins.
 */
export interface Enforcement {
  readonly block: readonly string[];
  readonly warn: readonly string[];
}

/**
 * A team-authored rule, appended via `learn`. `id` is a slug derived from the
 * rule text; `addedAt` is an ISO timestamp; `fix`/`source` are optional context.
 */
export interface LearnedRule {
  readonly id: string;
  readonly rule: string;
  readonly wcag: readonly string[];
  readonly fix: string | null;
  readonly source: string;
  readonly addedAt: string;
}

/**
 * The customer's escape-hatch declarations — what auto-detection cannot reach.
 *
 * Auto-detect handles the deterministically-knowable (registry + source-trace);
 * everything here is what the customer DECLARES because the checker is blind to
 * it. Every field is OPTIONAL: a zero-config repo carries none of this and still
 * gets the full auto-detected scan. Each field is parsed leniently — a single
 * malformed entry is dropped (with a warning), the rest still load. A bad line
 * never hard-fails the whole config; that would punish the escape hatch.
 */
export interface Declarations {
  /**
   * Manual wrapper->host map: a component name jsx-a11y should treat as a host
   * primitive, e.g. `{ "Button": "button", "FancyLink": "a" }`. Fills gaps the
   * tracer can't (host hidden behind library indirection) and OVERRIDES the
   * derived map on conflict — the customer's word wins over inference.
   */
  readonly components: Readonly<Record<string, string>>;
  /**
   * Component names whose children are injected at RUNTIME (the customer's own
   * `<Trans>`-like helpers). Fed into the suppression pass so content-family
   * findings on these elements are dropped, exactly like the built-in `<Trans>`.
   */
  readonly injectsChildren: readonly string[];
  /**
   * File globs and/or jsx-a11y rule ids to skip. A glob match drops the whole
   * file from the scan; a rule-id match (with or without the `jsx-a11y/` prefix)
   * drops every finding for that rule.
   */
  readonly ignore: readonly string[];
}

/** The whole `binclusive.json` document. */
export interface Contract {
  readonly version: typeof CONTRACT_VERSION;
  readonly stack: Stack;
  readonly enforcement: Enforcement;
  readonly learned: readonly LearnedRule[];
  /** Customer escape-hatch declarations; always present, defaults are empty. */
  readonly declarations: Declarations;
}

/** Thrown when `binclusive.json` is present but malformed. Fails loud. */
export class ContractParseError extends Error {
  constructor(message: string) {
    super(`binclusive.json is malformed: ${message}`);
    this.name = "ContractParseError";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Narrow an array of unknown to `string[]`, rejecting any non-string element. */
function parseStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new ContractParseError(`${field} must be an array`);
  const out: string[] = [];
  for (const el of v) {
    if (typeof el !== "string") throw new ContractParseError(`${field}[] must be strings`);
    out.push(el);
  }
  return out;
}

function parseRouter(v: unknown): Router {
  if (v === null || v === "app" || v === "pages") return v;
  throw new ContractParseError(`stack.router must be "app", "pages", or null`);
}

function parseLanguage(v: unknown): Language {
  if (v === "ts" || v === "js") return v;
  throw new ContractParseError(`stack.language must be "ts" or "js"`);
}

function parseStack(v: unknown): Stack {
  if (!isObject(v)) throw new ContractParseError("stack must be an object");
  const { framework, router, designSystem, language } = v;
  if (typeof framework !== "string")
    throw new ContractParseError("stack.framework must be a string");
  if (typeof designSystem !== "string")
    throw new ContractParseError("stack.designSystem must be a string");
  return {
    framework,
    router: parseRouter(router),
    designSystem,
    language: parseLanguage(language),
  };
}

function parseEnforcement(v: unknown): Enforcement {
  if (!isObject(v)) throw new ContractParseError("enforcement must be an object");
  const block = parseStringArray(v.block, "enforcement.block");
  const warnRaw = parseStringArray(v.warn, "enforcement.warn");
  // block wins: an SC can't be both blocked and warned.
  const blockSet = new Set(block);
  const warn = warnRaw.filter((sc) => !blockSet.has(sc));
  return { block, warn };
}

/** The empty escape-hatch block: what a zero-config contract carries. */
export function emptyDeclarations(): Declarations {
  return { components: {}, injectsChildren: [], ignore: [] };
}

/** Valid intrinsic tag token: a single lowercase tag like `button` or `a`. */
const VALID_HOST_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Validate a raw `components` map (before it is filtered by the parser).
 * Returns one human-readable diagnostic string per invalid host entry; an
 * empty array means all hosts are valid. A valid host is a single lowercase
 * intrinsic tag token (`/^[a-z][a-z0-9-]*$/` — no `|`, no spaces, no upper).
 *
 * Pure helper — does NOT mutate the map and does NOT print anything. Used by
 * tests to assert the diagnostic messages without invoking the parser.
 * In production the same checks run inside `parseComponentsLenient` and print
 * via `warnContract` (stderr) during contract loading.
 */
export function validateDeclaredHosts(
  components: Readonly<Record<string, string>>,
): string[] {
  const diagnostics: string[] = [];
  for (const [name, host] of Object.entries(components)) {
    if (VALID_HOST_RE.test(host)) continue;
    if (host.includes("|")) {
      diagnostics.push(
        `binclusive.json: "${name}" host "${host}" is the un-edited declare hint — pick ONE host, e.g. "${name}": "button".`,
      );
    } else {
      diagnostics.push(
        `binclusive.json: "${name}" host "${host}" is not a valid intrinsic tag (must be a single lowercase tag like "button" or "a") — entry ignored.`,
      );
    }
  }
  return diagnostics;
}

/**
 * Emit a non-fatal warning for a malformed OPTIONAL field. Optional fields are
 * the escape hatch — a bad entry degrades gracefully (skip it, keep the rest)
 * rather than crashing the scan, so the warning is the only signal. Routed
 * through one helper so the channel (stderr) is consistent and testable.
 */
function warnContract(message: string): void {
  console.warn(`binclusive.json: ${message} — ignored.`);
}

/**
 * Parse the optional `components` map leniently: keep only `string -> string`
 * entries where the value is a valid intrinsic tag token. Drops (with a
 * warning) any entry whose value isn't a string, is empty, or isn't a single
 * lowercase tag. A non-object value for the whole field is dropped entirely.
 * Absent → `{}`.
 */
function parseComponentsLenient(v: unknown): Record<string, string> {
  if (v === undefined) return {};
  if (!isObject(v)) {
    warnContract("components must be an object of name->host strings");
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, host] of Object.entries(v)) {
    if (typeof host !== "string" || host === "") {
      warnContract(`components["${name}"] must be a non-empty host string`);
      continue;
    }
    if (!VALID_HOST_RE.test(host)) {
      if (host.includes("|")) {
        warnContract(
          `"${name}" host "${host}" is the un-edited declare hint — pick ONE host, e.g. "${name}": "button"`,
        );
      } else {
        warnContract(
          `"${name}" host "${host}" is not a valid intrinsic tag (must be a single lowercase tag like "button" or "a")`,
        );
      }
      continue;
    }
    out[name] = host;
  }
  return out;
}

/**
 * Parse an optional `string[]` leniently: keep the string elements, drop
 * (with a warning) any non-string, and drop the whole field if it isn't an
 * array. Absent → `[]`. Used by both `injectsChildren` and `ignore`.
 */
function parseStringArrayLenient(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    warnContract(`${field} must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  for (const el of v) {
    if (typeof el !== "string" || el === "") {
      warnContract(`${field}[] entries must be non-empty strings`);
      continue;
    }
    out.push(el);
  }
  return out;
}

/**
 * Parse the optional escape-hatch declarations. Every sub-field degrades
 * gracefully — a malformed `components`/`injectsChildren`/`ignore` is reduced to
 * its valid entries (or empty), never thrown. The block is always returned
 * (empty when absent) so the rest of the pipeline never branches on presence.
 */
function parseDeclarations(raw: Record<string, unknown>): Declarations {
  return {
    components: parseComponentsLenient(raw.components),
    injectsChildren: parseStringArrayLenient(raw.injectsChildren, "injectsChildren"),
    ignore: parseStringArrayLenient(raw.ignore, "ignore"),
  };
}

function parseLearnedRule(v: unknown, idx: number): LearnedRule {
  if (!isObject(v)) throw new ContractParseError(`learned[${idx}] must be an object`);
  const { id, rule, wcag, fix, source, addedAt } = v;
  if (typeof id !== "string") throw new ContractParseError(`learned[${idx}].id must be a string`);
  if (typeof rule !== "string")
    throw new ContractParseError(`learned[${idx}].rule must be a string`);
  if (typeof source !== "string")
    throw new ContractParseError(`learned[${idx}].source must be a string`);
  if (typeof addedAt !== "string")
    throw new ContractParseError(`learned[${idx}].addedAt must be a string`);
  if (fix !== null && typeof fix !== "string")
    throw new ContractParseError(`learned[${idx}].fix must be a string or null`);
  return {
    id,
    rule,
    wcag: parseStringArray(wcag, `learned[${idx}].wcag`),
    fix: fix ?? null,
    source,
    addedAt,
  };
}

/**
 * Parse a `binclusive.json` document loaded as `unknown` from disk. Throws
 * {@link ContractParseError} on any structural violation. The version is
 * checked exactly: an unknown version is a hard error, not a silent upgrade.
 */
export function parseContract(raw: unknown): Contract {
  if (!isObject(raw)) throw new ContractParseError("top level must be an object");
  if (raw.version !== CONTRACT_VERSION)
    throw new ContractParseError(`version must be ${CONTRACT_VERSION}, got ${String(raw.version)}`);
  const learnedRaw = raw.learned;
  if (!Array.isArray(learnedRaw)) throw new ContractParseError("learned must be an array");
  return {
    version: CONTRACT_VERSION,
    stack: parseStack(raw.stack),
    enforcement: parseEnforcement(raw.enforcement),
    learned: learnedRaw.map(parseLearnedRule),
    declarations: parseDeclarations(raw),
  };
}

/**
 * Serialize a contract to the canonical on-disk string (2-space, trailing
 * newline). The escape-hatch declarations are written FLAT at the top level
 * (`components` / `injectsChildren` / `ignore`) — the customer edits them by
 * hand, so they read as first-class fields, not a nested `declarations` blob.
 * Each is emitted ONLY when non-empty, so a zero-config contract stays minimal
 * and a re-`init` never injects empty escape-hatch keys into a clean file.
 */
export function serializeContract(contract: Contract): string {
  const { declarations, ...rest } = contract;
  const doc: Record<string, unknown> = { ...rest };
  if (Object.keys(declarations.components).length > 0) doc.components = declarations.components;
  if (declarations.injectsChildren.length > 0) doc.injectsChildren = declarations.injectsChildren;
  if (declarations.ignore.length > 0) doc.ignore = declarations.ignore;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The default enforcement policy for a fresh contract: the corpus's
 * very-common SC block the build; the rest of the mapped SC warn. Passed the
 * full set of SC the checker knows about, split by whether each is very-common.
 */
export function defaultEnforcement(
  veryCommon: readonly string[],
  rest: readonly string[],
): Enforcement {
  return { block: [...veryCommon], warn: [...rest] };
}
