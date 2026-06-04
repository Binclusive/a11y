/**
 * The local "scan → contract → learn" loop, as filesystem operations.
 *
 * Each exported command is a thin IO shell around the pure layers
 * (`detect-stack`, `contract`, `agents-block`): read disk → compute → write
 * disk. The pure pieces are what the tests exercise; this module is what the
 * CLI calls. Nothing here ever writes a secret into `binclusive.json`.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractBlock, renderBlock, slugify, spliceBlock } from "./agents-block";
import { collectTsx } from "./collect";
import {
  type Contract,
  defaultEnforcement,
  emptyDeclarations,
  type LearnedRule,
  parseContract,
  type Stack,
  serializeContract,
} from "./contract";
import { corpusCriteria, corpusPatterns } from "./corpus";
import { detectStack } from "./detect-stack";

/** The committed contract file name, and the two managed-block targets. */
export const CONTRACT_FILE = "binclusive.json";
export const BLOCK_TARGETS = ["AGENTS.md", "CLAUDE.md"] as const;

/** Read a UTF-8 file, or `null` if it doesn't exist. */
async function readMaybe(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}

/**
 * Load and boundary-parse the contract at `dir/binclusive.json`. Returns `null`
 * when the file is absent; THROWS (loud) when present-but-malformed — a broken
 * committed contract must never be silently overwritten.
 */
export async function loadContract(dir: string): Promise<Contract | null> {
  const text = await readMaybe(join(dir, CONTRACT_FILE));
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `binclusive.json is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
  return parseContract(raw);
}

/**
 * Merge a freshly-detected stack over the customer's existing one so a re-`init`
 * refreshes what detection KNOWS without clobbering a manual override.
 *
 * `framework` and `language` are hard signals (deps + tsconfig) — the detected
 * value always wins. `router` and `designSystem` are the soft, overridable
 * fields: detection NEVER downgrades a specific committed value to its generic
 * fallback (`null` router / `"custom"` design system). So a customer who hand-set
 * `designSystem: "@acme/ui"` keeps it even on a scan where nothing resolves,
 * while a real detection (`@mui/material`) still refreshes a stale value.
 */
function mergeStack(detected: Stack, existing: Stack | undefined): Stack {
  if (existing === undefined) return detected;
  return {
    framework: detected.framework,
    language: detected.language,
    router: detected.router ?? existing.router,
    designSystem:
      detected.designSystem === "custom" ? existing.designSystem : detected.designSystem,
  };
}

/** Enforcement defaults derived from the corpus: very-common SC block, rest warn. */
function corpusDefaultEnforcement(): ReturnType<typeof defaultEnforcement> {
  const criteria = corpusCriteria();
  const veryCommon = criteria.filter((c) => c.tier === "very-common").map((c) => c.sc);
  const rest = criteria.filter((c) => c.tier !== "very-common").map((c) => c.sc);
  return defaultEnforcement(veryCommon, rest);
}

/**
 * Write the managed block into every target file (`AGENTS.md`, `CLAUDE.md`),
 * creating the file when absent and preserving all content outside the markers
 * when present. Returns the list of written file paths.
 */
async function writeBlockTargets(dir: string, contract: Contract): Promise<string[]> {
  const block = renderBlock(contract, corpusPatterns());
  const written: string[] = [];
  for (const name of BLOCK_TARGETS) {
    const path = join(dir, name);
    const existing = await readMaybe(path);
    const next = spliceBlock(existing, block);
    if (next !== existing) {
      await writeFile(path, next, "utf8");
    }
    written.push(path);
  }
  return written;
}

/** The result of `init`, for the CLI to report. */
export interface InitResult {
  readonly contract: Contract;
  readonly contractPath: string;
  readonly blockPaths: readonly string[];
  readonly preservedLearned: number;
}

/**
 * `init [dir]`: detect the stack, then write `binclusive.json` and refresh the
 * managed block in the target files. If a contract already exists, EVERYTHING
 * the customer declared is PRESERVED — `learned[]`, `enforcement`, and the
 * escape-hatch `declarations` (`components` / `injectsChildren` / `ignore`).
 * Only the auto-derived `stack` is refreshed. Re-running init must never clobber
 * the team's accumulated rules, policy, or manual declarations.
 *
 * The one auto-derived field — `stack` — is also non-clobbering for the parts a
 * customer can override: `detectStack` reads disk, but a hand-set `designSystem`
 * or `router` is re-detected the same way it was first detected, so a stable
 * repo yields a stable stack. (Manual stack overrides survive because they are
 * the detector's own output; a re-init re-derives identical values.)
 */
export async function init(dir: string): Promise<InitResult> {
  const tsxFiles = await collectTsx(dir);
  const stack = detectStack(dir, tsxFiles);

  const existing = await loadContract(dir);
  const contract: Contract = {
    version: 1,
    stack: mergeStack(stack, existing?.stack),
    enforcement: existing?.enforcement ?? corpusDefaultEnforcement(),
    learned: existing?.learned ?? [],
    declarations: existing?.declarations ?? emptyDeclarations(),
  };

  const contractPath = join(dir, CONTRACT_FILE);
  await writeFile(contractPath, serializeContract(contract), "utf8");
  const blockPaths = await writeBlockTargets(dir, contract);

  return {
    contract,
    contractPath,
    blockPaths,
    preservedLearned: existing?.learned.length ?? 0,
  };
}

/** Inputs for `learn`, already parsed from CLI flags. */
export interface LearnInput {
  readonly rule: string;
  readonly wcag: readonly string[];
  readonly fix: string | null;
  readonly source: string;
}

/**
 * Append a learned rule to a contract, deduping on identical rule text (case-
 * and whitespace-normalized). Returns the next contract and whether anything
 * was added — pure, so the dedupe behavior is unit-testable without disk.
 */
export function appendLearned(
  contract: Contract,
  input: LearnInput,
  addedAt: string,
): { readonly next: Contract; readonly added: boolean } {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
  const exists = contract.learned.some((r) => norm(r.rule) === norm(input.rule));
  if (exists) return { next: contract, added: false };

  const rule: LearnedRule = {
    id: slugify(input.rule),
    rule: input.rule,
    wcag: [...input.wcag],
    fix: input.fix,
    source: input.source,
    addedAt,
  };
  return { next: { ...contract, learned: [...contract.learned, rule] }, added: true };
}

/** The result of `learn`, for the CLI to report. */
export interface LearnResult {
  readonly added: boolean;
  readonly id: string;
  readonly contractPath: string;
  readonly blockPaths: readonly string[];
}

/**
 * `learn "<rule>" [flags]`: append the rule to `binclusive.json` `learned[]`
 * (ISO `addedAt`, slug id) and regenerate the managed block. Requires an
 * existing contract — `init` must run first so the stack is real, not guessed.
 * Idempotent on identical rule text: a duplicate is a no-op (no second entry,
 * but the block is still regenerated so the files stay in sync).
 */
export async function learn(dir: string, input: LearnInput): Promise<LearnResult> {
  const contract = await loadContract(dir);
  if (contract === null) {
    throw new Error(`no ${CONTRACT_FILE} in ${dir} — run \`a11y-checker init\` first`);
  }
  const { next, added } = appendLearned(contract, input, new Date().toISOString());

  const contractPath = join(dir, CONTRACT_FILE);
  if (added) {
    await writeFile(contractPath, serializeContract(next), "utf8");
  }
  const blockPaths = await writeBlockTargets(dir, next);
  return { added, id: slugify(input.rule), contractPath, blockPaths };
}

/** A per-file drift result from `gen --check`. */
export interface DriftEntry {
  readonly path: string;
  readonly status: "ok" | "drift" | "missing";
}

/** The result of `gen`. In `--check` mode `inSync` gates the CLI exit code. */
export interface GenResult {
  readonly check: boolean;
  readonly inSync: boolean;
  readonly entries: readonly DriftEntry[];
  readonly blockPaths: readonly string[];
}

/**
 * `gen [--check]`: regenerate the managed block from `binclusive.json`.
 *
 * Without `--check`: write the block into every target (preserving surrounding
 * content) and report the paths.
 *
 * With `--check`: write NOTHING. Compare each target's on-disk block against a
 * freshly-rendered one and report drift — `inSync` is false if any target's
 * block differs or is missing. This is the CI guard against hand-editing the
 * generated half instead of `binclusive.json`.
 */
export async function gen(dir: string, check: boolean): Promise<GenResult> {
  const contract = await loadContract(dir);
  if (contract === null) {
    throw new Error(`no ${CONTRACT_FILE} in ${dir} — run \`a11y-checker init\` first`);
  }
  const fresh = renderBlock(contract, corpusPatterns());

  if (!check) {
    const blockPaths = await writeBlockTargets(dir, contract);
    return { check: false, inSync: true, entries: [], blockPaths };
  }

  const entries: DriftEntry[] = [];
  for (const name of BLOCK_TARGETS) {
    const path = join(dir, name);
    const content = await readMaybe(path);
    const onDisk = content === null ? null : extractBlock(content);
    const status: DriftEntry["status"] =
      onDisk === null ? "missing" : onDisk === fresh ? "ok" : "drift";
    entries.push({ path, status });
  }
  const inSync = entries.every((e) => e.status === "ok");
  return { check: true, inSync, entries, blockPaths: entries.map((e) => e.path) };
}
