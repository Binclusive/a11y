/**
 * SARIF 2.1.0 renderer — GitHub code-scanning's finding interchange format.
 * Harvested from the platform CLI's renderer (`@binclusive/cli`
 * `src/output/sarif.ts`) and RETARGETED to the engine's rich LOCAL
 * {@link EnrichedFinding}: a SARIF `physicalLocation` needs the `file`/`line` the
 * metadata-only wire contract deliberately drops, so this is a LOCAL renderer
 * that reads the source-anchored model directly — it never routes through the
 * contract projection.
 *
 * Impact is the ONE contract enum: {@link impactToLevel} maps the four concrete
 * axe impacts (plus `unknown`) onto SARIF's `error|warning|note`, and
 * {@link evidenceImpact} supplies that value from the finding's resolved axe
 * impact. So text and SARIF narrow through the same impact vocabulary.
 */
import { relative } from "node:path";
import type { Impact } from "@binclusive/a11y-contract";
import { hasSelector, toContractProvenance } from "./emit-contract";
import { evidenceHelpUrl, evidenceImpact, type EnrichedFinding, resolveDisplay } from "./evidence";
import { type LocationOptions, resolveLocations } from "./source-identity";

/**
 * The one contract-impact -> SARIF-level mapping. Exhaustive over the closed enum.
 * `critical`/`serious` are the actionable errors; `moderate` a warning; `minor`
 * and `unknown` (not judged) are notes — SARIF's lowest, honest floor.
 */
export function impactToLevel(impact: Impact): "error" | "warning" | "note" {
  switch (impact) {
    case "critical":
    case "serious":
      return "error";
    case "moderate":
      return "warning";
    case "minor":
    case "unknown":
      return "note";
  }
}

// A SARIF physicalLocation anchors on an artifactLocation (the source file); a
// source-line region rides it when the finding has one. A rendered-DOM (axe)
// finding carries `file` = the page URL and `line` = 0, so it emits no region
// but maps its CSS `selector` to a logicalLocation instead.
interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: { startLine: number };
  };
  logicalLocations?: Array<{ fullyQualifiedName: string; kind: "element" }>;
}

// A `relatedLocations` entry: a location relevant to *understanding* a finding
// but that is not where the finding IS (SARIF §3.27.22). Here it is the rendered
// DOM node a SOURCE-anchored finding also names — a genuinely distinct second
// node beyond the code site. A CSS selector has no source region, so it rides a
// `logicalLocations` and carries no `physicalLocation` (§3.28 — all fields
// optional). No `id`: nothing links to it, so the spec says omit it (§3.28.2).
interface SarifRelatedLocation {
  message: { text: string };
  logicalLocations: Array<{ fullyQualifiedName: string; kind: "element" }>;
}

// GitHub code-scanning resolves a SARIF `uri` relative to the repo root, so when
// a workspace `root` is given the source-file uri is relativized against it — a
// scan of a staged mirror dir then still yields repo-relative `src/Foo.tsx`
// paths that annotate the right line of the PR diff. A rendered-DOM (axe)
// finding's `file` is the page URL, not a workspace path, so it is left as-is.
function locationUri(file: string, root: string | undefined): string {
  if (root === undefined || /^https?:\/\//i.test(file)) return file;
  return relative(root, file);
}

function findingLocations(f: EnrichedFinding, root: string | undefined): SarifLocation[] {
  const hasRegion = f.line > 0;
  const location: SarifLocation = {
    physicalLocation: {
      artifactLocation: { uri: locationUri(f.file, root) },
      ...(hasRegion ? { region: { startLine: f.line } } : {}),
    },
  };
  // A PAGE finding (no source region — its `file` is the page URL) addresses its
  // offending node by CSS selector, so the selector is that primary node's
  // logical address (§3.28). A SOURCE finding's selector names a DISTINCT
  // rendered node, not a qualifier of the code line, so it rides
  // `relatedLocations` (see {@link findingRelatedLocations}) — never both.
  if (!hasRegion && hasSelector(f.selector)) {
    location.logicalLocations = [{ fullyQualifiedName: f.selector, kind: "element" }];
  }
  return [location];
}

// A source-anchored finding (primary = `file:line`) that ALSO names a rendered
// DOM node has a genuinely distinct second location worth surfacing: the code
// line is where the finding IS; the element is context that helps understand it
// (e.g. a corpus-agent discovery grounded in a `jsx-a11y` line that names an
// `element`). A PAGE finding's selector is its PRIMARY node, not a related one,
// so it never reaches here — the result is graceful-empty for every other shape.
function findingRelatedLocations(f: EnrichedFinding): SarifRelatedLocation[] {
  if (f.line > 0 && hasSelector(f.selector)) {
    return [
      {
        message: { text: `Rendered element: ${f.selector}` },
        logicalLocations: [{ fullyQualifiedName: f.selector, kind: "element" }],
      },
    ];
  }
  return [];
}

/**
 * Render a SARIF 2.1.0 log over the LOCAL findings. `runId` names the run in
 * `automationDetails` (e.g. a PR number or scan id). Rules are the deduped set
 * of fired rule ids; each carries the fix prose in `help`/`fullDescription` —
 * the field Copilot Autofix reads to GENERATE an edit (it ignores
 * `result.fixes[]`, which this renderer deliberately never emits: a valid SARIF
 * fix requires fabricated `artifactChanges`, violating suggestions-not-patches).
 * Each result carries its impact level, source location, the rationale in
 * `message`, an optional `relatedLocations` entry when it names a distinct
 * rendered node, and a `properties.provenance` tag (`deterministic` | `agent`)
 * so the two checker lanes stay distinguishable once both feed SARIF.
 * `opts.root`, when given, relativizes source-file uris against the scanned
 * root — the form GitHub code-scanning needs to anchor annotations on the PR diff.
 *
 * A source result also carries `partialFingerprints.primaryLocationLineHash` so
 * code-scanning tracks the alert across commits as lines move (ADR 0042's "free
 * consistency win"): the hash is the SAME source-identity fingerprint the wire
 * contract emits — see the results map for why they can never disagree.
 */
export function formatSarif(
  findings: readonly EnrichedFinding[],
  runId: string,
  opts: LocationOptions = {},
): string {
  const ruleIds = [...new Set(findings.map((f) => f.ruleId))];
  const ruleById = new Map(findings.map((f) => [f.ruleId, f]));

  // Resolve every finding's identity through the ONE hash function the wire
  // contract uses (`resolveLocations`), so SARIF and the emitted identity can
  // never disagree on a line's hash. Page findings resolve to a `page` location
  // (no line hash) and honestly get no `primaryLocationLineHash`.
  const located = resolveLocations(findings, opts);

  const sarif = {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0" as const,
    runs: [
      {
        tool: {
          driver: {
            name: "Binclusive",
            informationUri: "https://binclusive.io",
            rules: ruleIds.map((id) => {
              const f = ruleById.get(id);
              const helpUri = f ? evidenceHelpUrl(f) : null;
              // The rule-generic fix prose. Copilot Autofix reads `help`/
              // `fullDescription` (NOT `result.fixes[]`) to GENERATE its edit, so
              // this is the lever for auto-fixability — the SC/rule-accurate fix
              // guidance, single-sourced through {@link resolveDisplay}. It stays
              // prose (suggestions-not-patches): guidance to generate from, never a
              // fabricated edit. Absent when a finding carries no fix (evidence
              // `none`) — then Autofix falls back to the message + help URL.
              const fixProse = f ? resolveDisplay(f).fix : null;
              return {
                id,
                ...(f ? { shortDescription: { text: f.message } } : {}),
                ...(fixProse ? { fullDescription: { text: fixProse }, help: { text: fixProse } } : {}),
                ...(helpUri ? { helpUri } : {}),
              };
            }),
          },
        },
        results: findings.map((f) => {
          const loc = located.get(f);
          const related = findingRelatedLocations(f);
          // The specific rationale/suggestion Autofix pulls snippets around. A
          // DISCOVERY finding already folds observation+rationale+fix into
          // `message`; an ENRICHED deterministic finding carries the suggestion
          // separately in `agentNote`, so append it — prose, never a patch — so
          // the SARIF message carries the agent's reasoning either way.
          const message = f.agentNote !== undefined ? `${f.message} ${f.agentNote}` : f.message;
          return {
            ruleId: f.ruleId,
            level: impactToLevel(evidenceImpact(f) ?? "unknown"),
            message: { text: message },
            locations: findingLocations(f, opts.root),
            // Only present when a source-anchored finding names a distinct rendered
            // node; graceful-empty (omitted) otherwise, never a fabricated spot.
            ...(related.length > 0 ? { relatedLocations: related } : {}),
            // `<lineHash>:<index>` — the content hash lets code-scanning re-match the
            // alert when the line moves; `index` disambiguates identical lines within a
            // file, exactly as the finding identity does. A page finding has no source
            // line, so it carries no fingerprint (never fabricate one).
            ...(loc?.kind === "source"
              ? { partialFingerprints: { primaryLocationLineHash: `${loc.lineHash}:${loc.index}` } }
              : {}),
            properties: { provenance: toContractProvenance(f.provenance) },
          };
        }),
        automationDetails: {
          id: `binclusive-a11y/${runId}`,
        },
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
