// Fixture for the code-graph structural-lookup seam test (src/runner/codegraph-lookup.test.ts).
// A small parseable module named `schema.ts` so the `--file schema.ts` view resolves a real
// module record and the bare-dir `--summary` reports a non-zero file count. Kept minimal on
// purpose: the test asserts the CLI's stdout contract, not this module's behavior.

export type Widget = {
  readonly id: string;
  readonly label: string;
};

export function makeWidget(id: string, label: string): Widget {
  return { id, label };
}

export function widgetLabel(widget: Widget): string {
  return widget.label;
}
