import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCodeGraphLookup } from "./codegraph-lookup";
import { LookupCounter, meterLookup } from "./lookup";

/**
 * These tests drive the REAL published `@binclusive/code-graph` CLI as a subprocess
 * over a real directory (a small `test/fixtures/code-graph-lookup` module), so they
 * exercise the actual stdout contract this seam depends on — not a mock. Each spawns
 * a ts-morph cheap pass (~1-2s), so they carry an explicit per-test timeout.
 */
const CODE_GRAPH_SRC = fileURLToPath(
  new URL("../../test/fixtures/code-graph-lookup", import.meta.url),
);
const TIMEOUT = 30_000;

describe("createCodeGraphLookup — structural lookups over the published CLI", () => {
  it(
    "a `file` query returns the module's structural JSON",
    async () => {
      const tool = createCodeGraphLookup({ root: CODE_GRAPH_SRC });
      const result = await tool.lookup({ kind: "file", target: "schema.ts" });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const data = result.data as { found: boolean; kind?: string; json?: unknown };
      expect(data.found).toBe(true);
      expect(data.kind).toBe("file");
      // The `--file` view is a module record — assert its shape at the boundary.
      const json = data.json as { module?: { file?: string } };
      expect(json.module?.file).toBe("schema.ts");
    },
    TIMEOUT,
  );

  it(
    "a `summary` query returns the project health JSON",
    async () => {
      const tool = createCodeGraphLookup({ root: CODE_GRAPH_SRC });
      const result = await tool.lookup({ kind: "summary", target: "" });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const data = result.data as { found: boolean; json?: unknown };
      expect(data.found).toBe(true);
      const json = data.json as { fileCount?: number };
      expect(typeof json.fileCount).toBe("number");
    },
    TIMEOUT,
  );

  it(
    "a missing file is a `found: false` envelope, not a throw",
    async () => {
      const tool = createCodeGraphLookup({ root: CODE_GRAPH_SRC });
      const result = await tool.lookup({ kind: "file", target: "does-not-exist.ts" });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const data = result.data as { found: boolean };
      expect(data.found).toBe(false);
    },
    TIMEOUT,
  );

  it("an unknown kind is refused without spawning a subprocess", async () => {
    const tool = createCodeGraphLookup({ root: CODE_GRAPH_SRC });
    const result = await tool.lookup({ kind: "not-a-real-kind", target: "x" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as { found: boolean; reason?: string };
    expect(data.found).toBe(false);
    expect(data.reason).toContain("unsupported lookup kind");
  });

  it(
    "the per-finding cap still short-circuits the tool via meterLookup",
    async () => {
      const tool = createCodeGraphLookup({ root: CODE_GRAPH_SRC });
      const counter = new LookupCounter(1);
      const metered = meterLookup(tool, counter);

      const first = await metered.lookup({ kind: "summary", target: "" });
      expect(first.status).toBe("ok");
      const second = await metered.lookup({ kind: "summary", target: "" });
      // Budget spent: the second call is capped and never reaches code-graph.
      expect(second.status).toBe("capped");
      expect(counter.used).toBe(1);
    },
    TIMEOUT,
  );
});
