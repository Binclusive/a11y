# CI runners patterns

How a CI/CD system runs a published Docker image as a build step, and the four
things that image needs from its host to do useful work: a masked secret, the
git/PR context of the commit under test, enough clone history to diff against a
base, and control over what a non-zero exit does to the build. These patterns
let an agent write a runner config for any of five systems without guessing a
keyword, an env-var name, or a default — every approach traces to that system's
own documentation.

The image is treated as a black box: it is pulled, run, and handed inputs. The
patterns are about the runner, not the image, so every example uses generic
placeholders (`ghcr.io/OWNER/IMAGE:TAG`, `your-command`).

Scope: **GitLab CI/CD, CircleCI, and Buildkite** are the primary systems (full
coverage). **Jenkins** (Declarative Pipeline) and **Bitbucket Pipelines** are
secondary — documented for the same five concerns but less exhaustively. Each
concern doc presents every system as an "approach"; pick the section for your
runner. Systems not listed (GitHub Actions, Azure Pipelines, Drone, Woodpecker)
are out of scope.

## Index

| Doc | Concern | Read when |
|---|---|---|
| [run-docker-image.md](./run-docker-image.md) | Pull + run a published image as a build step | Wiring the job that executes the tool container |
| [secrets-and-env.md](./secrets-and-env.md) | Inject a masked secret env var into the step | The image needs a token/API key at runtime |
| [ci-context.md](./ci-context.md) | Built-in env vars: SHA, branch, PR number, base branch | The tool must know what commit/PR it is scanning |
| [checkout-depth.md](./checkout-depth.md) | Shallow-clone defaults and getting the base ref | A step runs `git diff base...head` and the base is missing |
| [exit-codes.md](./exit-codes.md) | Non-zero exit → build result, and the soft-fail escape | Deciding whether a finding should fail or only warn |

## Shared conventions

- Examples use each system's real config surface: GitLab/CircleCI/Buildkite/
  Bitbucket YAML, Jenkins Declarative Pipeline (Groovy), shell in `script`/`run`.
- Image + command are always placeholders. Swap `ghcr.io/OWNER/IMAGE:TAG` and
  `your-command` for the real image and its entrypoint.
- A public registry (e.g. GHCR public packages) needs no registry credentials in
  any of these systems; a private image additionally needs an auth block —
  out of scope here.
- Env-var names are verbatim from each system's predefined-variable reference;
  they are not interchangeable across systems.
