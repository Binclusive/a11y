// Post each a11y finding as an inline PR review comment via the GitHub REST API.
//
// Best-effort by design: any missing context or failed POST is logged to stderr
// and skipped — never thrown — so the calling entrypoint can still exit 0. Uses
// Node 20's global fetch; no dependencies.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY ("owner/name"), PR_NUMBER, HEAD_SHA,
//      GITHUB_API_URL (optional, defaults to the public API).
import { readFileSync } from "node:fs";

const reportPath = process.argv[2];
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const pr = process.env.PR_NUMBER;
const commitId = process.env.HEAD_SHA;
const api = process.env.GITHUB_API_URL || "https://api.github.com";

const bail = (msg) => {
  console.error(`pr-comment: ${msg}`);
  process.exit(0); // never fatal
};

if (!token || !repo || !pr || !commitId) bail("missing PR context; skipping");

let findings;
try {
  findings = JSON.parse(readFileSync(reportPath, "utf8")).findings ?? [];
} catch (e) {
  bail(`could not read findings JSON: ${e.message}`);
}

if (findings.length === 0) bail("no findings to post");

const url = `${api}/repos/${repo}/pulls/${pr}/comments`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "binclusive-a11y-agent",
  "Content-Type": "application/json",
};

for (const f of findings) {
  const wcag = (f.wcag ?? []).map((s) => `WCAG ${s}`).join(", ") || "no WCAG mapping";
  const body = `**a11y: \`${f.ruleId}\`** (${wcag})\n\n${f.message}`;
  // side:"RIGHT" anchors the comment on the head (post-change) version of the
  // file — the line only exists there when it is part of the PR diff.
  const payload = { body, commit_id: commitId, path: f.file, line: f.line, side: "RIGHT" };
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (res.ok) {
      console.error(`pr-comment: commented on ${f.file}:${f.line}`);
    } else {
      const text = await res.text();
      console.error(`pr-comment: ${f.file}:${f.line} -> ${res.status} ${text.slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`pr-comment: POST failed for ${f.file}:${f.line}: ${e.message}`);
  }
}
