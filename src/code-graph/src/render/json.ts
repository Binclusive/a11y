/**
 * json.ts — the ONE JSON serializer for every renderer (SPEC §3).
 *
 * §3 requires "JSON is serialized with sorted object keys" so the same input
 * yields the same bytes. `JSON.stringify` preserves insertion order, which is
 * stable across runs only by construction discipline — this makes it literal:
 * object keys are sorted alphabetically before emitting.
 *
 * Arrays are NOT reordered. Their element order is the documented per-array
 * sort owned by assemble.ts (§6/§8); this layer only normalizes object-key
 * order, never array contents.
 */

/**
 * Recursively rebuild `value` with every plain-object's keys in alphabetical
 * order. Arrays keep their order (elements are still recursed into so nested
 * objects get sorted). Primitives pass through. The result is structurally
 * identical to the input but serializes to byte-stable JSON.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeys(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Serialize `value` with sorted object keys (§3). `pretty` indents with two
 * spaces; otherwise the compact single-line form. The single emit path for
 * every JSON renderer — no renderer calls `JSON.stringify` directly.
 */
export function stableStringify(value: unknown, pretty: boolean): string {
  const normalized = sortKeys(value);
  return pretty ? JSON.stringify(normalized, null, 2) : JSON.stringify(normalized);
}
