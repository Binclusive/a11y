/**
 * The Buildkite platform adapter — a sibling behind the reporter seam (issue #212),
 * added alongside `github` (#2235), `null`, and `gitlab` (#213) without touching the
 * contract. Its two halves mirror the GitLab adapter's shape, but the reporter
 * MECHANISM differs: Buildkite has no REST review-note surface, so findings are
 * published as a build **annotation** by shelling out to the `buildkite-agent`
 * subprocess, not by an HTTP POST.
 *
 *   - the RESOLVER reads Buildkite CI's PR context (`BUILDKITE_PULL_REQUEST` is the
 *     PR number, but the literal string `"false"` when the build is NOT a PR; the
 *     changed `.tsx` scope comes from the same `BASE_SHA`/`HEAD_SHA` the pipeline
 *     exports from `BUILDKITE_PULL_REQUEST_BASE_BRANCH`/`BUILDKITE_COMMIT`), and
 *   - the REPORTER renders the canonical findings into one grouped annotation and
 *     publishes it via `buildkite-agent annotate --context <stable> --style <s>`.
 *
 * Opt-in by construction (the same discipline as the GitHub/GitLab adapters): the
 * resolver yields a `null` post-target — so the reporter no-ops — when there is no
 * PR context (`BUILDKITE_PULL_REQUEST` absent or `"false"`). Absent a PR build the
 * artifacts still emit and the advisory gate still exits 0.
 */
import { spawn } from "node:child_process";
import { scopeChangedTsxFromEnv } from "../diff-scope";
import type { DiffContext, DiffContextResolver, Finding, FindingsReporter, PlatformAdapter } from "./contract";

/** The result of one `buildkite-agent` invocation — the runner never throws, it resolves this. */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The injected command runner — `(args, stdin) => Promise<CommandResult>`. This is
 * the Buildkite analog of the GitLab adapter's injectable `fetch`: the reporter
 * shells out through this seam instead of a hardcoded `spawn` the test can't
 * intercept, so a test passes a fake runner and asserts the exact `annotate`
 * args + stdin payload WITHOUT a real `buildkite-agent` binary on the machine.
 */
export type CommandRunner = (args: readonly string[], stdin: string) => Promise<CommandResult>;

/**
 * The stable annotation context key. `buildkite-agent annotate` UPDATES an existing
 * annotation in place when given the same `--context`, so a re-run of the pipeline
 * replaces the prior a11y annotation rather than appending a duplicate — the
 * Buildkite analog of the GitLab PUT-by-marker dedupe.
 */
export const ANNOTATION_CONTEXT = "a11y";

/** A Buildkite annotation style — cosmetic only; it colours the annotation, it never gates the build. */
export type AnnotationStyle = "success" | "info" | "warning" | "error";

/** The Buildkite-native surface an annotation posts to. */
export interface BuildkitePostTarget {
  /** The PR number, from `BUILDKITE_PULL_REQUEST` (never the string `"false"` here — that's the no-op signal). */
  readonly prNumber: string;
  /** The stable `--context` key so a re-run updates the annotation in place. */
  readonly context: string;
  /** How the reporter runs `buildkite-agent` — injected so the transform is testable without the binary. */
  readonly runCommand: CommandRunner;
}

const nonEmpty = (v: string | undefined): v is string => v !== undefined && v !== "";

/**
 * The default runner: spawn the real `buildkite-agent` with `args`, piping `stdin`
 * to its stdin. It always RESOLVES a {@link CommandResult} — a missing binary
 * (spawn `error`) resolves as a non-zero code rather than rejecting, so the reporter
 * logs-and-swallows every failure and the advisory gate stays exit-0.
 */
const defaultRunCommand: CommandRunner = (args, stdin) =>
  new Promise<CommandResult>((resolve) => {
    const child = spawn("buildkite-agent", [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    // A missing `buildkite-agent` binary surfaces as a spawn `error`; resolve it as a
    // non-zero result (never reject) so the reporter's best-effort contract holds.
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: e instanceof Error ? e.message : String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.end(stdin);
  });

/** Resolve the Buildkite change-context: changed `.tsx` + a post-target, or `null` when not a PR build. */
export const buildkiteResolver: DiffContextResolver<BuildkitePostTarget> = {
  resolve(env): DiffContext<BuildkitePostTarget> {
    const changedTsx = scopeChangedTsxFromEnv(env);
    const pr = env.BUILDKITE_PULL_REQUEST;
    // Opt-in: Buildkite sets BUILDKITE_PULL_REQUEST to the literal string "false" on a
    // non-PR build, so "false"/absent ⇒ no target ⇒ the reporter no-ops (mirrors the
    // github/gitlab adapters). No credential gate: `buildkite-agent` authenticates via
    // the agent's own access token, injected into the job env by Buildkite itself.
    if (!nonEmpty(pr) || pr === "false") {
      return { changedTsx, postTarget: null };
    }
    return { changedTsx, postTarget: { prNumber: pr, context: ANNOTATION_CONTEXT, runCommand: defaultRunCommand } };
  },
};

/** error when any critical/serious finding is present, else warning — advisory colour only, never a gate. */
function annotationStyleFor(findings: readonly Finding[]): AnnotationStyle {
  if (findings.length === 0) return "success";
  return findings.some((f) => f.impact === "critical" || f.impact === "serious") ? "error" : "warning";
}

/**
 * Render the canonical findings into ONE Buildkite annotation body — the platform's
 * findings→annotation transform. Each finding carries its impact, rule, WCAG tags,
 * message, and `file:line`; a trailing rollup summarises the distinct WCAG criteria.
 * An empty finding set renders a clean pass.
 */
export function renderAnnotation(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return "**Binclusive a11y** — no accessibility findings in the changed files.";
  }
  const rows = findings.map((f) => {
    const wcag = (f.wcag ?? []).map((s) => `WCAG ${s}`).join(", ");
    const impact = f.impact ? `\`${f.impact}\` ` : "";
    const tag = wcag !== "" ? ` (${wcag})` : "";
    return `- ${impact}**${f.ruleId}**${tag} — ${f.message} — \`${f.file}:${f.line}\``;
  });
  const criteria = new Set<string>();
  for (const f of findings) for (const w of f.wcag ?? []) criteria.add(w);
  const summary = criteria.size > 0 ? `\n\n_WCAG criteria: ${[...criteria].sort().join(", ")}._` : "";
  return `**Binclusive a11y** found ${findings.length} accessibility finding(s) in the changed files:\n\n${rows.join("\n")}${summary}`;
}

/**
 * Publish the findings as one grouped Buildkite annotation. Best-effort: a non-zero
 * `buildkite-agent` exit or a missing binary is logged and swallowed, never thrown,
 * so the advisory gate stays exit-0 (mirrors the GitLab reporter's swallow).
 */
export const buildkiteReporter: FindingsReporter<BuildkitePostTarget> = {
  async report(findings, target, log): Promise<void> {
    const body = renderAnnotation(findings);
    const style = annotationStyleFor(findings);
    // The stable --context is what makes a re-run UPDATE the annotation in place; the
    // body is piped on stdin so a large finding list never blows the argv limit.
    const args = ["annotate", "--style", style, "--context", target.context];
    try {
      const { code, stderr } = await target.runCommand(args, body);
      if (code === 0) {
        log(`buildkite: annotated PR #${target.prNumber} (context=${target.context}, ${findings.length} finding(s))`);
      } else {
        log(`buildkite: buildkite-agent annotate exited ${code}: ${stderr.slice(0, 200)}`);
      }
    } catch (e) {
      log(`buildkite: annotate failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

/** The Buildkite adapter: the PR diff-context resolver + the annotation reporter, keyed `buildkite`. */
export const buildkiteAdapter: PlatformAdapter<BuildkitePostTarget> = {
  key: "buildkite",
  resolver: buildkiteResolver,
  reporter: buildkiteReporter,
};
