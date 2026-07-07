# Grill me — the questions a sharp engineer asks

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md). That doc explains *how it
works*; this one is the **interrogation**: the questions a skeptical senior
engineer throws at the parsing / file-handling / data-flow, paired with the
crisp, code-grounded answer. Read it once and nobody brain-washes you again.

Every answer cites `file:line` so you can pull it up live.

---

## 0. The 60-second recall card

If someone asks "how do you handle parsing and files," say this:

> **Discovery** is a hand-rolled recursive `readdir` walk — no glob library —
> that collects only `.tsx`. **Parsing** is the TypeScript compiler API
> (`ts.createSourceFile`, TSX mode) — a real AST, never regex, never Babel.
> **Resolution** is a three-tier waterfall: TS's own `resolveModuleName` →
> monorepo workspace packages → Node `#imports`, with tsconfig `paths` aliases
> handled separately. **Tracing** follows a JSX element back to its component
> definition up to depth 3, deciding if a wrapper is "thin enough" to map to a
> single HTML host. It's all plain Node `fs` + `typescript` — **Effect is only
> the CLI parser**, it touches none of the scanning logic.

The three moves: **discover → parse → resolve/trace.** Everything else is detail.

---

## 1. Parsing & file handling

**Q: Where's your glob library?**
There isn't one. `collectTsx(dir)` (`collect.ts:41`) is a recursive
`readdir({withFileTypes:true})` walk (`collect.ts:43`). Skips a hardcoded
`SKIP_DIRS` set (`node_modules`, `.next`, `.turbo`, `__generated__`, `dist`,
`__tests__`, `__mocks__`) via `Set.has` (`collect.ts:47`), drops
`*.{test,spec,stories}.tsx` by filename regex (`collect.ts:33`). **No
fast-glob, minimatch, or anything.**

**Q: So you only see `.tsx`? What about a `.ts` file with JSX, or `.jsx`?**
Scanning only `.tsx` is **correct, not a gap** — and this trips people up.
**TypeScript forbids JSX in `.ts` files**: `<div>` there parses as a type
assertion/generic and errors. `jsx: preserve` controls *output*, not which
extension may hold JSX. So "a `.ts` file with JSX" can't exist — nothing is
missed. We scan exactly where TS JSX is allowed to live (`collect.ts:49`,
`ScriptKind.TSX` throughout). The lint pass agrees: `files: ["**/*.tsx"]`
(`core.ts:137`). The **one real** out-of-scope case is `.js`/`.jsx` — plain-JS
(Babel) React with no TypeScript. That's deliberate, not lazy: the whole engine
is the TS compiler API + **type-aware** component tracing (resolving `<Button>`
→ `button` through imports and types). Plain JS has no types to trace, so it's
foundationally out of scope. Strong answer — don't apologize for it.

**Q: What actually parses the source — TSC, the ESLint parser, Babel, regex?**
The **TypeScript compiler API, exclusively.**
`ts.createSourceFile(path, text, ScriptTarget.Latest, true, ScriptKind.TSX)` at
`source-trace.ts:143` and `resolve-components.ts:218`. Suppression analysis walks
the same AST with `ts.isJsxElement` / `ts.isJsxSelfClosingElement`
(`suppression-ranges.ts:171`). tsconfig parsing uses `ts.readConfigFile` +
`ts.parseJsonConfigFileContent` (`tsconfig-aliases.ts:70`). **No regex JSX
parsing, no Babel, no `@typescript-eslint/parser` in the scan path.** (The ESLint
parser only exists inside the separate jsx-a11y lint pass.)

**Q: Do you re-parse the same file twice?**
Sometimes — **known inefficiency.** `source-trace.ts` has a process-lifetime
`fileCache` (`source-trace.ts:134`) so tracing never re-parses. But
`resolve-components.ts:215` has its *own* `readSourceFile` that bypasses that
cache. A file loaded by both paths is parsed twice in one scan. Third cache:
`optionsCache` for per-tsconfig compiler options (`source-trace.ts:45`).

**Q: Gigantic monorepo — 50k TSX files. What happens?**
The honest framing: **this is a per-file / per-package incremental scanner, not
a whole-monorepo batch tool — by design.** Three signals prove the intent: the
hook scans ONE edited file (`scan([filePath])`), `scan(filePaths)` takes an
explicit file list (pass `git diff`, not the tree), and CLI/MCP take a *dir* (you
point at `packages/web`, not the root).

If you *do* point `check` at the whole root, the cost is real and worth naming
before he does:
| Stage | What it does | Scaling problem |
|---|---|---|
| Discovery (`collectTsx`) | recursive `readdir`, **sequential** | serial walk of the whole tree |
| Resolve (`readSourceFile`, `resolve-components.ts:215`) | `ts.createSourceFile` on every file, **synchronous** | O(N) blocking parses, pins one core |
| Lint (`eslint.lintFiles`, `core.ts:221`) | re-reads + re-parses every file with `@typescript-eslint/parser` | **every file parsed twice, by two different parsers** |
| Caches | per-process, no eviction, **cold every run** | memory unbounded; no cross-run reuse |

Root-cause weaknesses (the accurate list): **(1)** double full-parse — the TS
compiler *and* the ESLint TS parser each parse every file independently (not a
cache miss — two engines); **(2)** synchronous, single-threaded, no worker pool;
**(3)** no incremental cache across runs (unlike `tsc --incremental` — every
invocation starts cold).

Forward-motion answer: *"We scan at the edit boundary, not the whole repo. Path
to whole-repo if needed: (1) scope by `git diff`, (2) worker-pool the parse,
(3) persistent hash-keyed incremental cache."*

**Q: Malformed source / missing tsconfig — crash or degrade?**
Degrades everywhere *except* a broken committed config, which is intentional:
- Missing/malformed tsconfig → matcher becomes `NEVER`, scan continues
  (`tsconfig-aliases.ts:120`); resolver falls back to Bundler/ESNext defaults
  (`source-trace.ts:55`).
- Malformed workspace/`package.json` → `try/catch` returns `null`
  (`workspace-resolve.ts:84`).
- Malformed **`binclusive.json`** → **throws on purpose** (`config-scan.ts:35`).
  A broken committed contract must surface, not silently no-op.

---

## 2. Import resolution & tracing

**Q: How do you resolve imports? One mechanism or several?**
A **three-tier waterfall** in `resolveRoute` (`source-trace.ts`):
1. TS's own `ts.resolveModuleName` with options from the file's nearest tsconfig
   (`makeResolver`, `source-trace.ts`).
2. **Workspace packages** — read `pnpm-workspace.yaml` or `package.json#workspaces`
   globs, match by `package.json#name` (`workspace-resolve.ts:241`).
3. **Node `#imports`** — walk up to nearest `package.json` with an `imports`
   field (`imports-resolve.ts:187`).
All three cached per starting directory.

**Q: tsconfig `paths` aliases — and the `extends` chain?**
Handled separately in `tsconfig-aliases.ts`. `readEffectivePaths`
(`tsconfig-aliases.ts:69`) uses `ts.parseJsonConfigFileContent`, which makes
**TypeScript itself merge the full `extends` chain** — including shared configs
in `node_modules`. No manual depth cap. Each tsconfig parsed once, cached in
`matcherCache` (`tsconfig-aliases.ts:46`). An alias into relative source =
own-code; into `node_modules`/bare package = treated as external design system.

**Q: Monorepo workspaces on a fresh clone with no `node_modules`?**
Works — resolution reads workspace manifests directly, not the installed tree
(`workspace-resolve.ts:241`). **Limit:** glob expansion supports single-star
(`packages/*`) and literals only; `**` is explicitly unsupported
(`workspace-resolve.ts:158`) — fine because that's all pnpm/yarn use in practice.
Subpaths resolve against the `exports` field incl. `./*` wildcards
(`workspace-resolve.ts:294`), falling back to `main`/`module`/`types`/`index.*`.

**Q: Barrel files and re-exports — do you follow them, and do you loop forever?**
Followed to **depth 3** (`MAX_DEPTH`, `source-trace.ts:26`). `findReExports`
(`source-trace.ts:566`) handles `export { X } from "mod"`; value aliases
(`const Dialog = DialogPrimitive.Root`) via `findValueAlias`
(`source-trace.ts:718`). A re-export to an external module returns immediately as
the origin. **No infinite loop** — circular re-exports just hit depth 3 and go
opaque (silently — a minor gap, but safe).

**Q: `#imports` with conditional exports?**
`resolveImportsSubpath` (`imports-resolve.ts:187`) sorts patterns longest-key-
first so specific beats catch-all. Conditions read in order
`default → require → import → browser → node` (`imports-resolve.ts:35`); `types`
excluded (`.d.ts` isn't traceable source). **Gap:** only one level of condition
nesting handled (`imports-resolve.ts:137`).

**Q: How do you decide a wrapper is "thin enough" to map to an HTML element?**
`renderShapeOf` (`source-trace.ts:431`) walks the return body, counts unique
non-transparent root host tags (lowercase `/^[a-z]/`). Maps if: **exactly one
root host element** AND props are forwarded (either `{...props}` spread or all
call-site props passed through). Radix `asChild`/`Slot` is treated as a
transparent branch (`RADIX_SLOT_MODULE`, `source-trace.ts:28`), so
`asChild ? <Slot {...p}/> : <button {...p}/>` correctly maps to `button`.
Multiple distinct roots (Portal + Overlay + Content) → opaque.

---

## 3. The three collectors (don't conflate them)

**Q: You said "scan." Scan *what*? There seem to be three different scanners.**
Right — **three completely separate producers** of the same `Finding` shape:

| Collector | Input | Engine | When |
|---|---|---|---|
| `collect.ts` (source) | `.tsx` files | TS compiler AST | `check` / `scan` — the default |
| `collect-dom.ts` | a live URL | Playwright + axe-core | `check-url` / `scan:url` |
| `collect-swift.ts` | Swift dir | out-of-process SwiftPM + SwiftSyntax | `check-swift` |

The DOM collector (`collect-dom.ts:67`) **never reads source** — it renders in
real Chromium and runs axe. The Swift one spawns a binary and reads its JSON
stdout. They share nothing but the output type, which is why they slot into the
same enforcement gate cleanly.

**Q: Your README says "no network, no upload." But `check-url` drives a real
browser to a URL. Lie?**
**No — but the claim is scoped, so phrase it precisely.** It means two things:
(1) the **static `check` path** touches zero network; (2) **nothing is ever
uploaded to Binclusive** — findings never leave the machine, there's no auth, no
telemetry (`mcp.ts:12`). `check-url` deliberately hits a URL *the user explicitly
hands it* (`collect-dom.ts`) — that's the user's network, their intent, their
data staying local. The honest one-liner: *"No upload of your data to us; the URL
scanner uses the network you point it at."*

---

## 4. Suppressions

**Q: How does a developer silence a false positive? `eslint-disable`?**
**No comment parsing at all** — this surprises people. Suppression is
**AST-structural**, in `suppression-ranges.ts`, and only for the *content* rule
family (`CONTENT_RULES` set, gated by `isContentSuppressed`,
`suppression-ranges.ts:342`):
1. `transInjectedLineRanges` — children injected at runtime (`<Trans>`, render
   props, `{...props}` that may carry children) (`suppression-ranges.ts:93`).
2. `ariaHiddenLineRanges` — `aria-hidden={true}` literal only; variables and
   `={false}` are *not* suppressed (`suppression-ranges.ts:171`).
3. `spreadChildrenLineRanges` — `{...props}`/`{...rest}` in DS wrappers
   (`suppression-ranges.ts:219`).
**Gap to own:** no per-line `// a11y-ignore`. To silence a *non-content* rule
(e.g. a role mismatch) your only lever is the global `ignore` list in
`binclusive.json` — file-or-rule granularity, not per-site.

---

## 5. Rules, corpus & enforcement (the part that makes it *ours*)

**Q: What IS a rule — code or data?**
Three kinds, **all code, none pluggable at runtime:**
1. **jsx-a11y** rules — the ESLint plugin (`core.ts:3`), full plugin runs.
2. **enforce** rules — a static `RULES` record (`enforce.ts:675`): 5 entries
   (`buttonNoName`, `imageNoAlt`, `linkNoName`, `dialogNoName`, `inputNoLabel`) +
   `prefer-tag-over-role`. Adding one = a code change.
3. **learned** rules — free text appended to `binclusive.json`
   (`contract.ts:47`); they render into the AGENTS.md block as guidance but are
   **not enforced** against source. (Worth flagging if asked "what's `learn` do.")

**Q: "Corpus-driven rules" — does the corpus decide what fires at runtime?**
**No, and this is the sharp distinction.** Rule *firing* is pure static AST
classification (`enforce.ts` `classify → evaluate`) with zero corpus lookup. The
corpus enters only at **enrichment** (`corpus.ts:enrichAll`), attaching a
frequency tier + proven fix to findings already found. The corpus can't add or
suppress a finding — it *annotates* them with "this fails in N/26 orgs."

**Q: How does enforce avoid false positives?**
One invariant: fire **only when app-owned content is statically, clearly absent**
(`enforce.ts:38`). So `{...props}` spread → skip; dynamic child `{label}` → skip;
toggle controls (Checkbox/Switch/Radio, name comes from external label) → skip
via `isToggleRole` (`enforce.ts:6`); opaque component with no heuristic match →
skip. Conservative by construction.

**Q: corpus vs baseline vs snapshot — three data files, what's the difference?**
- **`data/corpus/patterns-<SC>.json`** — the real, distilled, anonymized audit
  patterns (15 SCs, each gated to ≥3 orgs). The good stuff.
- **`data/baseline-rules.json`** — generated from axe-core metadata (104 rules,
  `baseline/gen-baseline.ts`). Coverage fallback for SCs the audit corpus has
  never seen.
- **`data/corpus-snapshot.json`** — a hand-seeded SC-level frequency table (643
  findings / 26 orgs / ~15 SCs). Its own `_meta` says it predates the full
  distillation and is "to be replaced." **Honest gap:** snapshot and distilled
  patterns *coexist* and both load (`corpus.ts:17`); which is authoritative for
  SC-level tier is unresolved.
Enrichment prefers `audit > baseline > none`.

**Q: The distill pipeline uses an LLM. Where's the determinism?**
The LLM runs **offline, once**, and its output is **committed as a frozen
fixture** (`data/clusters/clusters-<SC>.json`). It only (a) writes generic
English prose per failure shape and (b) assigns finding IDs to clusters — over
PII-stripped worklists (`extract-for-clustering.ts`). Everything downstream is
deterministic code (`distill/distill.ts`): re-join org_ids, gate at **k≥3 distinct
orgs** (`MIN_ORGS`), assign tier (`tierForOrgs`, thresholds 15/8/3), strip PII,
write patterns + a drop-`ledger`. **Nondeterminism never reaches the shipped
pipeline** — it's frozen upstream of the code gate.

**Q: WCAG mapping looks thin — only ~11 jsx-a11y rules mapped.**
**Real gap.** `wcagForRuleId` returns `[]` for unmapped rules (`wcag-map.ts:31`).
Unmapped findings still surface but carry `wcag:[]` → no corpus enrichment →
always `block` (no SC to match a warn list) → no tier. Rules like
`aria-required-attr`, `autocomplete-valid`, `media-has-caption` are missing.

**Q: Three passes — do you double-count the same violation?**
`dedupeEnforce` (`core.ts:316`) drops an enforce finding when a jsx-a11y finding
already exists at the same `(file, line)` — jsx-a11y wins (more precise rule ID).
Axe findings carry a DOM selector not a line, so they dedupe separately; Swift is
a separate file space.

---

## 6. Entry points & runtime

**Q: How many ways can this be invoked?**
Five surfaces, all converging on the same pure functions (`scan`, `enrichAll`,
`scanUrl`, `learn`, `init`, `gen`):
- **CLI** `a11y-checker` — `check`, `check-url`, `check-swift`, `init`, `learn`,
  `gen`, `mcp`, `hook`, plus bare-dir back-compat (`cli.ts`, `commands.ts`).
- **MCP server** (`mcp.ts`) — stdio, tools `check_a11y`, `check_url`,
  `get_a11y_rules`, `learn_a11y_rule`; each wraps results in the standard
  `{content:[{type:"text", text: JSON.stringify(...)}]}` envelope.
- **Claude Code hook** (`hook.ts`) — a **PostToolUse** hook (not git): reads the
  event on stdin, scans the edited `.tsx`, emits `additionalContext` so the model
  self-corrects same-turn. **Always exits 0** — fail-safe, never blocks an edit.
- **Library** (`index.ts`) — programmatic API.
- **npm scripts** — `scan`, `scan:url`, `mcp` via `tsx`.

**Q: Is Effect doing heavy lifting?**
**No — Effect is only the CLI parser/runner.** `Command.make(...)` →
`Effect.promise(() => runCheck(...))` → `.pipe(Effect.provide(NodeContext.layer),
NodeRuntime.runMain)` (`cli.ts`). The real work is plain `async/await`. No custom
layers or services. `NodeContext.layer` only feeds `@effect/cli`'s own
FileSystem/Path/Terminal needs. **The scanning subsystem is Effect-free.**

**Q: The published package points `main` at `src/index.ts` — TypeScript?**
Yes. `main` and `types` both → `./src/index.ts`; `bin/a11y.mjs` imports the `.ts`
source directly. **No build step** — it ships source and assumes a TS loader
(`tsx`) in the environment. Fine for the dev/agent context it targets; **not yet
a pre-compiled npm lib** for arbitrary Node consumers. Honest gap if asked
"can I `npm i` and `import` this in plain Node?" — not cleanly today.

**Q: How does it find its corpus data at runtime?**
Static `import ... with {type:"json"}` at the top of `corpus.ts` — resolved at
module-init relative to `corpus.ts`, **no runtime path discovery, no env var.**
Works as long as `package.json#files` ships `data/corpus-snapshot.json`,
`data/corpus/patterns-*.json`, `data/baseline-rules.json` (it does). If absent →
hard module-not-found at startup, **no graceful degradation.**

**Q: Exit codes?**
`0` clean (or warn-only — warn-only is a clean build by the customer's own
policy), `1` blocking findings, `2` bad URL. Set by `renderReport` in `cli.ts`.
MCP has no exit semantics — errors go in the content envelope.

---

## 7. The honest gap list (say these before he finds them)

A talented engineer respects "here's what I know is weak" more than a clean story.

1. **`.js`/`.jsx` out of scope** — plain-JS React isn't scanned (by design: no
   types to trace). NOT a `.ts`-with-JSX gap — that case can't exist in TS.
2. **Double full-parse** — every file is parsed by both the TS compiler
   (`resolve-components.ts:215`) and the ESLint TS parser (`core.ts:221`); two
   engines, not a cache miss. Plus `resolve-components.ts` bypasses
   `source-trace`'s `fileCache` (a third, smaller redundancy).
3. **No scaling for whole-monorepo batch** — synchronous, single-threaded,
   unbounded per-process cache, cold every run. Built for per-file/per-package.
4. **WCAG map is partial** — many jsx-a11y rules carry no SC.
5. **No inline per-line suppression** for non-content rules.
6. **Snapshot vs distilled corpus coexist** — authority for SC-level tier unclear.
7. **Ships TS source, no build** — not consumable as a plain compiled npm lib.
8. **No retry on flaky URL** in the DOM collector — one nav fail drops the URL.
9. **Single-level** conditional-export nesting in `#imports` resolution.

---

*Generated from a full read of `src/` on the `fix/shadcn-barrel-classification`
branch. Refresh after major refactors — every claim is a `file:line` you can
verify.*
