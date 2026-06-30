/**
 * ADR-sequence collision gate for `.decisions/` (issue #77, ADR 0006).
 *
 * The why: `write-code` allocates the next ADR number at *branch-creation* time
 * with no reservation on the monotonic `.decisions/` sequence, so two
 * decision-builders fanned out in parallel both derive the same next id and
 * collide silently when their branches reach `main` — a duplicate ADR file id
 * and a duplicate row in `.decisions/index.md`. A per-PR review gate cannot see
 * a cross-PR collision on shared global state, so the collision is invisible
 * until both branches merge. This is the *combined-tree* detection/rejection
 * gate ADR 0006 chooses: it runs over the merged `.decisions/` directory and
 * fails loud on any duplicate sequence number (in the files or the index) and
 * on any file<->index drift, so the collision is rejected instead of shipping.
 *
 * Pure and filesystem-narrow: it reads a `.decisions` directory and returns a
 * structured verdict. No process exit, no console — the CLI shell
 * (`scripts/check-decisions.ts`) and the regression test (`test/
 * decisions-collision.test.ts`) both drive this same function.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DecisionsLintResult {
  /** true iff no collision and no file<->index drift was found. */
  ok: boolean;
  /** Human-readable lines, one per problem; empty when ok. */
  errors: string[];
  /** Sorted unique 4-digit ADR ids discovered among the `.decisions/` files. */
  ids: string[];
}

/** An ADR filename is `NNNN-slug.md` with a zero-padded 4-digit sequence. */
const ADR_FILE_RE = /^(\d{4})-.*\.md$/;
/** The optional frontmatter `id:` line, used to cross-check the filename. */
const FRONTMATTER_ID_RE = /^id:\s*(\d{4})\s*$/m;

/** Pull the 4-digit ADR id out of an `index.md` table row's FIRST cell only. */
function indexRowId(line: string): string | null {
  if (!line.trimStart().startsWith("|")) return null;
  const cells = line.split("|");
  // cells[0] is the empty span before the leading pipe; cells[1] is column 1.
  const firstCell = cells[1];
  if (firstCell === undefined) return null;
  // The header cell is `#` and the separator cell is `---`; neither carries a
  // 4-digit run, so matching \d{4} in column 1 selects only real ADR rows.
  const m = firstCell.match(/(\d{4})/);
  return m ? m[1]! : null;
}

/**
 * Lint a `.decisions` directory for ADR-sequence collisions and index drift.
 * Returns ok:false with one error line per problem; never throws on a
 * malformed-but-present tree (a missing `index.md` is itself reported).
 */
export function lintDecisions(decisionsDir: string): DecisionsLintResult {
  const errors: string[] = [];

  // 1. Map every ADR file to its sequence id; flag duplicate sequence numbers.
  const filesById = new Map<string, string[]>();
  for (const name of readdirSync(decisionsDir).sort()) {
    const m = name.match(ADR_FILE_RE);
    if (!m) continue;
    const id = m[1]!;
    const list = filesById.get(id) ?? [];
    list.push(name);
    filesById.set(id, list);

    // Frontmatter `id:` must agree with the filename, so a renumbered-by-hand
    // file whose frontmatter still claims the old id is caught too.
    const fmId = readFileSync(join(decisionsDir, name), "utf8").match(
      FRONTMATTER_ID_RE,
    )?.[1];
    if (fmId !== undefined && fmId !== id) {
      errors.push(
        `ADR file ${name}: frontmatter id '${fmId}' does not match filename sequence '${id}'`,
      );
    }
  }
  for (const [id, names] of [...filesById].sort()) {
    if (names.length > 1) {
      errors.push(
        `duplicate ADR sequence number ${id}: ${names.join(", ")} — two decisions collide on the same id (issue #77)`,
      );
    }
  }

  // 2. Parse `index.md` rows; flag duplicate rows for the same id.
  const indexById = new Map<string, number>();
  let indexPresent = true;
  let indexText: string;
  try {
    indexText = readFileSync(join(decisionsDir, "index.md"), "utf8");
  } catch {
    indexPresent = false;
    indexText = "";
    errors.push(`.decisions/index.md is missing — cannot verify ADR rows`);
  }
  if (indexPresent) {
    for (const line of indexText.split("\n")) {
      const id = indexRowId(line);
      if (id === null) continue;
      indexById.set(id, (indexById.get(id) ?? 0) + 1);
    }
    for (const [id, count] of [...indexById].sort()) {
      if (count > 1) {
        errors.push(
          `duplicate index.md row for ADR ${id} (${count} rows) — two decisions appended the same id (issue #77)`,
        );
      }
    }
  }

  // 3. Cross-check files <-> index 1:1, so a collision that surfaces as a file
  //    without a row (or a row without a file) is rejected too.
  if (indexPresent) {
    for (const id of [...filesById.keys()].sort()) {
      if (!indexById.has(id)) {
        errors.push(
          `ADR ${id} has a file but no row in index.md — index out of sync`,
        );
      }
    }
    for (const id of [...indexById.keys()].sort()) {
      if (!filesById.has(id)) {
        errors.push(
          `index.md row for ADR ${id} has no matching .decisions/${id}-*.md file — index out of sync`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    ids: [...filesById.keys()].sort(),
  };
}
