# Ready-made CI/CD configs

Copy-paste configs that run the published **`ghcr.io/binclusive/a11y`** engine
image on the major CI systems. Each scans the `.tsx` files changed in a PR
(falling back to a diff vs the default branch on plain branch builds), posts
findings, and is **advisory by default** — it never blocks a merge until you
opt into the gate.

> Already on **GitHub Actions**? You don't need these — use the first-class
> Action instead: [`examples/github-actions/a11y.yml`](../github-actions/a11y.yml).

## The configs

| System | File | The one platform-specific gotcha |
|---|---|---|
| GitLab CI/CD | [`gitlab/.gitlab-ci.yml`](gitlab/.gitlab-ci.yml) | Shallow clone (depth 20) hides the MR base — pinned `GIT_DEPTH: "0"`. `image:` needs `entrypoint: [""]` so GitLab can run `script:`. |
| CircleCI | [`circleci/config.yml`](circleci/config.yml) → `.circleci/config.yml` | **No base-branch variable exists** — the base is derived by fetching the default branch. `checkout` is a full clone but the base ref is still absent until fetched. |
| Buildkite | [`buildkite/pipeline.yml`](buildkite/pipeline.yml) | No fixed clone depth (agent-dependent) — the config unshallows before the diff. No managed secret store: `B8E_TOKEN` comes from an agent env/pre-command hook, propagated via the docker plugin. |
| Jenkins | [`jenkins/Jenkinsfile`](jenkins/Jenkinsfile) | Multibranch PR base is `CHANGE_TARGET`; container runs as `root` so git trusts the mounted workspace. No native soft-fail — wrap the step in `catchError`. |
| Bitbucket | [`bitbucket/bitbucket-pipelines.yml`](bitbucket/bitbucket-pipelines.yml) → repo root | Shallow clone (last 50 commits) — pinned `clone: depth: full`. No soft-fail keyword: the advisory escape is `... \|\| true`. |

Each file lands at its platform's canonical path — drop the CircleCI one at
`.circleci/config.yml` and the Bitbucket one at the repo root as
`bitbucket-pipelines.yml`; the rest keep their names.

## How each config resolves the diff

The engine scopes its scan to the changed `.tsx` by reading `BASE_SHA` /
`HEAD_SHA` / `GITHUB_WORKSPACE` (explicit env always wins). Each config maps
those from the platform's own variables:

| System | Base (`BASE_SHA`) | Head (`HEAD_SHA`) | Workspace |
|---|---|---|---|
| GitLab | `origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME` (else default branch) | `CI_COMMIT_SHA` | `CI_PROJECT_DIR` |
| CircleCI | `origin/<default>` (derived — no base var) | `CIRCLE_SHA1` | `$(pwd)` |
| Buildkite | `origin/$BUILDKITE_PULL_REQUEST_BASE_BRANCH` (else default) | `BUILDKITE_COMMIT` | `$(pwd)` |
| Jenkins | `origin/$CHANGE_TARGET` (else default) | `GIT_COMMIT` | `WORKSPACE` |
| Bitbucket | `origin/$BITBUCKET_PR_DESTINATION_BRANCH` (else default) | `BITBUCKET_COMMIT` | `BITBUCKET_CLONE_DIR` |

## How to adapt

1. **Bump the image tag.** Every config pins `ghcr.io/binclusive/a11y:0.1.1`.
   Change the tag to upgrade. To scan a **live URL** instead of source, set
   `INPUT_SCAN_URL` and switch to the browser variant
   `ghcr.io/binclusive/a11y:browser-<version>` — the canonical prefix form; the
   legacy `ghcr.io/binclusive/a11y:<version>-browser` (e.g. `:0.1.1-browser`) is
   still published for back-compat. It ships the Chromium the static image strips.
2. **Set the default branch.** Configs assume `main` (the `A11Y_DEFAULT_BRANCH`
   var) for non-PR builds and for CircleCI's derived base — change it if yours
   differs.
3. **Enable the gate (optional).** Uncomment `FAIL_ON=serious` (fail when any
   finding is at or above that impact — `critical` > `serious` > `moderate` >
   `minor`) or `MAX_VIOLATIONS=<n>`. Left off, the run is advisory and exits 0.
   Each file also notes its platform's soft-fail escape if you want a tripped
   gate to only warn.
4. **Enable phone-home (optional).** Add `B8E_TOKEN` via the platform's
   masked-secret mechanism (noted in each file). Absent, the scan is fully
   local — no account, no upload.

The image, the env contract, and the gate are identical across all five; only
the wrapper — how each system runs a container, injects a secret, exposes the
base branch, and clones — differs. Those per-platform differences are the
generic truth documented in [`.patterns/ci-runners/`](../../.patterns/ci-runners/).
