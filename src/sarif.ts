/**
 * SARIF 2.1.0 renderer — GitHub code-scanning's finding interchange format.
 * Harvested from the platform CLI's renderer (`@binclusive/cli`
 * `src/output/sarif.ts`) and RETARGETED to the engine's rich LOCAL
 * {@link EnrichedFinding}: a SARIF `physicalLocation` needs the `file`/`line` the
 * metadata-only wire contract deliberately drops, so this is a LOCAL renderer
 * that reads the source-anchored model directly — it never routes through the
 * contract projection.
 *
 * Severity is the ONE contract enum: {@link severityToLevel} maps
 * `critical|major|minor` onto SARIF's `error|warning|note`, and
 * `contractSeverity` supplies that enum from the finding's resolved axe impact.
 * So text, ticket, and SARIF all narrow through the same severity mapping.
 */
import { relative } from "node:path";
import type { Severity as ContractSeverity } from "@binclusive/a11y-contract";
import { contractSeverity, hasSelector, impactToSeverity, toContractProvenance } from "./emit-contract";
import { evidenceHelpUrl, type EnrichedFinding } from "./evidence";

// Re-export the severity mapping so a consumer wiring SARIF has the whole
// severity story from one module. `impactToSeverity` is the axe -> contract
// collapse; `severityToLevel` is contract -> SARIF level.
export { impactToSeverity };

/** The one contract-severity -> SARIF-level mapping. Exhaustive over the closed enum. */
export function severityToLevel(severity: ContractSeverity): "error" | "warning" | "note" {
  switch (severity) {
    case "critical":
      return "error";
    case "major":
      return "warning";
    case "minor":
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
  const location: SarifLocation = {
    physicalLocation: {
      artifactLocation: { uri: locationUri(f.file, root) },
      ...(f.line > 0 ? { region: { startLine: f.line } } : {}),
    },
  };
  if (hasSelector(f.selector)) {
    location.logicalLocations = [{ fullyQualifiedName: f.selector, kind: "element" }];
  }
  return [location];
}

/**
 * Render a SARIF 2.1.0 log over the LOCAL findings. `runId` names the run in
 * `automationDetails` (e.g. a PR number or scan id). Rules are the deduped set
 * of fired rule ids; each result carries its severity level, source location,
 * and a `properties.provenance` tag (`deterministic` | `agent`) so the two
 * checker lanes stay distinguishable once both feed SARIF. `opts.root`, when
 * given, relativizes source-file uris against the scanned root — the form
 * GitHub code-scanning needs to anchor annotations on the PR diff.
 */
export function formatSarif(
  findings: readonly EnrichedFinding[],
  runId: string,
  opts: { readonly root?: string } = {},
): string {
  const ruleIds = [...new Set(findings.map((f) => f.ruleId))];
  const ruleById = new Map(findings.map((f) => [f.ruleId, f]));

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
              return {
                id,
                ...(f ? { shortDescription: { text: f.message } } : {}),
                ...(helpUri ? { helpUri } : {}),
              };
            }),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          level: severityToLevel(contractSeverity(f)),
          message: { text: f.message },
          locations: findingLocations(f, opts.root),
          properties: { provenance: toContractProvenance(f.provenance) },
        })),
        automationDetails: {
          id: `binclusive-a11y/${runId}`,
        },
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
