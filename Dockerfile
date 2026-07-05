# Lean CI image for the @binclusive/a11y engine's static React/TSX path. The
# engine runs TypeScript through the tsx loader at invocation time (no build
# step, no Chromium). A multi-stage build keeps corepack/pnpm and the install
# tooling out of the shipped image; only the runtime node_modules + sources land
# in the final layer. See issue #2133 (slim the CI image for faster pulls).

# ---- deps: resolve the production dependency closure the static path needs ----
FROM node:20-alpine AS deps

# pnpm's `onlyBuiltDependencies` (esbuild only) already blocks playwright's
# browser download; belt-and-suspenders so no Chromium is ever fetched.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=1

# lockfileVersion 9.0 → pnpm 9.
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /engine

# --prod drops vitest/fast-check/@types: tsx executes TS without type-checking,
# so the runtime needs none of them. --no-optional skips @binclusive/a11y-corpus:
# it stays declared in package.json (+ both lockfiles) so authed-dev installs link
# the local workspace, but the public CI image ships corpus-absent (baseline/degraded
# floor — the engine require-or-empties it). The corpus workspace is not COPYed here,
# so installing it would dangle; --no-optional is what keeps the frozen install honest.
# Ordering note: --frozen-lockfile runs the package.json↔lockfile consistency check
# BEFORE honoring --no-optional, so both lockfiles must already record the corpus
# (they do) for this to pass.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --no-optional --frozen-lockfile

# The browser lane (playwright/@axe-core, the `check-url` path) and the MCP lane
# (@modelcontextprotocol/sdk, the `mcp` command) are lazy-loaded in the engine —
# the static `check` path never imports them — so they are dead weight in a CI
# image that only runs `check`. Drop them here (safe precisely because nothing on
# the static path resolves them). Then strip source maps + docs no runtime reads.
# Keep `axe-core` itself — eslint-plugin-jsx-a11y depends on it on the static
# path. Only the browser integration (@axe-core/playwright) + playwright + the
# MCP SDK are dead weight for `check`.
RUN rm -rf \
      node_modules/playwright node_modules/playwright-core \
      node_modules/@axe-core \
      node_modules/@modelcontextprotocol \
      node_modules/.pnpm/playwright@* node_modules/.pnpm/playwright-core@* \
      node_modules/.pnpm/@axe-core+playwright@* \
      node_modules/.pnpm/@modelcontextprotocol+sdk@* \
 && find node_modules -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -delete 2>/dev/null || true

# ---- runtime: minimal final image, no build tooling ----
FROM node:20-alpine

# git         — the entrypoint diffs BASE..HEAD to find changed .tsx files.
# ca-certs    — HTTPS to the GitHub REST API when posting review comments.
RUN apk add --no-cache git ca-certificates

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=1

WORKDIR /engine

# Only the resolved runtime deps cross the stage boundary — corepack, the pnpm
# store, and the install metadata stay behind in `deps`.
COPY --from=deps /engine/node_modules ./node_modules

# Engine sources + the CI wrapper. .dockerignore keeps node_modules, git
# history, docs, and experiments out so the copy stays small.
COPY . .
RUN chmod +x /engine/entrypoint.sh

ENTRYPOINT ["/engine/entrypoint.sh"]
