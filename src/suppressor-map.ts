import ts from "typescript";
import {
  isHiddenOrUntabbable,
  isLabelContainer,
  isNameExemptInputType,
  isNameInjectingWrapper,
} from "./suppressors";

/**
 * The deterministic G3 input (RFC Phase 1, §"The FP discipline").
 *
 * `buildSuppressorMap` runs the SAME ancestor walk `enforceContent` runs — the
 * `labelDepth` / `nameAncestorDepth` tree descent that decides `hasLabelAncestor`
 * / `hasNameAncestor` — and records, per JSX line, WHICH of the static floor's
 * suppressor predicates ({@link src/suppressors}) apply there. The map is the
 * floor's hard-won precision, re-expressed as data the corpus-recall layer can
 * (a) feed the model so it self-suppresses and (b) enforce server-side so a
 * grounded-but-misclassified finding on a suppressed line is vetoed.
 *
 * It REUSES the suppressor predicates verbatim — it never re-implements them —
 * so any drift in the floor's suppression logic ripples here automatically. It
 * emits no findings and has no side effects: a pure `source → line → names` read.
 */

/** The suppressor predicates, named. The string IS the wire name fed to G3. */
export type SuppressorName =
  | "label-ancestor"
  | "name-injecting-wrapper"
  | "hidden-untabbable"
  | "name-exempt-input-type"
  | "toggle-role";

/**
 * A per-line view of which suppressors apply. Keyed by 1-based line number (the
 * same line a finding anchors to — an element's opening-tag line). The value is
 * the set of suppressor names live AT that line:
 *
 *   - `label-ancestor` / `name-injecting-wrapper` are ANCESTOR suppressors — a
 *     line carries them when an enclosing `<label>` / form-field grouping
 *     (`isLabelContainer`) or a titled `<Tooltip>` (`isNameInjectingWrapper`) is
 *     an ancestor of the element on that line. They mirror the `labelDepth` /
 *     `nameAncestorDepth` the enforce walk threads down the tree.
 *   - `hidden-untabbable` / `name-exempt-input-type` / `toggle-role` are
 *     ELEMENT-LOCAL — the predicate holds for the element opening ON that line.
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
 * registry host whose `role` is a toggle; here we read the role straight off the
 * call-site JSX so the map captures the call-site-visible toggle case too. A
 * dynamic `role={x}` is not asserted (uncertain → not a suppressor we can name).
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

/**
 * Build the per-line suppressor map for one source file. Mirrors the
 * `enforceContent` ancestor walk: a `labelDepth` / `nameAncestorDepth` counter is
 * pushed/popped as a label / name-injecting container is entered/left, so every
 * descendant line learns it is under one. Element-local predicates are read off
 * each opening directly.
 */
export function buildSuppressorMap(sf: ts.SourceFile): SuppressorMap {
  const out = new Map<number, Set<SuppressorName>>();

  const add = (line: number, name: SuppressorName): void => {
    let set = out.get(line);
    if (set === undefined) {
      set = new Set<SuppressorName>();
      out.set(line, set);
    }
    set.add(name);
  };

  let labelDepth = 0;
  let nameAncestorDepth = 0;

  const visit = (node: ts.Node): void => {
    let enteredLabel = false;
    let enteredNameAncestor = false;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (isLabelContainer(opening, sf)) {
        labelDepth++;
        enteredLabel = true;
      }
      if (isNameInjectingWrapper(opening, sf)) {
        nameAncestorDepth++;
        enteredNameAncestor = true;
      }
      const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1;
      // Ancestor suppressors: live if an ENCLOSING container set the depth. The
      // element that opens the container itself does NOT count as its own
      // ancestor — only its descendants — so subtract the entry just made.
      if (labelDepth - (enteredLabel ? 1 : 0) > 0) add(line, "label-ancestor");
      if (nameAncestorDepth - (enteredNameAncestor ? 1 : 0) > 0) add(line, "name-injecting-wrapper");
      // Element-local suppressors read straight off the opening.
      if (isHiddenOrUntabbable(opening, sf)) add(line, "hidden-untabbable");
      // `type`-exemption is only meaningful for native form controls; an exempt
      // `type` on a non-input is degenerate, so gate it to the three intrinsics
      // (and capitalized components, which may forward `type` to an input host).
      const tag = intrinsicTag(opening);
      const isFormIntrinsic = tag === "input" || tag === "select" || tag === "textarea";
      if ((isFormIntrinsic || tag === null) && isNameExemptInputType(opening, sf)) {
        add(line, "name-exempt-input-type");
      }
      if (hasToggleRole(opening, sf)) add(line, "toggle-role");
    }
    ts.forEachChild(node, visit);
    if (enteredLabel) labelDepth--;
    if (enteredNameAncestor) nameAncestorDepth--;
  };
  visit(sf);

  return out;
}
