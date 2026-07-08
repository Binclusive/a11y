# GitLab vertical tracer (#214)

Prove the **connected seam**, not a unit test of the adapter in isolation: the
checker runs end-to-end on GitLab against a fixture MR carrying a real a11y
regression, and the finding surfaces in GitLab's **native review UI** (an MR note).

This directory has two halves:

1. **The in-process connected-seam proof (buildable — done in this PR).**
   `test/gitlab-tracer.integration.test.ts` drives the *full assembled path* a real
   pipeline runs — GitLab CI env → the `gitlab` resolver's post-target → a **real
   engine scan** of `fixture/src/Hero.tsx` → `parseFindings` → `dispatch` → the
   `gitlab` reporter → the MR-note `POST` — with `fetch` recorded via `vi.stubGlobal`.
   It asserts the real finding (`jsx-a11y/alt-text` at `src/Hero.tsx:2`) reaches the
   note payload, covers the PUT-dedupe path, and confirms the no-MR-context no-op.
   This is the ".patterns/reviews" guard: every per-adapter unit test can pass while
   the assembled path never runs — this test runs it.

2. **The live-run evidence (human-gated — keeps #214 OPEN).** AC1 and AC3 require a
   **real** GitLab pipeline run and captured evidence (a pipeline URL + a screenshot
   of the MR note). Those are outward and credentialed — they **cannot** be produced
   in CI here without a live GitLab project and a token. Follow the turnkey steps
   below to close them, then attach the evidence to #214.

## The fixture

- `fixture/src/Hero.tsx` — a component with an `<img>` missing `alt`. The engine
  reports `jsx-a11y/alt-text` (WCAG 1.1.1) on it. This is the known regression that
  must appear as an MR note.
- `fixture/.gitlab-ci.yml` — the copy-paste pipeline config. It mirrors the canonical
  `examples/ci/gitlab/.gitlab-ci.yml` (that file is the source of truth for the knobs
  and env-var names; keep the two in sync).

## Turnkey steps to close AC1 + AC3 (a human with a GitLab project runs these)

1. **Create/point a GitLab project.** Any project on gitlab.com or a self-managed
   host. Note its default branch (assumed `main` below).

2. **Add an api-scoped token as a masked CI/CD variable.** In
   *Settings → CI/CD → Variables*, add a **masked** variable named
   `A11Y_GITLAB_TOKEN` whose value is a **project or personal access token with the
   `api` scope**. This is preferred over the auto-injected `CI_JOB_TOKEN`, whose
   narrower surface cannot always create MR notes. (If you rely on `CI_JOB_TOKEN`
   instead, no variable is needed, but note-creation may be refused by GitLab.)

3. **Push the fixture + pipeline config onto the default branch.** Copy
   `fixture/.gitlab-ci.yml` to the repo root as `.gitlab-ci.yml`, and copy
   `fixture/src/Hero.tsx` to `src/Hero.tsx` (or anywhere the MR will change a `.tsx`).
   Commit and push to `main` so the pipeline config is present on the base branch.

4. **Open a merge request that introduces the regression.** On a feature branch,
   either add `src/Hero.tsx` (if step 3 kept `main` clean) or edit it so the `<img>`
   loses its `alt`. Open an MR targeting `main`. This triggers a
   `merge_request_event` pipeline, which is what wires the MR context
   (`CI_MERGE_REQUEST_IID`, `CI_PROJECT_ID`, `CI_API_V4_URL`).

5. **Let the pipeline run.** The `a11y` job pulls the published engine image, scopes
   the diff to the changed `.tsx`, scans it, and — because `A11Y_PLATFORM=gitlab` and
   a token is present — posts the finding as an MR note. The job **exits 0** (the
   advisory default; AC2), so it does not block the merge.

6. **Capture the evidence for #214:**
   - **(AC3a) the pipeline URL** — copy it from the MR's *Pipelines* tab (the
     `.../-/pipelines/<id>` URL of the run).
   - **(AC3b) a screenshot of the MR note** — the note posted by the tool on the MR's
     *Overview/Activity* thread, showing the `jsx-a11y/alt-text` finding with its
     `file:line`. This is the AC1 native-UI proof.

7. **Attach both to issue #214 and check off AC1 + AC3.** Only once that live
   evidence is on the issue is the tracer complete.

## Status

**#214 stays OPEN until the live-run evidence (AC1 + AC3) is attached.** The
in-process connected-seam proof (deliverable 1) discharges the buildable half and
guards against seam-drift; it does **not** substitute for the real pipeline run,
which no automated agent can perform (it needs a live GitLab project and a
credentialed token). AC2 (advisory exit-0 on GitLab) is asserted structurally by the
`.gitlab-ci.yml` default and the reporter's best-effort, never-throw contract.
