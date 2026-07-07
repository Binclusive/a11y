# HTML attribute nodes — present-dynamic vs absent vs static-string

This is the decision surface that matters most for a checker that reasons about
HTML attributes (`alt`, `href`, `aria-*`, …) on `.liquid` markup. An attribute
can be: absent entirely, present with a static string value, present with a
value that is a Liquid expression, present with a mixed value, or present with no
value. Each is a distinct shape. Conflating "value is dynamic" with "attribute
absent" is the bug to avoid — a dynamic value means the attribute **is** present.

## Where attributes live

Every HTML element node (`HtmlElement`, `HtmlVoidElement`,
`HtmlSelfClosingElement`, `HtmlRawNode`) has:

```typescript
node.attributes: AttributeNode[]
```

```typescript
export type AttributeNode =
  | LiquidNode        // a whole {% if %}/{{ }} sitting in the attribute list
  | AttrSingleQuoted  // attr='...'
  | AttrDoubleQuoted  // attr="..."
  | AttrUnquoted      // attr=...
  | AttrEmpty;        // attr   (no '=')
```

The four `Attr*` kinds all carry a `name` and (except `AttrEmpty`) a `value`:

```typescript
interface AttributeNodeBase<T> {
  type: T;                               // 'AttrSingleQuoted' | 'AttrDoubleQuoted' | 'AttrUnquoted'
  name:  (TextNode | LiquidVariableOutput)[];  // compound name (see node-taxonomy.md)
  value: (TextNode | LiquidNode)[];      // the concatenation of literal + Liquid pieces
  attributePosition: Position;           // range of the value, excluding quotes
  position: Position; source: string;
}

interface AttrEmpty {
  type: 'AttrEmpty';
  name: (TextNode | LiquidVariableOutput)[];   // no `value` field at all
}
```

**`value` is always an array** — the parser models an attribute value as the
concatenation of `TextNode` and Liquid nodes, because Liquid can appear anywhere
inside it. Reading the array is how you distinguish the three cases below.

## The three load-bearing cases

### 1. Attribute present, value is a Liquid expression

`alt="{{ image.alt }}"` → the attribute node exists in `attributes`, with a
`value` array whose element is a `LiquidVariableOutput`.

```typescript
// <img alt="{{ image.alt }}">
const attr = imgNode.attributes.find(/* name resolves to 'alt' */);
attr.type;            // 'AttrDoubleQuoted'
attr.value.length;    // 1
attr.value[0].type;   // 'LiquidVariableOutput'   ← dynamic, not a TextNode
attr.value[0].markup; // LiquidVariable | string  (the {{ }} body)
```

The attribute is **present**. Its value is computed at render time, so a static
checker cannot know the string — but it must not report the attribute as missing.

A **mixed** value (`href="https://{{ name }}"`) is the same idea with more
elements:

```typescript
// <a href="https://{{ name }}">
attr.value[0].type;   // 'TextNode'              → 'https://'
attr.value[1].type;   // 'LiquidVariableOutput'  → {{ name }}
```

### 2. Attribute absent

The attribute simply does not appear in `attributes` — there is no node to find.

```typescript
// <img src="...">   (no alt)
imgNode.attributes.some((a) => nameOf(a) === 'alt');  // false  → absent
```

Distinguish: **absent** = no matching node in `attributes`. **Dynamic** = a
matching node exists whose `value[0].type` is `'LiquidVariableOutput'`. These are
different and a checker must treat them differently (absent `alt` is a violation;
dynamic `alt` is present).

### 3. Attribute present, static string value

`alt="A red mug"` → node exists, `value` array holds a single `TextNode`.

```typescript
// <img alt="A red mug">
attr.type;            // 'AttrDoubleQuoted'
attr.value[0].type;   // 'TextNode'
attr.value[0].value;  // 'A red mug'   ← the literal string is known statically
```

### Adjacent case — present but valueless

`disabled` (no `=`) and `checked=""` are both "present, no value":

```typescript
// <img disabled>          → AttrEmpty, has NO `value` field
attr.type;        // 'AttrEmpty'
'value' in attr;  // false

// <img checked="">        → AttrDoubleQuoted with an empty value array
attr.type;        // 'AttrDoubleQuoted'
attr.value[0];    // undefined   (empty array)
```

## Reading the value safely

```typescript
import { NodeTypes } from '@shopify/liquid-html-parser';

type ValueShape =
  | { kind: 'absent' }
  | { kind: 'empty' }                    // present, no value (AttrEmpty or value=[])
  | { kind: 'static'; text: string }     // value is purely literal text
  | { kind: 'dynamic' };                 // value contains a Liquid node

function classifyAttr(attr: AttributeNode | undefined): ValueShape {
  if (!attr) return { kind: 'absent' };
  if (attr.type === NodeTypes.AttrEmpty) return { kind: 'empty' };
  const value = (attr as any).value as Array<{ type: string; value?: string }>;
  if (!value || value.length === 0) return { kind: 'empty' };
  const allText = value.every((v) => v.type === NodeTypes.TextNode);
  if (allText) return { kind: 'static', text: value.map((v) => v.value).join('') };
  return { kind: 'dynamic' };  // at least one LiquidVariableOutput / LiquidTag
}
```

## Attribute kinds (how the value was delimited)

| `type` | Source form | `value` field |
|---|---|---|
| `AttrDoubleQuoted` | `attr="..."` | `(TextNode \| LiquidNode)[]` |
| `AttrSingleQuoted` | `attr='...'` | `(TextNode \| LiquidNode)[]` |
| `AttrUnquoted` | `attr=...` | `(TextNode \| LiquidNode)[]` |
| `AttrEmpty` | `attr` (no `=`) | **no `value` field** |

The kind only records how the value was delimited; the `value` array shape is
the same across the three quoted/unquoted kinds. Liquid is allowed inside
single- and double-quoted values; unquoted values are literal text.

A whole Liquid tag can also sit in the attribute **list** (not as a value),
e.g. `<img {% if cond %}src="..."{% endif %}>`. There, `attributes[0]` is a
`LiquidTag` (type `'LiquidTag'`, `name: 'if'`) whose `children` hold the
`Attr*` nodes. So when scanning `attributes`, also descend into any element whose
`type` is a Liquid node type.

## Decision guide

| You see | `attributes` lookup result | Classification |
|---|---|---|
| No matching attribute node | `find` returns `undefined` | **absent** |
| `AttrEmpty`, or quoted node with empty `value` | node present, no value content | **present, valueless** |
| Node whose `value` is all `TextNode` | literal known at parse time | **present, static** |
| Node whose `value` has a `LiquidVariableOutput`/`LiquidTag` | value computed at render | **present, dynamic** |

## Rules

- "Attribute present" is decided by the existence of a node in `attributes`,
  **never** by whether its `value` is empty or dynamic.
- `value` is always an array of `TextNode | LiquidNode`; index `[0]` and check
  `.type`, do not treat it as a string.
- `AttrEmpty` has no `value` field — guard with `attr.type === 'AttrEmpty'` (or
  `'value' in attr`) before reading `value`.
- `name` is an array too (compound names like `data-{{ k }}`); normalize it the
  same way as element names (see `getName` in [traversal.md](./traversal.md)).

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Treat a dynamic value (`alt="{{ x }}"`) as a missing attribute | The node **is** present; `value[0]` is a `LiquidVariableOutput`, not absence |
| `attr.value` as a string | It is `(TextNode \| LiquidNode)[]`; you need `value[0].value` for the literal |
| Read `value` on every attribute | `AttrEmpty` has no `value` field; reading it is `undefined` and a logic bug |
| Assume `attr.value[0].type === 'TextNode'` | A quoted value can start with a `LiquidVariableOutput`; check every element |
| Skip Liquid nodes in `attributes` | `{% if %}`-wrapped attributes are `LiquidTag` entries; the real `Attr*` nodes are in their `children` |

## See also

- [node-taxonomy.md](./node-taxonomy.md) — `LiquidVariableOutput` and `TextNode` field shapes
- [traversal.md](./traversal.md) — `getName` to resolve compound attribute names; `walk`
