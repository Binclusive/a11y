/**
 * The null / stdout adapter — the "generic, no native review UI" platform, and
 * the TRIVIAL SECOND adapter that proves the reporter seam holds ≥ 2 platforms
 * (issue #2235). It is deliberately not GitHub-shaped: no PR identity, no
 * credential, no de-dup reconcile — it just writes each finding to a sink.
 *
 * This is the seam's proof-of-generality, and the seed the future generic `--ci`
 * mode (#2236) and the Buildkite/GitLab adapters (#2237/#2238) build on. Its
 * post-target is always present (a sink is always available), so — unlike the
 * GitHub adapter — it always reports; the no-context no-op path is exercised by
 * the GitHub resolver instead.
 */
import { scopeChangedTsxFromEnv } from "../diff-scope";
import type { DiffContext, DiffContextResolver, Finding, FindingsReporter, PlatformAdapter } from "./contract";

/** A line sink — where the generic reporter writes. Injected so it is testable. */
export type LineSink = (line: string) => void;

/** The null adapter's post-target: just the line sink it writes findings to. */
export interface NullPostTarget {
  readonly write: LineSink;
}

/** One finding as a single stdout line — the generic, UI-less rendering. */
export function renderLine(f: Finding): string {
  const wcag = (f.wcag ?? []).length > 0 ? ` [${(f.wcag ?? []).map((s) => `WCAG ${s}`).join(", ")}]` : "";
  const severity = f.severity ? `${f.severity}: ` : "";
  return `${f.file}:${f.line} ${severity}${f.ruleId}${wcag} — ${f.message}`;
}

/** Build a null adapter over `sink` (defaults to stdout). */
export function makeNullAdapter(sink: LineSink = (line) => process.stdout.write(line)): PlatformAdapter<NullPostTarget> {
  const resolver: DiffContextResolver<NullPostTarget> = {
    resolve(env): DiffContext<NullPostTarget> {
      // A sink is always available, so the generic reporter always has a target.
      return { changedTsx: scopeChangedTsxFromEnv(env), postTarget: { write: sink } };
    },
  };

  const reporter: FindingsReporter<NullPostTarget> = {
    async report(findings, target, log): Promise<void> {
      for (const f of findings) target.write(`${renderLine(f)}\n`);
      log(`generic reporter: wrote ${findings.length} finding(s) to the sink`);
    },
  };

  return { key: "null", resolver, reporter };
}

/** The default null adapter — writes to stdout. */
export const nullAdapter: PlatformAdapter<NullPostTarget> = makeNullAdapter();
