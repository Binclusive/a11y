---
id: 0002
title: A Flat Command Table, Not a Collector Registry
status: accepted
date: 2026-06-09
tags: [architecture, cli, simplicity]
supersedes: "the rejected Collector-interface design (see Context)"
---

# 0002 — A Flat Command Table, Not a Collector Registry

## Context

We have four producers of the shared `Finding` shape: the jsx-a11y structural
pass, the call-site `enforce` pass, the rendered-DOM / axe pass (`collect-dom.ts`,
ADR 0001), and the SwiftUI static pass (`collect-swift.ts`). The delivery layer
that fronts them is small: a CLI with eight verbs (`check`, `check-url`,
`check-swift`, `init`, `learn`, `gen`, `mcp`, `hook`) and an MCP server with four
tools.

A first pass tried to **name the producers as a `Collector` abstraction**: a
`Collector` interface (`id`, `command`, `usage`, `handles`, `collect`, `report`,
`mcpTool?`), a `CollectResult` carrier, an eight-field `ReportDescriptor`
(`emptyMessage`, `groupKey`, `groupHeader`, `formatItem`, `heading`, `preamble?`,
…), a generic `Collector<E>` for the tsx-only `extra` payload, an `McpToolSpec`,
and a registry (`collectors` / `collectorByCommand` / `collectorFor`) that CLI
routing, USAGE derivation, and the MCP loop all drove off. It was
behavior-preserving and byte-identical — and it was the wrong trade.

At three-to-four collectors, that machinery **added more cognitive load than the
runner duplication it removed**. To read how `check-swift` reports you had to hold
the interface, the descriptor's eight slots, the generic parameter, and the
registry indirection in your head at once — versus reading one 15-line runner
function that calls `scanSwift` then `renderReport({...})` with an inline object.
The descriptor was a config-object re-encoding of a function body; the generic
existed for exactly one collector's `extra`; the registry indexed a list short
enough to read top to bottom. This is the "three similar lines beat a premature
abstraction" case: the duplication between `runCheck` / `runCheckUrl` /
`runCheckSwift` is a few inline `renderReport({...})` literals, and that
duplication is *more* readable than the contract that would dedupe it.

## Decision

**Keep the producers as plain functions. Drive the CLI off a flat command
table.** Reject the `Collector` interface, the `ReportDescriptor`, the generic
`<E>`, the `McpToolSpec`, and the registry.

- **Per-command runners stay plain** in `cli.ts`: `runCheck` (with its inline
  coverage block, `--json` branch, and a `renderReport({...})` call),
  `runCheckUrl`, `runCheckSwift`. Each calls `scan` / `scanUrl` / `scanSwift`
  **directly** and passes an inline options object to `renderReport`. A little
  duplication across the three is fine and wanted.
- **One flat `COMMANDS` table** drives routing and USAGE:
  `const COMMANDS = [{ name, usage, run(rest) }, …]` over all eight verbs.
  `main()` dispatches via `COMMANDS.find(c => c.name === command)?.run(rest)`,
  with the bare-`<dir>` default still falling through to `check`; `USAGE` is
  derived as `` `usage:\n${COMMANDS.map(c => c.usage).join("\n")}` ``. This
  `{ name, usage, run }` row is the ONLY structure we keep — a trivial,
  universally-readable CLI pattern, not a producer contract.
- **MCP registers tools the plain way**: explicit `server.tool(...)` calls for
  `check_a11y`, `check_url`, `get_a11y_rules`, `learn_a11y_rule` in
  `registerTools`. No collector loop, no `McpToolSpec`.
- **The genuine shared abstraction stays where it belongs**: the `Finding` shape,
  `enrichAll` (SC-keyed corpus cross-ref), `resolveDisplay`, the enforcement gate,
  and the `renderReport` helper + formatters (`formatFinding` / `formatUrlFinding`
  / `formatCoverage` / `buildJsonReport`). That core is shared by *substance* —
  every producer feeds the same enrichment and the same renderer — which is real
  leverage. The collectors are not; they are four functions with four different
  inputs, and a name over them bought nothing.

The dividing line: abstract the thing that is genuinely one thing seen four ways
(the `Finding` core), and leave the four things that merely sit next to each other
(the producers, the verbs) as a plain list.

## Consequences

- Net **smaller** than the registry design and than where this branch started:
  no `collector.ts`, no `collect-tsx.ts`, no `mcp-tools.ts`, no standalone
  `report.ts` — the light shape is `main`'s structure plus the flat `COMMANDS`
  table, nothing more.
- Behavior is **byte-identical**: CLI output on `check` (incl. coverage +
  `--json`), `check-url`, `check-swift`, the derived USAGE, and every MCP tool
  result are unchanged vs `origin/main`; the full suite stays green.
- Adding a fifth verb is one row in `COMMANDS` and one `run*` function; adding a
  fifth producer is one function that emits `Finding[]` into `enrichAll` — neither
  touches a contract, because there is none to touch.
- This ADR **supersedes** the heavy `Collector` design. If a future delivery
  surface genuinely shares behavior across producers (not just shape), revisit —
  but caller-count three is not that surface.
