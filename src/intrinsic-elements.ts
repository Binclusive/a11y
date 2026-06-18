import ts from "typescript";
import { rendersStaticNameInChildren } from "./source-trace";
import { type AttrState, attrState } from "./suppressors";

/**
 * R4 element extraction (RFC `r4-content-inspection-retriever`, §3).
 *
 * R1/R2/R3 only ever see IMPORTED, capitalized JSX — `collectUsedComponents`
 * hard-filters on `CAP_NAME` and on having an import binding
 * (`resolve-components.ts`), so an intrinsic lowercase `<img>` / `<a>` never
 * produces a resolution and the slice for an all-intrinsic file is empty. That is
 * exactly where the most common real-world content failures live (a present-but-
 * bad alt, a generic link text). R4 adds the missing path: a pure walk that keeps
 * the LOWERCASE intrinsic tags and reads a COARSE content signal per element,
 * which {@link retrieveSlice}'s r4 clause maps to corpus pattern-ids via an
 * explicit `Map<tag, id[]>` table (never token overlap — that is what created the
 * F6 cross-kind leak).
 *
 * Deliberately content-COARSE: we extract the kind + the present/dynamic/missing
 * state of the content, NEVER the literal alt string or link text. The model in
 * the propose step reads the real bytes and the G0-G6 gates dispose. Keeping R4
 * content-coarse means it can never become a second, divergent content checker.
 *
 * Reuse, don't reinvent: the `visit` shape is a copy of
 * `resolve-components.ts`'s walker (minus the `CAP_NAME` filter), and every
 * content read delegates to the already-shared helpers
 * ({@link attrState} from the suppressors, and {@link rendersStaticNameInChildren}
 * from the source-tracer) — R4 duplicates no text/attr logic.
 *
 * FIRST-CUT OMISSION (deliberate): R4 reads only `alt` presence and a static
 * visible-text child. It does NOT ground aria-label-named links (the dropped
 * `nameAttrState` signal) or dynamic-child link grounding — that grounding is
 * left out of this first cut and is to be revisited only if the recall gap proves
 * to matter.
 */

const CAP_NAME = /^[A-Z]/; // capitalized JSX name = component (vs intrinsic host)

/**
 * The coarse content signal R4 reads off one intrinsic element — the two LIVE
 * signals the `retrieveSlice` r4 predicates read:
 *   - `altState` — `img` alt presence (`present` is the premise for
 *     `1.1.1-filename-or-generic-alt`);
 *   - `hasVisibleText` — `a`/`button` renders a STATIC visible name (text child /
 *     sr-only span), the premise for the `2.4.4` link-text patterns.
 */
export interface IntrinsicSignals {
  readonly altState: AttrState;
  readonly hasVisibleText: boolean;
}

/**
 * One intrinsic (lowercase) JSX element plus its coarse content signal. `tag` is
 * lowercased (`"img" | "a" | "button" | …`).
 */
export interface IntrinsicElement {
  readonly tag: string;
  readonly signals: IntrinsicSignals;
}

/**
 * Walk the JSX of `sf` and return every INTRINSIC (lowercase-tag) element with
 * its coarse content signal. Components (`CAP_NAME`) and namespace renders
 * (`NS.Member`) are skipped — R4 owns the intrinsic path; R1 owns the rest.
 *
 * Pure: same SourceFile → same array. No file read (the caller hands the parse).
 */
export function collectIntrinsicElements(sf: ts.SourceFile): IntrinsicElement[] {
  const out: IntrinsicElement[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tagName = opening.tagName;
      // Only a bare identifier whose first char is lowercase is an intrinsic host.
      if (ts.isIdentifier(tagName) && !CAP_NAME.test(tagName.text)) {
        out.push({
          tag: tagName.text.toLowerCase(),
          signals: {
            altState: attrState(opening, sf, "alt"),
            // Visible static name lives in CHILDREN, so only a non-self-closing
            // element can carry it; a self-closing intrinsic has none.
            hasVisibleText: ts.isJsxElement(node)
              ? rendersStaticNameInChildren(node)
              : false,
          },
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
