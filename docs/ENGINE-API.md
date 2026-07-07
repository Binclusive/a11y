# Engine API — the library surface

The design contract for splitting a11y-checker into an **engine library** (framework-
agnostic functions) and **thin CLIs** over it. `@binclusive/cli` (`b8e`) — and any
future lean shim — call *this* surface; they never reach into internals, and they
own their own arg-parsing + presentation.

> **Status:** spec. The engine is already ~90% library-shaped (see `src/index.ts`).
> The work is *curation* — drawing the boundary below — not a rewrite.

---

## Principle

```
@b8e/a11y-checker   = the engine (this surface)   ← private, bundled into the CLI
        │
        └── @binclusive/cli (b8e)   arg-parse (its framework) + presentation, over the engine
```

The engine returns **data** (`ScanResult`, `EnrichedFinding`, `DisplayContract`).
A CLI **renders** it. Two CLIs can render the same data differently; neither
duplicates engine logic. The current `@effect/cli` layer in `src/cli.ts` is one
such renderer — b8e re-expresses the commands in its own framework over the same
functions.

---

## The boundary — three tiers

| Tier | What | Exported? |
|---|---|---|
| **1 · Engine API** | the high-level functions a CLI calls | ✅ the engine's public entry |
| **2 · Types** | the data shapes Tier 1 returns/accepts | ✅ (consumers need them) |
| **3 · Internal** | resolvers, tracers, registry, distill | ❌ implementation, not contract |

`src/index.ts` today re-exports much of Tier 3 (kitchen-sink barrel). The migration
curates it to Tiers 1–2; Tier 3 becomes deep-import-only (tests, internal).

---

## Tier 1 — the surface (organized by cluster)

### 1. Scan & enrich — the read path

```ts
collectTsx(dir: string): Promise<string[]>                 // find .tsx under dir
scan(filePaths: readonly string[]): Promise<ScanResult>    // full scan: findings + coverage + resolution
checkFiles(filePaths: readonly string[]): Promise<Finding[]>   // findings only (no coverage/resolve)
scanUrl(url: string, opts?: DomScanOptions): Promise<DomScanResult>   // rendered DOM + axe-core
scanSwift(dir: string): Promise<SwiftScanResult>           // iOS / SwiftUI source pass

enrich(f: Finding): EnrichedFinding                        // attach corpus weight + fix
enrichAll(fs: readonly Finding[]): EnrichedFinding[]
resolveDisplay(f: EnrichedFinding): DisplayContract        // what to SHOW (rule · wcag · corpus · fix)
```

**Types:** `Finding`, `ScanResult`, `Coverage`, `EnrichedFinding`, `DisplayContract`,
`DomScanResult`, `DomScanOptions`, `SwiftScanResult`, `FindingProvenance`, `EnforcementLevel`.

### 2. Contract lifecycle — init / config

```ts
init(dir: string, opts?: InitOptions): Promise<InitResult>     // detect stack, write binclusive.json + AGENTS/CLAUDE
learn(dir: string, input: LearnInput): Promise<LearnResult>    // append a team rule
gen(dir: string, check: boolean): Promise<GenResult>           // regenerate (or --check) the managed block
loadContract(dir: string): Promise<Contract | null>
findContractFrom(dir: string): Contract | null                 // walk up for binclusive.json
contractForFiles(filePaths: readonly string[]): Contract | null
suggestComponentMap(/* … */): SuggestResult                    // the --suggest scaffolder
detectStack(dir: string, tsxFiles: readonly string[]): Stack
parseContract(raw: unknown): Contract                          // boundary-parse (fails loud)
serializeContract(c: Contract): string
enforcementFor(/* … */): EnforcementLevel
fileIgnoreMatcher(ignore): (filePath: string) => boolean
ignoredRuleIds(ignore): ReadonlySet<string>
```

**Types:** `Contract`, `Stack`, `Enforcement`, `Declarations`, `LearnedRule`, `Router`,
`Language`, `CONTRACT_VERSION`, `InitOptions`, `InitResult`, `LearnInput`, `LearnResult`,
`GenResult`, `DriftEntry`, `SuggestResult`, `SuggestOptions`, `ComponentSuggestion`,
`SuggestConfidence`. Constants: `CONTRACT_FILE`, `BLOCK_TARGETS`.

### 3. Agent integration — the plugin's engine

```ts
runHook(raw: unknown): Promise<HookOutput | null>          // PostToolUse auto-whisper (stdin event → additionalContext)
buildServer(): McpServer                                   // the MCP server, tools registered
startStdioServer(): Promise<void>                          // run it over stdio

// MCP tool implementations — also directly callable (agents, tests, the lean shim):
checkA11y(dir: string): Promise<CheckA11yResult>
checkUrl(url: string): Promise<CheckUrlResult>
getA11yRules(filter): GetA11yRulesResult
learnA11yRule(input): Promise<LearnA11yRuleResult>
```

**Types:** `HookOutput`, `CheckFinding`, `CheckA11yResult`, `CheckUrlResult`,
`GetA11yRulesResult`, `LearnA11yRuleResult`.

### 4. Corpus — the moat, read-only

```ts
corpusCriteria(): readonly CorpusCriterion[]               // the SCs the corpus covers
corpusPatterns(): readonly CorpusPattern[]                 // distilled patterns, most-frequent first
baselineRules(filter): readonly BaselineRuleInfo[]
corpusTier(c) / corpusFix(c) / corpusSeverity(f) / corpusHelpUrl(f) / corpusBestPractice(c)
renderBlock(contract: Contract, patterns: readonly CorpusPattern[]): string   // the AGENTS.md/CLAUDE.md block
spliceBlock(existing, block) / extractBlock(content)       // managed-block surgery
```

**Types:** `CorpusCriterion`, `CorpusPattern`, `CorpusEvidence`, `CorpusTier`,
`Severity`, `BaselineRuleInfo`, `DistilledPatternRef`. Constants: `BLOCK_BEGIN`, `BLOCK_END`.

---

## Tier 3 — stays internal (NOT in the engine entry)

How the engine works, not its contract — keep as deep-import-only:

`resolve-components` · `source-trace` · `imports-resolve` · `tsconfig-aliases` ·
`workspace-resolve` · `module-scope` · `registry` · `suppression-ranges` ·
`enforce` (`enforceContent` is internal to `scan`) · `detect-stack` internals
(`detectDesignSystem`, `detectFrameworkFromDeps`) · `distill/*` (a build-time
corpus tool, not runtime) · `collect` internals.

> These are exported by `index.ts` today only because it's an everything-barrel.
> They are not part of the surface a CLI should bind to.

---

## CLI-only — what b8e re-implements (NOT engine)

These live in the CLI layer (`src/cli.ts` today) and are **presentation**, not logic:

- arg parsing (`@effect/cli` here; b8e uses its own)
- `detailLines(f)`, `formatOpaqueHint(r)` — terminal finding/coverage formatting
- `buildJsonReport(...)` — the `--json` shape (arguably promote to engine if b8e wants the same JSON; keep CLI-side until a second consumer needs it)
- color, the coverage-report layout, exit-code policy

The engine hands back `ScanResult` / `EnrichedFinding` / `DisplayContract`; each
CLI renders to taste.

---

## Command → engine map

| b8e command | engine call |
|---|---|
| `b8e check <dir> [--json]` | `collectTsx` → `scan` → `enrichAll` → render |
| `b8e check-url <target>` | `scanUrl` → `enrich` → render |
| `b8e init [--suggest] [dir]` | `init(dir, { suggest })` |
| `b8e learn <rule> [flags]` | `learn(dir, input)` |
| `b8e gen [--check]` | `gen(dir, check)` |
| `b8e mcp` | `startStdioServer()` |
| `b8e hook` | `runHook(<stdin JSON>)` |
| `b8e check-swift <dir>` | `scanSwift(dir)` |
| `b8e check-shopify <dir>` | `scanLiquid(dir)` |
| `b8e check-unity <dir>` | `collectUnityFindings(dir)` |
| `b8e check-android <dir>` | `scanAndroidXml(dir)` |

---

## The offline invariant (the wedge, in code)

Every Tier-1 function is **local and zero-account**. `scanUrl`/`checkUrl` drive a
**local headless Chromium** (Playwright) against the given URL — local, no platform
login, just a render. **None require auth.**

The platform layer — `login` / `audit` / `tickets`, talking to `audit-agents` — is
**not in this engine.** It's b8e's cloud module. The line between *engine* and *cloud*
is exactly the line between *works offline* and *needs login*. Keep it that sharp:
no engine function may import the auth/GraphQL layer.

---

## Packaging (how it publishes)

- **Engine** = `@b8e/a11y-checker`, `private: true`. Its entry exports **only Tiers 1–2**.
- **`@binclusive/cli` (b8e)** depends on it (`workspace:*`) and **bundles it into `dist/`**
  (esbuild/tsup), so the published tarball carries no workspace dep — matching the
  existing "only the built `dist/` ships" release pattern.
- **Changesets** versions `@binclusive/cli` (the one published package). The engine
  stays `0.0.0`/unpublished.
- The **Claude Code plugin**'s `.mcp.json` / `hooks.json` point at `npx @binclusive/cli mcp`
  / `b8e hook`.

No `@b8e` vs `@binclusive` naming question, no second release line: **one published
package, engine private + bundled.**
