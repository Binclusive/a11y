---
id: 0004
title: Unity a11y — External Static Analyzer over an In-Editor Extension
status: accepted
date: 2026-06-24
tags: [architecture, unity, producer, corpus, distribution]
---

# 0004 — Unity a11y: External Static Analyzer over an In-Editor Extension

## Context

The Unity accessibility initiative (epic #66) forks at one architecture
decision that gates everything downstream — corpus shape, engine reuse, the
two precision constraints, and distribution channel — making it the most
expensive choice to reverse late (#67). There are two fundamentally different
shapes for a Unity a11y checker, and they keep-or-dissolve the two precision
constraints (`Asset Serialization = Force Text`, GUID→`.meta` resolution) in
opposite ways:

- **A) External static analyzer** — Binclusive's current React/Liquid model:
  read source files (prefab/scene YAML) from disk, headless, at CI/repo-time.
  Reuses the existing engine *literally* — the resolver
  (`src/source-trace.ts`, `src/resolve-components.ts`, `src/registry.ts`), the
  structural-absence rule model, and the SHA-pinned `matrix:check`
  corpus-regression methodology (`experiments/stack-matrix/manifest.json`). Its
  cost: it must read Unity's serialized form, which is opaque unless the project
  is set to `Force Text`, and custom components need GUID→`.meta` resolution.
  Distribution: npm / GitHub Action.

- **B) In-Editor extension** — a Unity Editor tool over the live object graph.
  Both precision constraints *disappear*: it reads the loaded scene directly
  (no Force Text), and the engine has already resolved widget identity (no GUID
  resolution). It is *easier to make correct*. Its cost: it loses the headless
  cross-repo corpus-regression methodology (needs a Unity install per project)
  and cannot reuse the existing engine. Distribution: the Unity Asset Store —
  the channel where Unity developers actually acquire tooling.

The asymmetry is real and load-bearing: **the in-Editor path is easier to make
correct; the external-static path is the one that reuses the existing
codebase.** They optimize for opposite things.

**New evidence shifted the balance** (grounded on real bytes — `UnityTechnologies/open-project-1`
@ `608eac98df29cd97821a6115cd52dfb9027345b1`, #66 comment):

- **The GUID precision tax largely evaporated for built-in widgets.** Built-in
  uGUI/TMP component GUIDs are *stable Unity constants, identical in every
  project* — `4e29b1a8efbd4b44bb3f3716e73f07ff` = `UnityEngine.UI.Button`,
  `fe87c0e1cc204ed48ad3b37840f39efc` = `Image`,
  `f4688fdb7df04437aeb418b961361dc5` = `TextMeshProUGUI`. So built-in widget
  identity is a **static registry lookup** (~20 known GUIDs, the existing
  `registry.ts` pattern), *not* per-project `.meta` resolution. `.meta`
  resolution is needed only for project-custom MonoBehaviours — a much smaller
  surface than #67 feared. This directly weakens the in-Editor argument, whose
  main draw was sidestepping the GUID tax.
- **Force Text turned out to be the one real constraint external-static
  carries**, and it is detectable: binary-serialized assets are opaque, but the
  checker can read the project's serialization mode and **stay opaque on binary
  rather than guess** — the same precision invariant the React/Liquid resolver
  already lives by (map to the correct host or stay opaque; never the wrong
  host).
- **The highest-value findings hold on real ground truth** without an Editor:
  `0` references to `AccessibilityNode`/`AccessibilityHierarchy` repo-wide, and
  color-only interactive state at ~89% prevalence — both readable straight from
  serialized YAML.

## Decision

**Build the Unity a11y checker as an external static analyzer** (option A) —
read prefab/scene YAML from disk, headless, at repo/CI time — reusing the
existing engine literally. This is the **agent's evidence-based recommendation**;
see *Reversal* below.

The two precision constraints are addressed, not waved away:

- **GUID resolution → a static built-in-widget registry.** Built-in uGUI/TMP
  identity is a hardcoded table of stable constant GUIDs (the `registry.ts`
  pattern, #71). Only project-custom MonoBehaviours require `.meta` resolution,
  and absent that resolution the checker **stays opaque** on the unknown
  component (per the resolver's precision invariant) — it never maps to the
  wrong widget.
- **Force Text → detect-and-stay-opaque.** The checker detects the project's
  `Asset Serialization` mode. On `Force Text` it reads the YAML; on binary it is
  **opaque by construction** (the assets are unreadable) and reports that state
  rather than guessing. Force Text is required for full coverage, present on
  real corpora, and its absence degrades to honest silence, not false findings.

What this buys, and why it outweighs the in-Editor path's correctness edge:

- **Literal engine reuse.** The resolver, the structural-absence rule model, and
  the WCAG-SC bridge port directly; Unity becomes a new *producer* behind the
  same core, exactly as the Liquid/Shopify path is (#47 / L1–L4). The in-Editor
  path would mean building a second engine inside Unity.
- **The corpus methodology survives.** A SHA-pinned Unity corpus + a
  `matrix:check` analog (#69) is the regression gate that makes real-world drift
  visible in review — the discipline the whole checker is built on. The
  in-Editor path forfeits it (a Unity install per project, no headless
  cross-repo scan).
- **Repo/CI-time fit.** External-static runs in the same place the React/Liquid
  checker does — no network, deterministic, agent-operable.

## Consequences

- **Downstream children proceed on the external-static assumption.** #71
  (`collect-unity` + built-in-widget GUID registry) builds the producer + static
  registry; #69 stands up the SHA-pinned Unity corpus and the `matrix:check`
  analog; #70's 3-state label seam (static `m_text` / runtime
  `LocalizeStringEvent` / absent) is resolved from serialized YAML with
  *opaque-on-runtime* as a first-class state. These are now unblocked to build
  against a disk-reading, headless engine.
- **Force Text is a documented precondition, not a silent failure.** The checker
  detects serialization mode and surfaces "binary — opaque" as an explicit
  state; coverage on a binary-serialized project is honestly reported as
  unavailable. This is consistent with ADR 0001's adapter discipline and the
  resolver's precision invariant.
- **Built-in GUIDs are a maintained constant table.** The registry of ~20
  stable Unity GUIDs is committed and versioned with the code (the `registry.ts`
  pattern); new built-in widgets are added by extending the table. Custom
  MonoBehaviours are opaque until `.meta`-resolved — never wrong-host.
- **Distribution is npm / GitHub Action**, not the Unity Asset Store. We
  knowingly forgo the Asset Store's reach into the Unity-developer audience in
  exchange for engine reuse and the corpus methodology. This is the load-bearing
  trade and the most likely reason to revisit.

### Rejected alternative — in-Editor Unity extension (recorded honestly)

The in-Editor extension is **not a strawman**, and its advantages are genuine:

- It **sidesteps both precision constraints for free** — no Force Text needed
  (reads the loaded scene), no GUID resolution needed (the engine has already
  resolved TMP/widget identity). It is the *easier path to correctness*.
- It **ships on the Unity Asset Store**, the real distribution channel for Unity
  tooling — plausibly a stronger go-to-market than npm for this audience.

It was rejected because it **loses the headless cross-repo corpus methodology**
(`matrix:check`) and **cannot reuse the existing engine** — it would mean
building and maintaining a second checker inside Unity, forfeiting the
deterministic, agent-operable, regression-gated core that is Binclusive's actual
leverage. With the GUID tax largely evaporated (built-in registry) and Force
Text reduced to a detectable precondition, the in-Editor path's correctness edge
shrank below the cost of abandoning engine reuse and the corpus.

### Reversal

This ADR is the **agent's evidence-based recommendation; the owner (@cansirin)
may override it toward the in-Editor / Asset-Store direction** — most plausibly
if Asset Store distribution proves decisive for reaching Unity developers, or if
the Force-Text/custom-MonoBehaviour tax turns out intolerable on a real corpus
(empirically cheap to test: A/B one Button — prefab YAML on disk vs. the live
tree in a throwaway Editor script — before #71 commits). **If overridden, the
assumptions of #71 (producer + GUID registry) and #69 (SHA-pinned corpus) change
materially** — the GUID registry and the corpus methodology are external-static
artifacts that an in-Editor tool would not need — so a reversal should land
before those children are built.
