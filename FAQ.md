# FAQ — the questions you're about to ask

Written for a skeptical senior engineer. Short answers; the decks have the long ones.

---

### "Isn't this just `eslint-plugin-jsx-a11y`?"

No — that's *one of two* passes, and the smaller one. The win is the second pass: a **content check at the call site** that recognizes a control by type and verifies the name/label/alt you passed — so it catches bugs *inside* opaque, "trusted" design-system components a structural linter declares fine (an icon-only `<IconButton>` with no name, a `<Input>` with no label). On top of that, every finding is **matched to a corpus of real audit failures** (how common it is, the fix that worked) — which a generic ruleset structurally cannot do.

### "How don't you drown me in false positives?"

Conservatism is the core discipline: the content check fires **only when a problem is statically, provably there.** Any uncertainty — props spread in (`{...props}`), a value built at runtime, a label living in a sibling it can't see — and it stays silent. It would rather miss a real bug than invent a fake one, because a tool that cries wolf gets turned off.

We validated on **14 real repos** and drove false positives to ~zero, fixing each FP class a fresh repo surfaced — react-admin's cross-library name collision (22 findings → 1), a shadcn carousel that renders its own `sr-only` label. Receipts in `docs/decks/numbers.html`.

### "There's an LLM in this. Does my code go to a model? Is it non-deterministic?"

**No, and no.** The LLM runs **once, offline**, to group historical audit findings into failure shapes; that judgment is frozen as committed data, like a test fixture. Everything in the shipped checker is **deterministic code**. When you run `scan`, no model runs and nothing leaves your machine — it reads your local files against a local corpus. This is a hard architectural line, not a promise.

### "What's actually novel here / why can't a competitor copy it?"

The corpus, and what it's aimed at. Our audit findings concentrate on the **semantic + interaction** failures that need human judgment — structure, names, keyboard, focus — **not** the contrast/alt failures automated scanners catch cheaply. (In our data, contrast is near the *bottom*; in the biggest automated web scan it's #1.) That same head is exactly what **AI coding tools get wrong**. So the corpus is pre-aimed at the AI's blind spot — and no generic tool has it, because it comes from running real audits. The chart that makes this land is in `numbers.html`.

### "Does it scale to a big codebase?"

Yes. **855 files** (Formbricks `apps/web`) in seconds; 150-file storefronts clean; no crashes across 14 repos. It's static analysis (TypeScript AST + eslint) — single pass, and it does **not** build or run your project.

### "How does it reach my design-system components if it can't see inside them?"

It resolves each component to the HTML element it really renders, four ways, strongest first: **(0)** you declared it, **(1)** a registry of known libraries (MUI / Radix / Chakra / antd / Medusa UI / Headless UI), **(2)** it traces the component's own source and infers the single forwarding host. What it *can't* resolve, it **reports honestly** — split into `trusted` / `icons` / `structural` / `declare` — instead of silently skipping. A silent skip is how other tools make a blind scan look clean.

### "What about a component it doesn't recognize?"

It lands in `declare` — shown, not hidden. You add a one-line entry to `binclusive.json` to teach it, or we add the library to the registry (pure data). Coverage grows from real runs, not guesses.

### "Is this meant to replace accessibility audits?"

No — it's the **other half.** Audits find what already shipped; this stops it shipping. Together they close the loop, and every audit makes the corpus (and the checker) sharper. Audit without a write-time tool = the same bugs keep arriving; write-time tool without audits = nobody watches the long tail.

### "How does it actually reach the AI / the developer day-to-day?"

Three surfaces (this review build ships the first as the CLI; the others are in `plugin/`):
- a **generated block** in `AGENTS.md` / `CLAUDE.md` the AI reads *before* it writes code,
- a **PostToolUse hook** that whispers findings back the instant the AI edits a file, so it fixes them in the same turn,
- an **MCP server** for Cursor / Copilot / Claude.

### "What's not done yet — the honest edges?"

- Part of the corpus is still a **hand-built seed** while full distillation rolls out criterion by criterion.
- **Dialog naming** is hard to judge from static code (a name can render in an unseen child), so we hand that to the dynamic audit.
- Coverage on an **unregistered design system** drops until we register it — a data task, not a logic gap.

None of this is hidden — it's stated out loud in the decks. We'd rather show an honest gap than a fake-clean scan.

---

*If a question isn't answered here, that's a gap worth fixing before this ships wider — flag it.*
