/**
 * report.ts — read results/*.json and render REPORT.md + report.csv.
 *
 * The report is the WHOLE POINT of the harness: it turns per-repo scan output
 * into a design-system × framework picture of where the checker fires, and
 * surfaces single-rule finding clusters that are the most likely
 * false-positive (and therefore next-hardening) targets.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
const REPORT_MD = join(HERE, "REPORT.md");
const REPORT_CSV = join(HERE, "report.csv");

interface Finding {
  ruleId: string;
  enforcement: "block" | "warn";
  provenance: string;
}

interface Result {
  repo: string;
  designSystem: string;
  framework?: string;
  filesScanned?: number;
  coverage?: { checked: number; trusted: number; declare: number };
  findings?: Finding[];
  summary?: { findings: number; blocking: number; warning: number };
  stars?: number;
  error?: string | null;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/** Most-common ruleId in a finding list, with its count. */
function topRule(findings: Finding[]): { rule: string; count: number } {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.ruleId, (counts.get(f.ruleId) ?? 0) + 1);
  let rule = "-";
  let count = 0;
  for (const [r, c] of counts) {
    if (c > count) {
      rule = r;
      count = c;
    }
  }
  return { rule, count };
}

/** Rule-family = ruleId before any "-" suffix segment after the plugin prefix. */
function ruleFamilies(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.ruleId, (counts.get(f.ruleId) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r, c]) => `${r} (${c})`)
    .join(", ");
}

function main() {
  let files: string[];
  try {
    files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }

  const all: Result[] = [];
  for (const f of files) {
    try {
      all.push(JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8")));
    } catch {
      /* skip unreadable result */
    }
  }

  const ok = all.filter((r) => !r.error);
  const errored = all.filter((r) => r.error);
  ok.sort((a, b) => (b.summary?.findings ?? 0) - (a.summary?.findings ?? 0));

  // ---- main matrix table ----
  const mainRows = ok.map((r) => {
    const findings = r.findings ?? [];
    const { rule } = topRule(findings);
    return {
      repo: r.repo,
      framework: r.framework ?? "?",
      designSystem: r.designSystem,
      files: r.filesScanned ?? 0,
      checked: r.coverage?.checked ?? 0,
      trusted: r.coverage?.trusted ?? 0,
      declare: r.coverage?.declare ?? 0,
      findings: r.summary?.findings ?? 0,
      blocking: r.summary?.blocking ?? 0,
      topRule: rule,
    };
  });

  // ---- per-design-system rollup ----
  const byDs = groupBy(ok, (r) => r.designSystem);
  // ---- per-framework rollup ----
  const byFw = groupBy(ok, (r) => r.framework ?? "?");

  // ---- coverage grid (DS × framework) ----
  const dsKeys = [...new Set(ok.map((r) => r.designSystem))].sort();
  const fwKeys = [...new Set(ok.map((r) => r.framework ?? "?"))].sort();
  const cell = new Map<string, number>();
  for (const r of ok) cell.set(`${r.designSystem}|${r.framework ?? "?"}`, (cell.get(`${r.designSystem}|${r.framework ?? "?"}`) ?? 0) + 1);

  // ---- signal: single-rule clusters (likely FP candidates) ----
  const signals = ok
    .map((r) => {
      const findings = r.findings ?? [];
      const total = findings.length;
      const { rule, count } = topRule(findings);
      const share = total > 0 ? count / total : 0;
      return { repo: r.repo, rule, count, total, share };
    })
    .filter((s) => s.total >= 8 && s.share >= 0.6)
    .sort((a, b) => b.count - a.count);

  // ===== render markdown =====
  const md: string[] = [];
  md.push("# Stack-Matrix — cross-stack a11y-checker measurement\n");
  md.push(
    `Cold-scan recall of the a11y-checker across **${ok.length}** OSS React repos ` +
      `spanning **${dsKeys.length}** design systems × **${fwKeys.length}** frameworks ` +
      `(${errored.length} errored). Out-of-the-box: no \`init\`, no manual declarations.\n`,
  );

  md.push("## Matrix — one row per repo\n");
  md.push("| repo | framework | designSystem | files | checked | trusted | declare | findings | blocking | topRule |");
  md.push("|---|---|---|---|---:|---:|---:|---:|---:|---|");
  for (const r of mainRows) {
    md.push(
      `| ${r.repo} | ${r.framework} | ${r.designSystem} | ${r.files} | ${r.checked} | ${r.trusted} | ${r.declare} | ${r.findings} | ${r.blocking} | ${r.topRule} |`,
    );
  }
  md.push("");

  md.push("## Coverage grid — design system × framework (repo count)\n");
  md.push(`| designSystem | ${fwKeys.join(" | ")} | total |`);
  md.push(`|---|${fwKeys.map(() => "---:").join("|")}|---:|`);
  for (const ds of dsKeys) {
    const cells = fwKeys.map((fw) => String(cell.get(`${ds}|${fw}`) ?? 0));
    const tot = byDs.get(ds)!.length;
    md.push(`| ${ds} | ${cells.join(" | ")} | ${tot} |`);
  }
  md.push("");

  md.push("## Rollup — by design system\n");
  md.push("| designSystem | repos | totalFindings | medianDeclare | dominant rule families |");
  md.push("|---|---:|---:|---:|---|");
  for (const ds of dsKeys) {
    const rs = byDs.get(ds)!;
    const findings = rs.flatMap((r) => r.findings ?? []);
    md.push(
      `| ${ds} | ${rs.length} | ${findings.length} | ` +
        `${median(rs.map((r) => r.coverage?.declare ?? 0))} | ${ruleFamilies(findings) || "-"} |`,
    );
  }
  md.push("");

  md.push("## Rollup — by framework\n");
  md.push("| framework | repos | totalFindings | medianDeclare | dominant rule families |");
  md.push("|---|---:|---:|---:|---|");
  for (const fw of fwKeys) {
    const rs = byFw.get(fw)!;
    const findings = rs.flatMap((r) => r.findings ?? []);
    md.push(
      `| ${fw} | ${rs.length} | ${findings.length} | ` +
        `${median(rs.map((r) => r.coverage?.declare ?? 0))} | ${ruleFamilies(findings) || "-"} |`,
    );
  }
  md.push("");

  md.push("## Signal — single-rule clusters (likely false-positive / next-hardening targets)\n");
  if (signals.length === 0) {
    md.push("_No repo's findings are dominated (>=60% at >=8 findings) by a single rule._\n");
  } else {
    md.push("Repos where one ruleId accounts for the bulk of findings — worth a human look:\n");
    md.push("| repo | dominant rule | count / total | share |");
    md.push("|---|---|---:|---:|");
    for (const s of signals) {
      md.push(`| ${s.repo} | ${s.rule} | ${s.count} / ${s.total} | ${Math.round(s.share * 100)}% |`);
    }
    md.push("");
  }

  md.push("## Errored repos\n");
  if (errored.length === 0) {
    md.push("_None._\n");
  } else {
    md.push("| repo | designSystem | error |");
    md.push("|---|---|---|");
    for (const r of errored) md.push(`| ${r.repo} | ${r.designSystem} | ${r.error} |`);
    md.push("");
  }

  writeFileSync(REPORT_MD, md.join("\n") + "\n");

  // ===== render csv =====
  const csv: string[] = [];
  csv.push("repo,framework,designSystem,files,checked,trusted,declare,findings,blocking,topRule,error");
  for (const r of all) {
    if (r.error) {
      csv.push(`${r.repo},,${r.designSystem},,,,,,,,${csvSafe(r.error)}`);
      continue;
    }
    const { rule } = topRule(r.findings ?? []);
    csv.push(
      [
        r.repo,
        r.framework ?? "",
        r.designSystem,
        r.filesScanned ?? 0,
        r.coverage?.checked ?? 0,
        r.coverage?.trusted ?? 0,
        r.coverage?.declare ?? 0,
        r.summary?.findings ?? 0,
        r.summary?.blocking ?? 0,
        rule,
        "",
      ].join(","),
    );
  }
  writeFileSync(REPORT_CSV, csv.join("\n") + "\n");

  console.log(
    `Wrote REPORT.md + report.csv — ${ok.length} ok, ${errored.length} errored, ` +
      `${signals.length} signal cluster(s).`,
  );
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}

function csvSafe(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

main();
