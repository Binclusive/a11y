import path from "node:path";
import type { DirectoryNode, ModuleNode, Thresholds } from "../schema.js";
import { smellsForDirectory } from "../smells/evaluate.js";

/**
 * directories.ts — group source files by their directory (SPEC §8-C4).
 *
 * Cheap-pass: this needs only the analyzed-root-relative file list and each file's
 * function count — no type info — so it runs in the default pass alongside the
 * function/module extraction, and the `directory-sprawl` smell fires there.
 *
 * `dir` is the POSIX `dirname` of the analyzed-root-relative module path; a file at the
 * analyzed root (`dirname === "."`) is grouped under `"."`. Files and
 * directories are sorted by a total order for determinism (SPEC §3).
 */

/** POSIX dirname of an analyzed-root-relative path. Root-level files group under ".". */
function dirOf(file: string): string {
  const d = path.posix.dirname(file);
  return d === "" ? "." : d;
}

/**
 * Build a DirectoryNode per directory from the module list, attaching the
 * `directory-sprawl` smell. Modules carry their `functionIds`, so the directory
 * function count is the sum of its files' function-id counts (no re-walk).
 */
export function buildDirectories(modules: ModuleNode[], thresholds: Thresholds): DirectoryNode[] {
  const byDir = new Map<string, { files: string[]; functionCount: number }>();
  for (const m of modules) {
    const dir = dirOf(m.file);
    const entry = byDir.get(dir) ?? { files: [], functionCount: 0 };
    entry.files.push(m.file);
    entry.functionCount += m.functionIds.length;
    byDir.set(dir, entry);
  }

  const directories: DirectoryNode[] = [];
  for (const [dir, entry] of byDir) {
    const files = entry.files.slice().sort((a, b) => a.localeCompare(b));
    const node: DirectoryNode = {
      dir,
      fileCount: files.length,
      functionCount: entry.functionCount,
      files,
      smells: [],
    };
    node.smells = smellsForDirectory(node, thresholds);
    directories.push(node);
  }
  directories.sort((a, b) => a.dir.localeCompare(b.dir));
  return directories;
}
