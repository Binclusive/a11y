import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import {
  isIconLibrary,
  isStructural,
  isToggleRole,
  lookupGuaranteed,
  lookupRegistry,
} from "./registry";
import {
  collectLocalImports,
  resolveRoute,
  traceComponent,
  traceWrapperOrigin,
} from "./source-trace";

/**
 * Resolve, for a set of scanned files, every wrapper component used in JSX to
 * the host primitive it renders — so jsx-a11y's rules (which only see literal
 * element names) fire on wrapped components too.
 *
 * Pipeline per used component:
 *   0. declared  — customer's `binclusive.json` `components` map wins outright
 *   1. registry  — known design-system mapping, no source needed
 *   2. trace     — resolve import, read source, infer single host + forwarding
 *   3. opaque    — neither resolved; counted in the coverage report, NOT hidden
 *
 * Step 0 is the escape hatch: a customer DECLARES the host for a wrapper the
 * checker can't reach (host hidden behind library indirection, or no source on
 * disk). It overrides registry/trace because the customer's word beats inference.
 *
 * The point of step 3 is honesty: a silent skip looks like a clean codebase.
 * Surfacing the opaque set tells the user where the checker is blind. But
 * "opaque" is not one thing — it sub-classifies into four honest buckets so the
 * report doesn't paint a design-system app as 94% blind (see {@link OpaqueKind}):
 *
 *   - trusted    — imported from a known-accessible design system (Radix, MUI, …).
 *                  The library guarantees the structure; opaque-but-fine.
 *   - icons      — an icon library (lucide, heroicons, …). No interactive host
 *                  exists to check; nothing actionable.
 *   - structural — plumbing with no interactive host: `Fragment`, providers,
 *                  router layout (`Outlet`/`Route`), charts, email components.
 *                  Like `icons`, non-actionable — NOT a gap, no declare hint.
 *   - declare    — none of the above: a genuine unknown. THIS is the real gap,
 *                  and the only bucket that carries the "declare it" hint.
 *
 * The sub-classification is REPORTING ONLY — none of the four enters the
 * jsx-a11y map, exactly as a flat opaque didn't. Checking behavior is unchanged.
 */

const CAP_NAME = /^[A-Z]/; // capitalized JSX name = component (vs intrinsic host)

/**
 * How a component's host was determined, for the coverage report. `declared` is
 * the customer's `binclusive.json` override — counted as covered, same as the
 * auto-resolved provenances. `opaque` means no host could be determined; an
 * opaque component additionally carries an {@link OpaqueKind} sub-classification.
 */
export type Provenance = "declared" | "registry" | "trace" | "opaque";

/** A provenance under which a host WAS determined (so the component is CHECKED). */
export type ResolvedProvenance = Exclude<Provenance, "opaque">;

/**
 * The honest sub-bucket of an OPAQUE component — why it has no host, and whether
 * that's a real gap. See {@link resolveComponents}'s step 3.
 *
 *   - `trusted`    — from a known-accessible design system. Opaque-but-fine: the
 *                    library handles its internal a11y when used correctly.
 *   - `icons`      — from an icon library. No interactive host to check; not a gap.
 *   - `structural` — non-rendering / non-interactive plumbing (`Fragment`,
 *                    providers, router layout, charts, email). Like `icons`: no
 *                    host exists to check, so it is NOT a gap and carries no hint.
 *   - `declare`    — none of the above: neither resolvable nor recognized. The
 *                    genuine unknown — the only bucket that gets the declare hint.
 */
export type OpaqueKind = "trusted" | "icons" | "structural" | "declare";

/**
 * Per-component resolution outcome, a discriminated union on `provenance`:
 *
 *   - resolved (`declared`/`registry`/`trace`) → a concrete `host`, fed to
 *     jsx-a11y. No `opaqueKind` (it would be meaningless — the host is known).
 *   - opaque → `host: null` plus an `opaqueKind` bucket for the report. The
 *     `library` is the guaranteeing design system for `trusted`, else `null`.
 *
 * Modeling it as a union makes the impossible state (an `opaqueKind` on a
 * resolved component, or a `host` on an opaque one) unrepresentable.
 */
export type ComponentResolution =
  | {
      readonly name: string;
      readonly module: string;
      readonly host: string;
      readonly provenance: ResolvedProvenance;
      /**
       * The explicit ARIA `role` the resolved host carries, when one is known
       * (a Radix/antd toggle primitive, or a static `role="…"` literal captured
       * in the trace); `null` otherwise. A TOGGLE role ({@link isToggleRole})
       * means the host is a checkbox/switch/radio, NOT a bare button/input — so
       * such a host is kept OUT of the jsx-a11y map and skipped by enforce.
       */
      readonly role: string | null;
      /**
       * Whether the wrapper renders its host an internal STATIC accessible name
       * (an `sr-only`/visually-hidden span, a literal `aria-label`, or static
       * text children) — captured by the trace. When true the control is named
       * even though the self-closing call site looks empty, so enforce skips its
       * no-name check, exactly as a toggle role is skipped. `false` for declared
       * and registry resolutions (no source body to scan).
       */
      readonly rendersOwnName: boolean;
    }
  | {
      readonly name: string;
      readonly module: string;
      readonly host: null;
      readonly provenance: "opaque";
      readonly opaqueKind: OpaqueKind;
      /** Guaranteeing library name for `trusted`; `null` for `icons`/`declare`. */
      readonly library: string | null;
    };

/**
 * Coverage tally across all resolved components. `opaque` is the total of the
 * four opaque sub-buckets (`trusted + icons + structural + declare`), kept so
 * existing callers that only care "how many had no host" stay correct; the
 * sub-bucket counts are the reframed, honest split.
 */
export interface Coverage {
  readonly total: number;
  readonly declared: number;
  readonly registry: number;
  readonly traced: number;
  readonly opaque: number;
  /** OPAQUE from a known-accessible design system — the library handles a11y. */
  readonly trusted: number;
  /** OPAQUE icon-library components — no interactive host to check. */
  readonly icons: number;
  /** OPAQUE plumbing (Fragment/provider/router/chart/email) — no host; not a gap. */
  readonly structural: number;
  /** OPAQUE genuine unknowns — the real gap; carries the declare hint. */
  readonly declare: number;
}

/** The resolved jsx-a11y component map plus its coverage report. */
export interface ResolvedComponents {
  /** `settings.components` value: wrapper name -> host primitive. */
  readonly map: Readonly<Record<string, string>>;
  readonly coverage: Coverage;
  /** Full per-component detail, incl. opaque ones, for reporting. */
  readonly resolutions: readonly ComponentResolution[];
  /**
   * Distinct bare-package specifiers (e.g. `@base-ui/react`) for components
   * that landed in the `declare` bucket AND cannot be resolved to any file on
   * disk. Sorted. An empty array means all declare-bucket components came from
   * resolvable sources (composite wrappers, etc.) — no package install note
   * needed. Non-empty signals the cold-scan blind spot: "install deps to trace".
   */
  readonly unresolvedPackages: readonly string[];
  /**
   * The parsed `ts.SourceFile` for each SCANNED file (keyed by the path passed
   * in), built by the walk this resolver already does. Surfaced so a downstream
   * consumer (R4's `collectIntrinsicElements`, the edit-time hook's recall
   * whisper) can reuse the parse instead of re-reading + re-parsing the file —
   * the no-second-parse guarantee the hot hook path needs. A file that couldn't
   * be read is absent (the resolver `continue`s on a read failure).
   */
  readonly sourceFiles: ReadonlyMap<string, ts.SourceFile>;
}

/** A capitalized JSX name used in a file, with its local-import context. */
export interface UsedComponent {
  readonly local: string;
  readonly module: string;
  readonly imported: string;
  readonly isNamespace: boolean;
}

/**
 * Find every capitalized JSX element used in a file that maps to an import,
 * deduped by local name. Locally-defined components (not imported) are skipped
 * here — they are resolved separately because their "import" is the file itself.
 *
 * Exported so a per-file consumer (the recall gate's per-file slice scoping) can
 * learn which resolutions a single file actually USES — the globally-deduped
 * {@link ComponentResolution} array carries no file home of its own.
 */
export function collectUsedComponents(sf: ts.SourceFile): UsedComponent[] {
  const imports = collectLocalImports(sf);
  const seen = new Set<string>();
  const out: UsedComponent[] = [];

  const consider = (rawName: string): void => {
    // `NS.Member` -> resolve via the namespace local name.
    const dot = rawName.indexOf(".");
    const local = dot === -1 ? rawName : rawName.slice(0, dot);
    const member = dot === -1 ? null : rawName.slice(dot + 1);
    if (!CAP_NAME.test(local)) return;
    if (seen.has(rawName)) return;
    const binding = imports.get(local);
    if (binding === undefined) return;
    seen.add(rawName);
    out.push({
      local: rawName,
      module: binding.module,
      imported: binding.isNamespace ? (member ?? binding.imported) : binding.imported,
      isNamespace: binding.isNamespace,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName;
      if (ts.isIdentifier(tagName)) {
        consider(tagName.text);
      } else if (ts.isPropertyAccessExpression(tagName) && ts.isIdentifier(tagName.expression)) {
        consider(`${tagName.expression.text}.${tagName.name.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function readSourceFile(filePath: string): ts.SourceFile | null {
  const text = ts.sys.readFile(filePath);
  if (text === undefined) return null;
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/**
 * The key jsx-a11y matches a JSX element on. For a namespace render
 * (`NS.Member`) that's the trailing member name; for a plain wrapper it's the
 * name itself. Split-derived so it never needs a non-null assertion.
 */
export function jsxKeyFor(localName: string): string {
  const parts = localName.split(".");
  return parts[parts.length - 1] ?? localName;
}

/**
 * Host primitives whose ONLY scored jsx-a11y rule cannot be evaluated through a
 * wrapper, so a wrapper resolving to one must NOT be put in the component map.
 *
 * `label` is the case: the only `label`-targeting rule is
 * `label-has-associated-control`, which passes when the label carries `htmlFor`
 * or nests its control. A library label COMPONENT (`FormLabel`, `FieldLabel`,
 * MUI `InputLabel`, ...) establishes that association INTERNALLY — via `htmlFor`
 * it injects, React context, or composition — none of which is visible at the
 * `<FormLabel>Name</FormLabel>` call site. Mapping the wrapper to `label` makes
 * jsx-a11y treat the call site as a bare `<label>` and demand a call-site
 * association that isn't there, firing on EVERY usage: a guaranteed false
 * positive.
 *
 * Excluding these from the map (while still counting them as resolved coverage)
 * is false-negative-safe: a genuinely unassociated label written as a literal
 * lowercase `<label>` is an intrinsic element jsx-a11y sees directly — it is
 * unaffected by the component map and still flags correctly.
 */
const UNMAPPABLE_HOSTS: ReadonlySet<string> = new Set(["label"]);

/**
 * Resolve all wrapper components across the given scanned files into a
 * jsx-a11y component map plus a coverage report. A component resolved in one
 * file is reused everywhere (the map key is the JSX name jsx-a11y matches on).
 *
 * `declared` is the customer's `binclusive.json` `components` map (JSX name ->
 * host). It is the escape hatch: a declared entry resolves a wrapper the checker
 * can't reach and OVERRIDES registry/trace inference. Declared entries that no
 * scanned file actually USES are silently ignored — coverage reflects the code,
 * not the config — so a stale declaration never inflates the tally.
 */
/**
 * The npm package NAME of a bare specifier, or `null` if the specifier is not a
 * syntactically valid bare package import.
 *
 * Rejects (returns null) — these are NOT packages, so they can never be a
 * "missing dependency":
 *   - relative (`.`/`..`), absolute (`/`), and subpath-imports (`#internal`)
 *   - path aliases that LOOK bare but aren't valid package names: a leading `~`
 *     (`~/components/card`), and an empty-scope `@/...` (an `@` not followed by a
 *     scope segment, the Next/Vite default alias). These are the exact shapes
 *     that leaked into the unresolved-package note before the deps cross-check.
 *
 * For a real bare import it returns the package id: `pkg` or `@scope/pkg`,
 * stripping any `/subpath` (`@base-ui/react/Dialog` → `@base-ui/react`).
 */
function packageNameOf(specifier: string): string | null {
  if (
    specifier === "" ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("~")
  ) {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    // Scoped: must be `@scope/name` — reject empty-scope (`@/...`) and a bare
    // `@scope` with no name segment.
    const scope = parts[0];
    const name = parts[1];
    if (scope === undefined || scope === "@" || name === undefined || name === "") return null;
    return `${scope}/${name}`;
  }
  const name = parts[0];
  return name === undefined || name === "" ? null : name;
}

/** Per-directory cache of the nearest package.json's declared-dependency set. */
const declaredDepsCache = new Map<string, ReadonlySet<string>>();

/** The dependency buckets whose union counts as a "declared dependency". */
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * The union of every declared dependency in the nearest `package.json` at or
 * above `fromFile`. This is the real gate for the unresolved-package note: a
 * specifier is only reported as an uninstalled package when it IS a declared
 * dependency (so "install dependencies" is always correct advice) — path aliases
 * and ad-hoc bare strings that no manifest declares are excluded. Walks up to the
 * filesystem root; a malformed or missing manifest yields an empty set. Cached
 * per starting directory.
 */
function declaredDependencies(fromFile: string): ReadonlySet<string> {
  let dir = dirname(fromFile);
  for (;;) {
    const cached = declaredDepsCache.get(dir);
    if (cached !== undefined) return cached;

    let text: string | null = null;
    try {
      text = readFileSync(join(dir, "package.json"), "utf8");
    } catch {
      text = null;
    }
    if (text !== null) {
      const deps = new Set<string>();
      try {
        const pkg: unknown = JSON.parse(text);
        if (typeof pkg === "object" && pkg !== null) {
          for (const field of DEP_FIELDS) {
            const bucket = (pkg as Record<string, unknown>)[field];
            if (typeof bucket === "object" && bucket !== null && !Array.isArray(bucket)) {
              for (const name of Object.keys(bucket)) deps.add(name);
            }
          }
        }
      } catch {
        // Malformed manifest → empty set (boundary-parsed, never throws).
      }
      declaredDepsCache.set(dir, deps);
      return deps;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const empty = new Set<string>();
  declaredDepsCache.set(dirname(fromFile), empty);
  return empty;
}

export function resolveComponents(
  filePaths: readonly string[],
  declared: Readonly<Record<string, string>> = {},
): ResolvedComponents {
  const map: Record<string, string> = {};
  const resolutions: ComponentResolution[] = [];
  const seen = new Set<string>();
  // Collect bare package specifiers that are unresolvable on disk AND produced a
  // declare-bucket opaque. Deduplicated; built into `unresolvedPackages` at the end.
  const unresolvedPkgSet = new Set<string>();
  // Keep each scanned file's parse so a downstream consumer (R4) can reuse it
  // rather than re-read+re-parse — this is the parse the resolver already does.
  const sourceFiles = new Map<string, ts.SourceFile>();

  for (const filePath of filePaths) {
    const sf = readSourceFile(filePath);
    if (sf === null) continue;
    sourceFiles.set(filePath, sf);

    for (const used of collectUsedComponents(sf)) {
      // Dedupe across files by (name@module) so the report counts each wrapper
      // once, not once per usage site.
      const key = `${used.local}@${used.module}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Add a resolved wrapper to the jsx-a11y map UNLESS its host can't be
      // evaluated through a wrapper. Two exclusions, both still counted as
      // resolved coverage:
      //   - UNMAPPABLE_HOSTS — the host's sole rule needs call-site context the
      //     wrapper hides (`label`).
      //   - a TOGGLE role — a `button`/`input` host that actually renders
      //     `role="checkbox|switch|radio"` (Radix Checkbox/Switch, antd Switch,
      //     a homegrown `<button role="switch">`). Mapping it to the bare host
      //     makes jsx-a11y read `<Checkbox aria-invalid>` as a bare `<button>`
      //     and fire `role-supports-aria-props` — a false positive, since
      //     `aria-invalid` IS valid on `role="checkbox"`. Skipping the map (like
      //     a label wrapper) is FN-safe: a literal broken toggle is still seen.
      const recordResolved = (
        host: string,
        provenance: ResolvedProvenance,
        role: string | null,
        rendersOwnName: boolean,
      ): void => {
        if (!UNMAPPABLE_HOSTS.has(host) && !isToggleRole(role)) {
          map[jsxKeyFor(used.local)] = host;
        }
        resolutions.push({
          name: used.local,
          module: used.module,
          host,
          provenance,
          role,
          rendersOwnName,
        });
      };

      // 0. Customer declaration wins outright — the escape hatch for hosts the
      //    checker can't infer. Keyed by the JSX name jsx-a11y matches on. A
      //    declared host carries no role and no internal name (the customer
      //    declares only the host).
      const declaredHost = declared[jsxKeyFor(used.local)];
      if (declaredHost !== undefined) {
        recordResolved(declaredHost, "declared", null, false);
        continue;
      }

      // Registry is checked inside traceComponent, but we want the provenance
      // distinction (registry vs trace) for the report, so probe it directly. A
      // registry leaf primitive renders no internal name of its own.
      const reg = lookupRegistry(used.module, used.imported);
      if (reg !== null) {
        recordResolved(reg.host, "registry", reg.role ?? null, false);
        continue;
      }

      const traced = traceComponent(used.module, used.imported, filePath);
      if (traced !== null) {
        recordResolved(traced.host, traced.via, traced.role ?? null, traced.rendersOwnName);
        continue;
      }

      // OPAQUE: no host. Sub-classify HONESTLY by where the import comes from.
      // Order is by certainty of "no interactive host":
      //   icons      — an SVG pack (`@radix-ui/react-icons`): no host, period.
      //                Checked FIRST so the `@radix-ui` guarantee prefix can't
      //                claim it as `trusted`.
      //   structural — plumbing (Fragment / *Provider / router layout / chart /
      //                email): also no host, also non-actionable. Checked BEFORE
      //                `trusted` because a provider from a guaranteed library
      //                (`<Tooltip.Provider>` from `@radix-ui`) is still plumbing,
      //                not a primitive to vouch for — structural is the truer
      //                bucket. A genuine control from a guaranteed lib never
      //                matches the structural rules, so it still reads `trusted`.
      //   trusted    — from a known-accessible design system.
      //   declare    — the genuine unknown; the only actionable gap.
      const isIcons = isIconLibrary(used.module);
      const isPlumbing = !isIcons && isStructural(used.local, used.module);
      const guaranteedLib = isIcons || isPlumbing ? null : lookupGuaranteed(used.module);
      let opaqueKind: OpaqueKind = isIcons
        ? "icons"
        : isPlumbing
          ? "structural"
          : guaranteedLib !== null
            ? "trusted"
            : "declare";
      let opaqueLibrary = guaranteedLib;

      // Own-code barrel re-export reclassification. The buckets above key on the
      // literal import specifier, so a local `@/components/ui/dialog` wrapper that
      // is just a thin alias of a guaranteed primitive (`const Dialog =
      // DialogPrimitive.Root`) wears its OWN `@/…` specifier and reads `declare` —
      // even though it is Radix underneath. Follow the wrapper to its ORIGIN
      // module and re-bucket THERE: the honest classification is where the
      // primitive really lives. Thin-only (see `traceWrapperOrigin`) — a genuine
      // app composite resolves to no single origin and stays `declare`, never
      // promoted. Same icons→structural→trusted precedence as above, run on the
      // origin module; if the origin is itself unknown, the `declare` stands.
      if (opaqueKind === "declare") {
        const origin = traceWrapperOrigin(used.module, used.imported, filePath);
        if (origin !== null) {
          const originIcons = isIconLibrary(origin);
          const originPlumbing = !originIcons && isStructural(used.local, origin);
          const originGuaranteed =
            originIcons || originPlumbing ? null : lookupGuaranteed(origin);
          if (originIcons) {
            opaqueKind = "icons";
            opaqueLibrary = null;
          } else if (originPlumbing) {
            opaqueKind = "structural";
            opaqueLibrary = null;
          } else if (originGuaranteed !== null) {
            opaqueKind = "trusted";
            opaqueLibrary = originGuaranteed;
          }
        }
      }
      // When a component lands in `declare` because its specifier is a DECLARED
      // dependency that resolveRoute can't reach on disk (uninstalled — shallow
      // clone / fresh checkout), record the package so the CLI can surface an
      // actionable "install deps" note instead of silent blindness.
      //
      // The declared-dependency cross-check is the real gate: it excludes path
      // aliases (`~/…`, `@/…`, tsconfig `@app/…`) — which are NOT deps, so the
      // "install dependencies" advice would be false for them — while keeping the
      // genuine uninstalled packages (each IS in package.json, just not on disk).
      // `packageNameOf` is belt-and-suspenders: it rejects alias-shaped strings
      // syntactically before we even consult the manifest.
      if (opaqueKind === "declare" && resolveRoute(used.module, filePath) === null) {
        const pkgName = packageNameOf(used.module);
        if (pkgName !== null && declaredDependencies(filePath).has(pkgName)) {
          unresolvedPkgSet.add(pkgName);
        }
      }
      resolutions.push({
        name: used.local,
        module: used.module,
        host: null,
        provenance: "opaque",
        opaqueKind,
        library: opaqueLibrary,
      });
    }
  }

  const opaque = resolutions.filter((r) => r.provenance === "opaque");
  const opaqueOf = (kind: OpaqueKind): number => opaque.filter((r) => r.opaqueKind === kind).length;
  const coverage: Coverage = {
    total: resolutions.length,
    declared: resolutions.filter((r) => r.provenance === "declared").length,
    registry: resolutions.filter((r) => r.provenance === "registry").length,
    traced: resolutions.filter((r) => r.provenance === "trace").length,
    opaque: opaque.length,
    trusted: opaqueOf("trusted"),
    icons: opaqueOf("icons"),
    structural: opaqueOf("structural"),
    declare: opaqueOf("declare"),
  };

  const unresolvedPackages = [...unresolvedPkgSet].sort();
  return { map, coverage, resolutions, unresolvedPackages, sourceFiles };
}
