# HTML attribute & structural-absence checks

The existing HTML checks are the prior art for "this element is missing a
required attribute" / "this element has a forbidden attribute" rules. They all
follow one shape: hook an element node type, locate the relevant attribute(s)
among `node.attributes` using the attribute helpers, and report when the
structural condition (presence/absence/value) is violated. This doc captures
that shape with complete worked examples.

## The element + attribute model

An element node (`HtmlVoidElement`, `HtmlElement`, `HtmlRawNode`,
`HtmlSelfClosingElement`) carries:
- `node.name` — the tag name (string `'img'`, `'link'`, `'script'`, …; for `HtmlElement` it's a name-node array).
- `node.attributes` — an array of attribute nodes. Each is one of the *valued* types (`AttrSingleQuoted`, `AttrDoubleQuoted`, `AttrUnquoted`) or `AttrEmpty` (valueless like `disabled`).
- `node.position` — `{ start, end }` for the whole element.

Attribute names and values are themselves arrays of nodes (`TextNode` interleaved with Liquid), which is why you use helpers rather than string equality.

### Attribute helpers (`checks/utils`)

```typescript
import {
  isAttr,                 // (attr, name) -> attr's name is exactly `name`
  isValuedHtmlAttribute,  // attr is AttrSingleQuoted | AttrDoubleQuoted | AttrUnquoted
  isHtmlAttribute,        // attr is any of the above OR AttrEmpty
  valueIncludes,          // (attr, word) -> word appears in the attr's value (space-delimited)
  hasAttributeValueOf,    // (attr, value) -> attr's value is exactly `value`
  ValuedHtmlAttribute,    // the union type for a valued attribute
} from '../utils';
```

- `isValuedHtmlAttribute(attr)` narrows to a value-bearing attribute (excludes `AttrEmpty`). Use it before reading `attr.value`.
- `isAttr(attr, 'width')` checks the attribute *name* (single-text-node name equal to `'width'`).
- `valueIncludes(attr, 'stylesheet')` tests a space-separated token within the value (e.g. `rel="preload stylesheet"`).
- `hasAttributeValueOf(attr, 'module')` tests the value is exactly that string.

## Approaches

### Missing required attribute(s) — the img width/height check

**When to use:** "Element X must have attribute(s) A (and B)." This is the direct analog of an img-alt rule: same node type, same locate-then-report-on-absence shape.

**Pattern** (the complete `ImgWidthAndHeight` check):

```typescript
import { Severity, SourceCodeType, LiquidCheckDefinition } from '../../types';
import { isAttr, isValuedHtmlAttribute, ValuedHtmlAttribute } from '../utils';

export const ImgWidthAndHeight: LiquidCheckDefinition = {
  meta: {
    code: 'ImgWidthAndHeight',
    name: 'Width and height attributes on image tags',
    docs: {
      description:
        'This check is aimed at eliminating content layout shift in themes by enforcing the use of the width and height attributes on img tags.',
      recommended: true,
      url: 'https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/img-width-and-height',
    },
    type: SourceCodeType.LiquidHtml,
    severity: Severity.ERROR,
    schema: {},
    targets: [],
  },

  create(context) {
    return {
      async HtmlVoidElement(node) {
        if (node.name !== 'img') return;          // 1. filter to the element

        const widthAttr = node.attributes.find(   // 2. locate the attributes
          (attr) => isValuedHtmlAttribute(attr) && isAttr(attr, 'width'),
        ) as ValuedHtmlAttribute | undefined;

        const heightAttr = node.attributes.find(
          (attr) => isValuedHtmlAttribute(attr) && isAttr(attr, 'height'),
        ) as ValuedHtmlAttribute | undefined;

        const missingAttributes = [];             // 3. test for absence
        if (!widthAttr) missingAttributes.push('width');
        if (!heightAttr) missingAttributes.push('height');

        if (missingAttributes.length > 0) {       // 4. report
          const attributeWord = missingAttributes.length === 1 ? 'attribute' : 'attributes';
          context.report({
            message: `Missing ${missingAttributes.join(' and ')} ${attributeWord} on img tag`,
            startIndex: node.position.start,
            endIndex: node.position.end,
          });
        }
      },
    };
  },
};
```

To build an **img `alt`** rule, this is the template verbatim: keep the
`HtmlVoidElement` + `node.name === 'img'` filter, locate a single `alt`
attribute with `isAttr(attr, 'alt')`, and report when it's absent. The
structural shape — *hook element, find attribute, report on absence* — is
identical.

**Gotchas:**
- `img` is a void element, so it arrives via `HtmlVoidElement`, not `HtmlElement`. Matching against `HtmlElement` would never fire for `<img>`.
- `.find(...)` over `node.attributes` returns `undefined` when absent — that `undefined` *is* the absence signal.
- An `<img>` whose tag name is built with Liquid (e.g. `<a-{{ product.id }}>`) is not a plain `'img'` name and is correctly skipped.

### Forbidden / discouraged attribute — deprecate-bgsizes

**When to use:** "Element X must NOT use attribute A (or value V)." Report on *presence* instead of absence.

**Pattern:**

```typescript
import { isAttr, isValuedHtmlAttribute, ValuedHtmlAttribute, valueIncludes } from '../utils';

create(context) {
  return {
    async HtmlElement(node) {
      // forbidden value within an attribute: class containing "lazyload"
      const lazyloadClass: ValuedHtmlAttribute | undefined = node.attributes
        .filter(isValuedHtmlAttribute)
        .find((attr) => isAttr(attr, 'class') && valueIncludes(attr, 'lazyload'));

      if (lazyloadClass) {
        context.report({
          message: 'Use the native loading="lazy" attribute instead of lazysizes',
          startIndex: lazyloadClass.attributePosition.start,
          endIndex: lazyloadClass.attributePosition.end,
        });
      }

      // forbidden attribute outright: data-bgset
      const bgset = node.attributes.find(
        (attr) => isValuedHtmlAttribute(attr) && isAttr(attr, 'data-bgset'),
      ) as ValuedHtmlAttribute | undefined;

      if (bgset) {
        context.report({
          message: 'Use the CSS imageset attribute instead of data-bgset',
          startIndex: bgset.position.start,
          endIndex: bgset.position.end,
        });
      }
    },
  };
}
```

**Gotchas:**
- For a forbidden-value rule, narrow the highlight to the attribute (`attr.attributePosition` or `attr.position`) rather than the whole element — the user should see exactly which attribute to remove.
- `valueIncludes` is space-token-aware: it matches `lazyload` in `class="foo lazyload"` but not as a substring of another word.

### Conditional requirement — parser-blocking-script

**When to use:** "If element X has attribute A but lacks B/C, report." A presence test gated by other attribute conditions. Demonstrates `HtmlRawNode` (for `<script>`) and combining `isHtmlAttribute` (to also count `AttrEmpty` like bare `defer`/`async`) with `hasAttributeValueOf`.

**Pattern:**

```typescript
async HtmlRawNode(node) {
  if (node.name !== 'script') return;

  const hasSrc = node.attributes
    .filter(isValuedHtmlAttribute)
    .some((attr) => isAttr(attr, 'src'));
  if (!hasSrc) return;

  // async/defer can be valueless attributes -> use isHtmlAttribute (includes AttrEmpty)
  const hasDeferOrAsync = node.attributes
    .filter(isHtmlAttribute)
    .some((attr) => isAttr(attr, 'async') || isAttr(attr, 'defer'));

  const isTypeModule = node.attributes
    .filter(isValuedHtmlAttribute)
    .some((attr) =>
      isAttr(attr, 'type') &&
      (hasAttributeValueOf(attr, 'module') || hasAttributeValueOf(attr, 'importmap')),
    );

  if (hasDeferOrAsync || isTypeModule) return;   // exempt cases

  context.report({
    message: 'Avoid parser blocking scripts by adding `defer` or `async` on this tag',
    startIndex: node.position.start,
    endIndex: node.position.end,
    suggest: [scriptTagSuggestion('defer', node), scriptTagSuggestion('async', node)],
  });
}
```

**Gotchas:**
- `<script>` is a raw-content element → `HtmlRawNode`, not `HtmlElement` or `HtmlVoidElement`.
- Bare `defer`/`async` are `AttrEmpty` (no value), so filter with `isHtmlAttribute`, not `isValuedHtmlAttribute`, when you need to detect their presence.
- Because there are two equally valid fixes (`defer` vs `async`), this uses `suggest`, not `fix`.

## Decision guide

| Situation | Element hook | Helper | Report when |
|---|---|---|---|
| Required attribute on `<img>`/`<input>`/`<link>` (e.g. alt, width) | `HtmlVoidElement`, filter `node.name` | `isValuedHtmlAttribute` + `isAttr` + `.find` | the attribute is absent |
| Required attribute on a paired element `<a>…</a>` | `HtmlElement` | same | the attribute is absent |
| Required attribute on `<script>`/`<style>` | `HtmlRawNode` | same | the attribute is absent |
| Forbidden attribute / value | `HtmlElement` (or relevant) | `isAttr` / `valueIncludes` / `hasAttributeValueOf` | the attribute/value is present |
| Detecting a valueless attribute (`disabled`, `defer`) | any element | `isHtmlAttribute` (includes `AttrEmpty`) | per rule |

## Rules

- Pick the element node type by the element's HTML category: void (`<img>`, `<input>`, `<link>`) → `HtmlVoidElement`; raw (`<script>`, `<style>`) → `HtmlRawNode`; self-closing → `HtmlSelfClosingElement`; everything paired → `HtmlElement`.
- Always filter by `node.name` first, then locate attributes.
- Use `isValuedHtmlAttribute` before reading `attr.value`; use `isHtmlAttribute` when a valueless attribute counts.
- Compare attribute *names* with `isAttr`, values with `hasAttributeValueOf` / `valueIncludes` — never raw string equality on the attribute nodes.
- An absent `.find(...)` (`undefined`) is the structural-absence signal; report on it.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Matching `<img>` against `HtmlElement` | `img` is a void element → `HtmlVoidElement`; the handler never fires |
| `attr.name === 'alt'` | Attribute names are node arrays, not strings; use `isAttr(attr, 'alt')` |
| Reading `attr.value` without `isValuedHtmlAttribute` | `AttrEmpty` has no value; you'll mis-handle valueless attributes |
| Using `isValuedHtmlAttribute` to detect bare `defer`/`disabled` | Those are `AttrEmpty`; use `isHtmlAttribute` |
| Highlighting the whole element for a forbidden-attribute finding | Less actionable; point at `attr.position`/`attr.attributePosition` |

## See also

- [visitor-api.md](./visitor-api.md) — the element node-type keys and handler signature
- [reporting-offenses.md](./reporting-offenses.md) — the `context.report` call these checks end in
- [check-definition.md](./check-definition.md) — the `meta`/`create` shell around these visitors
