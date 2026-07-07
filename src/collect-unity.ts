/**
 * The Unity STATIC collector — L3 of the Unity producer (issue #71, ADR 0004), the
 * analog of `collect-liquid.ts` for the Unity ecosystem.
 *
 * This is the THIN file walk + boundary: collect the `.prefab` / `.unity` assets
 * under a project dir, parse each into a node graph (or an OPAQUE state) via L1
 * (`unity-ast.ts`), and hand back a per-asset result the structural-absence rules
 * (later children #70/#72/#73) will walk. Identity resolution rides on the built-in
 * widget GUID registry (`unity-guid-registry.ts`).
 *
 * Mirrors `scanLiquid`'s shape: a forgiving walk (a missing dir is an empty scan),
 * and one bad/binary asset is recorded as opaque, never a crash — opaque is reported,
 * not silently skipped (ADR 0004). This slice emits no `Finding`s yet (the rules are
 * separate children); it stands up the producer + graph the rules attach to.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseUnityDocument, type UnityParseResult } from "./unity-ast";

/** Build/library dirs that are not project source — skipped on the walk. `Library`
 * and `Temp` are Unity's generated caches; the rest match the other collectors. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  "Library",
  "Temp",
  "obj",
]);

/** The Unity serialized-asset extensions this slice reads: uGUI prefab YAML and
 * scene YAML. (`.uxml`/`.inputactions` are out of scope — ADR 0004 / #71.) */
const UNITY_EXTENSIONS = [".prefab", ".unity"] as const;

const isUnityAsset = (name: string): boolean =>
  UNITY_EXTENSIONS.some((ext) => name.endsWith(ext));

/**
 * Recursively collect `.prefab` / `.unity` files under `dir`, skipping build/library
 * dirs. A missing or unreadable directory yields `[]` rather than throwing — a
 * non-existent scan target is an empty scan, the forgiving contract the other
 * collectors give the CLI.
 */
export async function collectUnityFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await collectUnityFiles(full)));
    } else if (entry.isFile() && isUnityAsset(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** One scanned asset and its parse outcome — a walkable graph, or an OPAQUE state
 * (binary / unparseable) surfaced rather than skipped. */
export interface UnityAsset {
  readonly file: string;
  readonly parse: UnityParseResult;
}

/** The result of a Unity project scan — mirrors `LiquidScanResult`'s shape with
 * per-asset parse outcomes in place of findings (rules are later children). */
export interface UnityScanResult {
  readonly root: string;
  readonly files: readonly string[];
  readonly assets: readonly UnityAsset[];
}

/**
 * Scan Unity serialized source under `dir`. Collects the assets, then parses each into
 * a graph or an opaque state. A binary (non-Force-Text) or unparseable asset is
 * recorded as `{ kind: "opaque", … }` on its `UnityAsset` and the scan continues — one
 * bad asset never aborts the scan, and the opaque state is reported, not hidden.
 */
export async function scanUnity(dir: string): Promise<UnityScanResult> {
  const root = resolve(dir);
  const files = await collectUnityFiles(root);

  const assets: UnityAsset[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assets.push({ file, parse: parseUnityDocument(source) });
  }

  return { root, files, assets };
}
