import ts from "typescript";
import type { ResolvedHost } from "./enforce";
import { isToggleRole } from "./registry";
import { collectLocalImports, type ImportBinding } from "./source-trace";
import {
  isHiddenOrUntabbable,
  isNameExemptInputType,
  walkAncestorSuppressors,
} from "./suppressors";

/**
 * The deterministic G3 input (RFC Phase 1, §"The FP discipline").
 *
 * `buildSuppressorMap` runs the SAME ancestor walk `enforceContent` runs — the
 * shared {@link walkAncestorSuppressors} descent that decides `hasLabelAncestor`
 * / `hasNameAncestor` — and records, per JSX line, WHICH of the static floor's
 * suppressor predicates ({@link src/suppressors}) apply there. The map is the
 * floor's hard-won precision, re-expressed as data the corpus-recall layer can
 * (a) feed the model so it self-suppresses and (b) enforce server-side so a
 * grounded-but-misclassified finding on a suppressed line is vetoed.
 *
 * It REUSES the suppressor predicates verbatim — it never re-implements them —
 * so any drift in the floor's suppression logic ripples here automatically. The
 * RESOLVED-HOST skips enforce performs (a traced/registry toggle role, a wrapper
 * that renders its own name, a `type`-exempt INPUT host) need the resolved-host
 * map enforce uses, so it is threaded in: the same `${name}@${module}` lookup
 * {@link buildResolvedHosts} builds. It emits no findings and has no side
 * effects: a pure `(source, resolved hosts) → line → names` read.
 */

/** The suppressor predicates, named. The string IS the wire name fed to G3. */
export type SuppressorName =
  | "label-ancestor"
  | "name-injecting-wrapper"
  | "hidden-untabbable"
  | "name-exempt-input-type"
  | "toggle-role"
  | "renders-own-name";

/**
 * A per-line view of which suppressors apply. Keyed by 1-based line number (the
 * same line a finding anchors to — an element's opening-tag line). The value is
 * the set of suppressor names live AT that line:
 *
 *   - `label-ancestor` / `name-injecting-wrapper` are ANCESTOR suppressors — a
 *     line carries them when an enclosing `<label>` / form-field grouping
 *     (`isLabelContainer`) or a titled `<Tooltip>` (`isNameInjectingWrapper`) is
 *     an ancestor of the element on that line. They mirror the `labelDepth` /
 *     `nameAncestorDepth` the shared {@link walkAncestorSuppressors} threads down.
 *   - `hidden-untabbable` / `name-exempt-input-type` / `toggle-role` /
 *     `renders-own-name` are ELEMENT-LOCAL — the predicate (or the element's
 *     resolved host) holds for the element opening ON that line.
 *
 * One line can carry several (an exempt input under a label). Lines with no live
 * suppressor are absent, so `map.get(line) ?? EMPTY` is the safe read.
 */
export type SuppressorMap = ReadonlyMap<number, ReadonlySet<SuppressorName>>;

/** A toggle role on the element, mirroring `enforce`'s `isToggleRole` skip. */
const TOGGLE_ROLES: ReadonlySet<string> = new Set(["checkbox", "switch", "radio"]);

/**
 * Whether the element opening carries a STATIC toggle `role` (`checkbox` /
 * `switch` / `radio`). The enforce pass skips toggles reached via a traced/
 * registry host whose `role` is a toggle (captured by the resolved-host lookup
 * below); here we ALSO read the role straight off the call-site JSX so the map
 * captures the call-site-visible toggle case. A dynamic `role={x}` is not
 * asserted (uncertain → not a suppressor we can name).
 */
function hasToggleRole(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement, sf: ts.SourceFile): boolean {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== "role") continue;
    const init = attr.initializer;
    let value: string | null = null;
    if (init !== undefined && ts.isStringLiteral(init)) value = init.text.trim().toLowerCase();
    else if (
      init !== undefined &&
      ts.isJsxExpression(init) &&
      init.expression !== undefined &&
      ts.isStringLiteral(init.expression)
    ) {
      value = init.expression.text.trim().toLowerCase();
    }
    if (value !== null && TOGGLE_ROLES.has(value)) return true;
  }
  return false;
}

/** The bare lowercase intrinsic tag of an opening element, or null (a component). */
function intrinsicTag(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string | null {
  const tag = opening.tagName;
  return ts.isIdentifier(tag) && /^[a-z]/.test(tag.text) ? tag.text : null;
}

/** The flattened JSX tag (`Button`, `NS.Member`), or null if not a name we key on. */
function tagNameOf(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string | null {
  const tag = opening.tagName;
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)) {
    return `${tag.expression.text}.${tag.name.text}`;
  }
  return null;
}

/**
 * The resolved host enforce would see for this call site, or null. Mirrors
 * `enforce.classify`'s step 1: key the resolved-host map by `(jsx tag, import
 * module)` so a same-named export from another module can never lend its host.
 */
function resolvedHostOf(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  imports: ReadonlyMap<string, ImportBinding>,
  resolvedHosts: ReadonlyMap<string, ResolvedHost>,
): ResolvedHost | null {
  const tag = tagNameOf(opening);
  if (tag === null) return null;
  const local = tag.includes(".") ? tag.slice(0, tag.indexOf(".")) : tag;
  const binding = imports.get(local);
  if (binding === undefined) return null;
  return resolvedHosts.get(`${tag}@${binding.module}`) ?? null;
}

/**
 * Build the per-line suppressor map for one source file. Mirrors the
 * `enforceContent` ancestor walk via the shared {@link walkAncestorSuppressors}
 * (label / name-injecting depth), and reads the element-local predicates — plus
 * the RESOLVED-HOST skips enforce performs — off each opening:
 *
 *   - `name-exempt-input-type` is emitted ONLY for a form intrinsic
 *     (`input`/`select`/`textarea`) OR a component that RESOLVES to an `input`
 *     host — the exact gate enforce applies (`isNameExemptInputType` runs only on
 *     an input host). A capitalized non-input component is never marked.
 *   - `toggle-role` / `renders-own-name` cover the resolved-host toggle and
 *     own-name skips (a Radix Checkbox traced to `button[role=checkbox]`, a
 *     shadcn wrapper that renders its own `sr-only` name) that call-site syntax
 *     alone cannot see.
 */
export function buildSuppressorMap(
  sf: ts.SourceFile,
  resolvedHosts: ReadonlyMap<string, ResolvedHost> = new Map(),
): SuppressorMap {
  const out = new Map<number, Set<SuppressorName>>();
  const imports = collectLocalImports(sf);

  const add = (line: number, name: SuppressorName): void => {
    let set = out.get(line);
    if (set === undefined) {
      set = new Set<SuppressorName>();
      out.set(line, set);
    }
    set.add(name);
  };

  walkAncestorSuppressors(sf, ({ opening, line, flags }) => {
    // Ancestor suppressors: live if an ENCLOSING container set the depth.
    if (flags.hasLabelAncestor) add(line, "label-ancestor");
    if (flags.hasNameAncestor) add(line, "name-injecting-wrapper");
    // Element-local suppressors read straight off the opening.
    if (isHiddenOrUntabbable(opening, sf)) add(line, "hidden-untabbable");

    const resolved = resolvedHostOf(opening, imports, resolvedHosts);
    // `type`-exemption is only meaningful for a real form control — a form
    // intrinsic, OR a component enforce RESOLVES to an `input` host. Enforce runs
    // `isNameExemptInputType` only there; a capitalized non-input component is
    // NEVER marked (the prior over-broad `tag === null` gate was finding #3).
    const tag = intrinsicTag(opening);
    const isFormIntrinsic = tag === "input" || tag === "select" || tag === "textarea";
    // enforce treats input/select/textarea hosts all as ControlType "input" (its
    // HOST_TO_TYPE), so mirror the full set, not just "input", to provably match.
    const isInputHost =
      resolved !== null &&
      (resolved.host === "input" || resolved.host === "select" || resolved.host === "textarea");
    if ((isFormIntrinsic || isInputHost) && isNameExemptInputType(opening, sf)) {
      add(line, "name-exempt-input-type");
    }

    // Toggle: a call-site `role="checkbox|switch|radio"`, OR a resolved host
    // whose role is a toggle (Radix Checkbox → button[role=checkbox]) — the same
    // skip enforce performs via `isToggleRole(resolved.role)`.
    if (hasToggleRole(opening, sf) || (resolved !== null && isToggleRole(resolved.role))) {
      add(line, "toggle-role");
    }
    // A wrapper that renders its host an internal STATIC name is named even when
    // the call site looks empty — enforce skips it (`resolved.rendersOwnName`).
    if (resolved !== null && resolved.rendersOwnName) add(line, "renders-own-name");
  });

  return out;
}
