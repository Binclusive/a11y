/**
 * A1 — the Android layout XML parser (ADR 0006, the in-TS XML lane).
 *
 * The Android equivalent of `liquid-ast.ts`: parse `res/layout/*.xml` into a flat
 * list of view elements with their attributes and source line, so `android-xml-rules.ts`
 * can apply the structural-absence rules in-process (no JVM — that engine is the
 * SEPARATE Kotlin lane). A dependency-free tokenizer rather than a full XML library:
 * the rules only need each element's tag + attributes + line, and a layout is a flat
 * read of named views, so a small scanner is enough and keeps the producer in `src/`.
 *
 * The precision invariant carries over: a file that does not parse, or that is not an
 * Android layout (no android namespace), is reported as such and skipped — never
 * mis-flagged. One bad file must not abort a whole-project scan.
 */

/** The URI every Android layout declares (`xmlns:android="…"`). Its presence is how
 * we tell a layout apart from other XML (values, configs, the manifest) — a layout
 * is scanned, everything else stays opaque. */
const ANDROID_NS = "schemas.android.com/apk/res/android";

/** One parsed view element: its tag (the verbatim source spelling, incl. any
 * fully-qualified custom-view package), the 1-based line of its `<`, and its
 * attributes keyed by their full source name (e.g. `android:contentDescription`). */
export interface XmlElement {
  readonly tag: string;
  readonly line: number;
  readonly attrs: ReadonlyMap<string, string>;
}

/** Parse outcome: the element list + whether the file is an Android layout, or a
 * single boundary error (mirrors `parseLiquid`'s `ok`/`error` shape). */
export type AndroidXmlParseResult =
  | { readonly ok: true; readonly elements: readonly XmlElement[]; readonly isLayout: boolean }
  | { readonly ok: false; readonly error: { readonly message: string } };

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/**
 * Tokenize `source` into its view elements. Skips comments, the XML declaration,
 * DOCTYPE, CDATA, and end tags; captures every start / self-closing tag. A
 * structurally broken file (unterminated tag, comment, or quoted value) returns
 * `{ ok: false }` so the collector can record-and-skip it.
 */
export function parseAndroidXml(source: string): AndroidXmlParseResult {
  const elements: XmlElement[] = [];
  const n = source.length;

  const lineAt = (offset: number): number => {
    let line = 1;
    const stop = Math.min(offset, n);
    for (let k = 0; k < stop; k++) if (source.charCodeAt(k) === 10 /* \n */) line++;
    return line;
  };

  let i = 0;
  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt === -1) break;

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) return { ok: false, error: { message: "unterminated comment" } };
      i = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end === -1) return { ok: false, error: { message: "unterminated CDATA section" } };
      i = end + 3;
      continue;
    }
    const lead = source[lt + 1];
    if (lead === "?" || lead === "!") {
      const end = source.indexOf(">", lt + 1);
      if (end === -1) return { ok: false, error: { message: "unterminated declaration" } };
      i = end + 1;
      continue;
    }
    if (lead === "/") {
      const end = source.indexOf(">", lt + 1);
      if (end === -1) return { ok: false, error: { message: "unterminated end tag" } };
      i = end + 1;
      continue;
    }

    // A start (or self-closing) tag: read the tag name, then the attributes.
    let j = lt + 1;
    const nameStart = j;
    while (j < n && !isSpace(source[j]!) && source[j] !== ">" && source[j] !== "/") j++;
    const tag = source.slice(nameStart, j);

    const attrs = new Map<string, string>();
    let closed = false;
    while (j < n) {
      while (j < n && isSpace(source[j]!)) j++;
      if (j >= n) return { ok: false, error: { message: "unterminated start tag" } };
      const ch = source[j]!;
      if (ch === ">") {
        j++;
        closed = true;
        break;
      }
      if (ch === "/") {
        const gt = source.indexOf(">", j);
        if (gt === -1) return { ok: false, error: { message: "unterminated self-closing tag" } };
        j = gt + 1;
        closed = true;
        break;
      }
      // Attribute name.
      const anStart = j;
      while (j < n && !isSpace(source[j]!) && source[j] !== "=" && source[j] !== ">" && source[j] !== "/")
        j++;
      const aname = source.slice(anStart, j);
      while (j < n && isSpace(source[j]!)) j++;
      if (source[j] === "=") {
        j++;
        while (j < n && isSpace(source[j]!)) j++;
        const q = source[j];
        if (q === '"' || q === "'") {
          const close = source.indexOf(q, j + 1);
          if (close === -1) return { ok: false, error: { message: "unterminated attribute value" } };
          if (aname !== "") attrs.set(aname, source.slice(j + 1, close));
          j = close + 1;
        } else {
          // Unquoted value — rare in Android XML, but read it rather than choke.
          const vStart = j;
          while (j < n && !isSpace(source[j]!) && source[j] !== ">" && source[j] !== "/") j++;
          if (aname !== "") attrs.set(aname, source.slice(vStart, j));
        }
      } else if (aname !== "") {
        // A valueless attribute — keep it as present-but-empty.
        attrs.set(aname, "");
      }
    }
    if (!closed) return { ok: false, error: { message: "unterminated start tag" } };

    elements.push({ tag, line: lineAt(lt), attrs });
    i = j;
  }

  return { ok: true, elements, isLayout: source.includes(ANDROID_NS) };
}
