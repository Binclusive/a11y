# TERMS — domain vocabulary

The repo-owned register of the **canonical nouns** of the a11y-checker: the
products, entities, rules, and infra terms a contributor or a CI-spawned agent
must share to read the code the same way. It exists to stop *one-concept-named-
many-ways* drift across the agent fleet.

**The code is authoritative.** Every term is derived from what the code does
(exported types, identifiers, string-literal values, ADR titles). When this file
and the code disagree, the code wins and this file is the doc to fix. Conventions
live in `CLAUDE.md` / `.patterns/`; architecture-decision rationale lives in
`.decisions/`. This file is **terms-only**.

> `.glossary/LANGUAGE.md` (the architecture-vocabulary file — module / interface /
> depth / seam / adapter / leverage / locality) is **deferred** for this first
> pass. Per the `glossary` skill contract it is near-frozen and not skill-
> maintained; seed it separately if/when the team adopts that vocabulary.

---

## Core / shape

| Term | Definition | Not |
|------|------------|-----|
| **Finding** | A single accessibility issue. Carries `file`, `line`, `ruleId`, `message`, `wcag` tags, `enforcement`, `provenance`, and optional `layer` / `patternId` / `selector` / `severity` / `helpUrl`. The one shape every collector emits. | Not per-ecosystem; one shape for all sources (ADR 0001). |
| **FindingProvenance** | Where a finding came from: `"jsx-a11y"` \| `"enforce"` \| `"axe"` \| `"swiftui"` \| `"liquid"` \| `"unity"` \| `"corpus-agent"`. Defined in `src/core.ts`. | Not "source"/"origin" — use `provenance`. |
| **Layer (floor / recall)** | Which precision tier a finding belongs to. `floor` = the deterministic static floor (jsx-a11y / enforce / axe / swiftui / liquid / unity); it gates the CLI exit code. `recall` = the advisory corpus-agent layer, quarantined into a separate field, never exit-code-affecting (ADR 0003). | Floor findings carry no `layer` (defaults to floor); only recall tags it. |
| **ScanResult** | The output of `scan()`: `findings`, `coverage`, `resolved`, `contract`, and the quarantined `recall` array. | `recall` is empty from `scan()`; only the server-side review layer populates it. |
| **EnforcementLevel** | A finding's policy: `"block"` \| `"warn"` (`src/config-scan.ts`). Drives CLI exit behavior. | Not "severity" — severity is the impact rank (minor/moderate/serious/critical). Not an "off" level — suppressing a rule is a separate concept: rule-ignore via `Declarations.ignore` (`src/contract.ts`), not an enforcement level. |
| **Contract** | The `binclusive.json` config that drives enforcement and declarations: `version`, `stack`, `enforcement`, `learned`, `declarations`. | The config file is `binclusive.json`. |
| **Declarations** | Customer escape-hatch overrides inside the Contract: `components` (manual host map), `injectsChildren`, `ignore` globs. | Not the resolver's automatic output — these are author-supplied. |
| **Stack** | The detected React repo shape: `framework`, `router` (`app`/`pages`), `designSystem`, `language` (`ts`/`js`). Inferred by `detect-stack`. | Not "ecosystem" — Stack is React-repo-specific. |

## Collector / producer architecture

| Term | Definition | Not |
|------|------------|-----|
| **Collector** | An ecosystem-specific producer of `Finding`s emitting the one common shape. The seven: jsx-a11y lint + enforce (React/TSX), axe (rendered DOM), swiftui (Swift), liquid (Shopify), unity (Unity), corpus-agent (stochastic recall). Files: `src/collect-*.ts`. | "Collector" and "producer" are used interchangeably; prefer **collector** for the `collect-*` modules. |
| **Flat command table** | Collectors are dispatched as a plain table of sync/async functions, not an extensible plugin registry — each collector is a known producer (ADR 0002). | Not a "collector registry" — that name is reserved and rejected by ADR 0002. |
| **collect-dom** | The axe-core collector: renders live DOM and runs axe (`src/collect-dom.ts`, command `check-url`). For non-React / source-less pages. | |
| **collect-liquid** | The Shopify/Liquid collector: parses `.liquid` and runs structural-absence rules (`src/collect-liquid.ts`, command `check-shopify`). | |
| **collect-swift** | The SwiftUI collector: spawns the external `A11ySwiftScan` binary, reads JSON findings from stdout (`src/collect-swift.ts`, command `check-swift`). | An out-of-process producer (ADR 0004 pattern), not an in-process parser. |
| **collect-unity** | The Unity collector: parses Force-Text `.prefab`/`.unity` scenes and runs the Unity rules (`src/collect-unity.ts`). No dedicated CLI subcommand yet — invoked via the collector path. | |

## Resolver

| Term | Definition | Not |
|------|------------|-----|
| **Resolver** | The component-to-host-element mapper: takes JSX usages, traces imports, consults the registry, applies declarations, and emits `ComponentResolution`s with provenance. Files: `src/source-trace.ts`, `src/resolve-components.ts`, `src/registry.ts`. | |
| **Host element** | The actual HTML/ARIA primitive a component renders (`button`, `a`, `input`, `div`, …) — what jsx-a11y rules must run against. Canonical list in `src/registry.ts`. | Not "tag"/"element type" — use **host** / **host element**. |
| **Opaque** | A component the resolver could not (or chose not to) map to a host. `OpaqueKind`: `"trusted"` \| `"icons"` \| `"structural"` \| `"declare"`. Opaque is always safe. | The safe outcome, never an error. |
| **Precision invariant** | The resolver must map to the **correct** host **or stay opaque** — never the **wrong** host. A wrong host runs the wrong jsx-a11y rules and produces false positives (the failure that uninstalls the tool). Guarded by `test/source-trace.pbt.test.ts`. | "opaque vs wrong-host" — opaque is safe, wrong-host is the bug. |
| **Provenance (resolution)** | How a component's host was determined: `"declared"` \| `"registry"` \| `"trace"` \| `"opaque"`. `ResolvedProvenance` excludes `"opaque"`. | Distinct from `FindingProvenance` (which collector emitted a finding). |
| **Registry** | The built-in map of known component/host pairs the resolver consults (`src/registry.ts`). | Not the Unity GUID registry — that is a separate built-in-widget map. |
| **ComponentResolution** | One resolved wrapper: `name`, `module`, `imported`, `host`, `provenance`, `role`, `rendersOwnName`. | |
| **Coverage** | Resolution statistics buckets: `total`, `declared`, `registry`, `traced`, `opaque`, `trusted`, `icons`, `structural`, `declare`. | |

## Enforce / suppression

| Term | Definition | Not |
|------|------------|-----|
| **Enforce** | The corpus-driven content-family static pass over the resolved component map (`src/enforce.ts`): checks for missing accessible names/labels (button-has-name, img-alt, heading-has-content, …). One of the two React passes alongside jsx-a11y. | Not jsx-a11y — enforce is the content pass; jsx-a11y is the lint pass. |
| **Suppressor** | A module that detects where a content-family finding would be a false positive — runtime child injection (Trans-like) and `aria-hidden` subtrees — and returns line ranges to skip. Files: `src/suppressors.ts`, `src/suppression-ranges.ts`, `src/suppressor-map.ts`. | |
| **SuppressionRange** | A line span in a file where a jsx-a11y content-family finding is suppressed as a known false positive. | |
| **AttrState** | How an attribute's value resolves statically: `"missing"` \| `"present"` \| `"dynamic"`. | The React analog of the Liquid `AttrValue` seam. |

## React / TSX

| Term | Definition | Not |
|------|------------|-----|
| **check** | The CLI command that scans `.tsx` for a11y findings (jsx-a11y lint + enforce pass). The default React path. `--json` for machine-readable output. | The command is `check`, not `check-react`. |
| **jsx-a11y** | The ESLint plugin lint pass over `.tsx` (provenance `"jsx-a11y"`); the rule-based half of the React check. | |
| **collectTsx** | Recursively collects `.tsx` files, skipping `node_modules`, `.next`, `.turbo`, generated/test dirs and `*.test/spec/stories.tsx`. | |

## Liquid / Shopify

| Term | Definition | Not |
|------|------------|-----|
| **check-shopify** | The CLI command that scans `.liquid` Shopify theme source for structural a11y findings (static, no browser). | |
| **Liquid AST** | The `@shopify/liquid-html-parser` output: a walkable graph of HTML element nodes and `{{ }}` Liquid expressions. Wrapper in `src/liquid-ast.ts`. | |
| **Structural-absence rule** | A static rule over the Liquid AST that fires on a **missing** accessible name/attribute (alt, aria-label, …) on an HTML element. The L2 Liquid rule family (`src/liquid-rules.ts`). | Fires on absence, never on present-but-unknown. |
| **AttrValue (static/dynamic/absent seam)** | The Liquid attribute precision seam: `{kind:"absent"}` \| `{kind:"empty"}` \| `{kind:"static",text}` \| `{kind:"dynamic"}`. **Dynamic** (present-but-unknown) must never be flagged as missing; only **absent** (and per-rule **empty**) fires. | The Liquid expression of the precision invariant. |

## Swift / SwiftUI

| Term | Definition | Not |
|------|------------|-----|
| **check-swift** | The CLI command that scans `.swift` for SwiftUI accessibility findings (static, provenance `"swiftui"`). | |
| **A11ySwiftScan** | The external SwiftPM binary (SwiftSyntax-based rules) that `collect-swift` spawns; it emits JSON findings on stdout. The external-static-analyzer pattern (ADR 0004). | An out-of-process analyzer, not an in-editor extension. |
| **SwiftRuleId** | The static rule IDs the Swift engine emits: `"swiftui/image-no-label"` \| `"swiftui/control-no-name"`. | |

## Unity

| Term | Definition | Not |
|------|------------|-----|
| **Force-Text serialization** | Unity's YAML 1.1 text format for scenes (`.prefab`, `.unity`) — the precondition for static analysis. Binary-serialized assets are opaque by construction. | Asset Serialization = Force Text; binary scenes are unreadable. |
| **Unity AST** | The parsed Force-Text graph: GameObjects, components, the `m_Children` transform hierarchy, `m_Script` GUID (identity), and `m_text` static labels (`src/unity-ast.ts`). | |
| **Built-in-widget GUID registry** | The hardcoded map (`src/unity-guid-registry.ts`, const `UNITY_BUILTIN_GUIDS`) from a stable Unity engine GUID (lowercase 32-hex) to a `UnityWidgetKind` and its accessibility `host`. The Unity analog of the component registry. | Distinct from the resolver's component `registry`. |
| **UnityWidgetKind** | The uGUI control kinds the registry tracks: `"Button"` \| `"Image"` \| `"RawImage"` \| `"TextMeshProUGUI"` \| `"Text"` \| `"Toggle"`. | |
| **UnityBuiltinWidget** | One registry row: `guid`, `widget` (UnityWidgetKind), `host`. | |
| **AccessibilityHierarchy** | The `m_Children` transform graph in a Force-Text scene — the parent-child traversal needed to resolve a control's label from its descendant Text (`src/unity-label-resolve.ts`). | |
| **Static/dynamic/absent label seam** | The Unity label precision seam: a control's child Text can carry a **static** literal `m_text`, be **dynamic** (a `LocalizeStringEvent`, value unknown), or be **absent**. Only **absent** fires a missing-label finding (`src/unity-label-resolve.ts`). | The Unity expression of the precision invariant; mirrors the Liquid `AttrValue` seam. |
| **LocalizeStringEvent** | A uGUI component marking a Text field as localized (value resolved at runtime) — the **dynamic** case of the label seam; the label resolver must not treat it as absent. | |
| **Selectable** | The base uGUI interactive widget (Button, Toggle, Slider, …) that serializes `m_Transition` — the enum controlling interactive feedback (None / ColorTint / SpriteSwap / Animation). | |
| **ColorTint** | The `Selectable.m_Transition` value meaning feedback is conveyed by color alone. The color-only rule (`src/unity-rule-color-only.ts`) flags ColorTint-only feedback as inaccessible to color-blind users. | |
| **Prefab** | A reusable GameObject template, serialized as a `.prefab` Force-Text file; a scan target. | |

## WCAG bridge

| Term | Definition | Not |
|------|------------|-----|
| **Success Criterion (SC)** | A WCAG rule reference (e.g. `1.1.1`, `1.3.1`, `4.1.2`). The cross-collector key: findings from any provenance are enriched and reranked by SC, not by rule-id (ADR 0001). | |
| **WCAG SC bridge** | `src/wcag-map.ts` maps rule IDs → SCs; `src/wcag-tags.ts` (`scFromTags`) normalizes axe-core `wcagNNN` tags → dotted SCs. Together they let every collector's findings enrich through the same corpus gate. | |

## Corpus / matrix regression gate

| Term | Definition | Not |
|------|------------|-----|
| **Corpus** | The real-world audit data (frequency, false-positive rates, WCAG mapping) used to rank findings by impact and to drive the corpus-agent recall layer. | |
| **Matrix gate** | The corpus regression gate: re-scan SHA-pinned real repos and diff against `baseline.json`; exit non-zero on any delta. Per-ecosystem: **stack-matrix** (31 React repos), **shopify-matrix** (Liquid themes), **unity-matrix** (Unity projects). | A delta is not automatically a bug — it is read in review. |
| **baseline.json** | The committed snapshot of expected findings per corpus repo; re-blessed (`matrix:baseline`) only for an intentional change, in the same PR as the code. | Never re-blessed to silence an un-understood delta. |
| **matrix:\* scripts** | `matrix:discover`, `matrix:run`, `matrix:report`, `matrix:baseline`, `matrix:check` (package.json) — the corpus pipeline; `matrix:check` is the gate. | |

## CLI / commands

| Term | Definition | Not |
|------|------------|-----|
| **a11y-checker** | The CLI root (Effect CLI, `src/cli.ts`). Subcommands: `check`, `check-url`, `check-swift`, `check-shopify`, `init`, `learn`, `gen`, `mcp`, `hook`. | |
| **init** | Scaffold `binclusive.json` from the `detect-stack` result. | |
| **learn** | Record a `LearnedRule` in `binclusive.json` (a fixable finding + wcag tags + source module). | |
| **gen** | Generate `baseline.json` from current check results. | |
| **detect-stack** | Infer the `Stack` (framework, router, designSystem, language) from `package.json` and on-disk layout (`src/detect-stack.ts`). | |
| **mcp / hook** | The MCP-server entrypoint (`src/mcp.ts`) and the git-hook entrypoint (`src/hook.ts`). | |

## Architecture decisions (ADRs)

| Term | Definition | Not |
|------|------------|-----|
| **ADR 0001 — Rendered-DOM adapter via a shared rules core** | Multiple collectors feed one shared rules/WCAG-mapping core so findings from any source enrich through the same SC-keyed gate. [`../.decisions/0001-rendered-dom-adapter.md`](../.decisions/0001-rendered-dom-adapter.md) | |
| **ADR 0002 — A flat command table, not a collector registry** | Collectors dispatch as a plain function table; no extensible plugin registry. [`../.decisions/0002-collector-abstraction.md`](../.decisions/0002-collector-abstraction.md) | |
| **ADR 0003 — A deterministic shell around every stochastic capability** | The CLI and static floor are deterministic; stochastic recall is walled into the `recall` field and never gates the CLI. [`../.decisions/0003-deterministic-shell-stochastic-core.md`](../.decisions/0003-deterministic-shell-stochastic-core.md) | |
| **ADR 0004 — Unity a11y: external static analyzer over an in-editor extension** | Unity analysis runs as an external binary over Force-Text scenes (CI/CD-friendly), not an in-editor plugin; keeps the Force-Text + GUID→`.meta` precision constraints. [`../.decisions/0004-unity-external-static-analyzer.md`](../.decisions/0004-unity-external-static-analyzer.md) | |
| **ADR 0005 — Unity-first as the wedge for the game a11y checker** | Start game a11y with Unity (the dominant engine) to prove the external-analyzer pattern before other engines. [`../.decisions/0005-unity-first-game-a11y-scope.md`](../.decisions/0005-unity-first-game-a11y-scope.md) | |
