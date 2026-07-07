# Run a11y-checker on any CI/CD — the generic `--ci` mode

The GitHub Action (see the README's **Use it in CI**) is the batteries-included
path on GitHub. Everywhere else — CircleCI, Jenkins, Drone, Woodpecker, Concourse,
a bare `docker run`, or your own runner — use the **generic `--ci` mode**. It needs
no native adapter: run the container image, emit a machine-readable artifact
(SARIF or JSON), and always exit 0.

Native review-UI integrations for specific platforms build **on top of** this
generic mode — Buildkite (annotations) and GitLab (Code Quality / MR widget) are
separate adapters. Until (or unless) you want one, the generic mode below already
gives every platform the same SARIF/JSON artifact.

## The three guarantees

1. **Universal output — `--format sarif | json`.** `--format sarif` emits a valid
   **SARIF 2.1.0** log derived from the canonical finding contract, the standard
   any code-scanning consumer reads. `--format json` emits the raw finding report.
   Pick one per run; both go to stdout.
2. **Non-blocking exit-0 is first-class — `--ci`.** With `--ci` the run **always
   exits 0**, even when contract-blocking findings are present. This is an engine
   mode, not a shell `|| true` swallow — so no per-platform config has to re-swallow
   a non-zero exit. The artifact still emits; the build stays green.
3. **Degrades gracefully with no PR/MR context.** On a platform with no pull/merge
   request to post to, nothing is posted — the artifacts still emit and the run
   still exits 0. Set `A11Y_PLATFORM=null` to use the generic stdout reporter (one
   finding per line) instead of trying to reconcile PR comments.

Opt back into a **failing** build when you want one: `--fail-on critical|major|minor`
fails on severity, `--max-violations N` fails on volume. Both override `--ci` — so
blocking stays available but is off by default. Same severity vocabulary as the
`check` command; no separate CI severity map.

## The copy-paste snippet (any platform)

The whole contract is one container invocation. Replace the image reference with
however you pull the engine image in your registry:

```sh
# Scan ./src, emit SARIF, never fail the build.
docker run --rm \
  -v "$PWD:/workspace" -w /workspace \
  -e A11Y_PLATFORM=null \
  ghcr.io/binclusive/a11y-checker:latest \
  check /workspace/src --ci --format sarif > a11y.sarif

# …or emit JSON instead:
docker run --rm \
  -v "$PWD:/workspace" -w /workspace \
  -e A11Y_PLATFORM=null \
  ghcr.io/binclusive/a11y-checker:latest \
  check /workspace/src --ci --format json > a11y.json
```

Then hand `a11y.sarif` to whatever your platform does with SARIF (upload it as a
code-scanning artifact, attach it to the build, or archive it). Because `--ci`
exits 0, the step is always green — the report is advisory.

### CircleCI

```yaml
# .circleci/config.yml
jobs:
  a11y:
    docker:
      - image: ghcr.io/binclusive/a11y-checker:latest
    environment:
      A11Y_PLATFORM: "null"
    steps:
      - checkout
      - run:
          name: a11y scan (advisory)
          command: a11y-checker check ./src --ci --format sarif > a11y.sarif
      - store_artifacts:
          path: a11y.sarif
```

### Jenkins (declarative pipeline)

```groovy
pipeline {
  agent { docker { image 'ghcr.io/binclusive/a11y-checker:latest' } }
  environment { A11Y_PLATFORM = 'null' }
  stages {
    stage('a11y') {
      steps {
        sh 'a11y-checker check ./src --ci --format sarif > a11y.sarif'
        archiveArtifacts artifacts: 'a11y.sarif'
        recordIssues tool: sarif(pattern: 'a11y.sarif')   // Warnings-NG plugin, optional
      }
    }
  }
}
```

### Drone / Woodpecker

```yaml
steps:
  a11y:
    image: ghcr.io/binclusive/a11y-checker:latest
    environment:
      A11Y_PLATFORM: "null"
    commands:
      - a11y-checker check ./src --ci --format sarif > a11y.sarif
```

## The config-scaffold pattern

Every platform config above is the **same shape**, so a native adapter for a new
platform only fills in the blanks:

1. **Run the image** on the changed/whole source tree.
2. **Select the reporter** with `A11Y_PLATFORM` (`null` = generic stdout; a native
   key routes findings to that platform's review surface).
3. **Emit the artifact** — `check <dir> --ci --format sarif|json`.
4. **Stay non-blocking** — `--ci` owns the exit-0; layer `--fail-on` /
   `--max-violations` only to opt into a failing build.
5. **Hand the artifact** to the platform's native SARIF/report consumer.

A native platform adapter (Buildkite, GitLab) keeps steps 1, 3, and 4 verbatim and
only specializes steps 2 and 5 — a new `A11Y_PLATFORM` key with a reporter that
posts to that platform's review UI. Nothing else in the generic contract changes.
