# Wrap the existing @binclusive/a11y engine (static React/TSX path) in a lean
# CI image. No Chromium, no build step — the engine runs TypeScript through the
# tsx loader at invocation time.
FROM node:20-slim

# git         — the entrypoint diffs BASE..HEAD to find changed .tsx files.
# ca-certs    — HTTPS to the GitHub REST API when posting review comments.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pnpm's `onlyBuiltDependencies` (esbuild only) already blocks playwright's
# browser download; this is belt-and-suspenders so no Chromium is ever fetched.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=1

# lockfileVersion 9.0 → pnpm 9.
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /engine

# Deps first, as their own cache layer. --prod drops vitest/fast-check/@types:
# tsx executes TS without type-checking, so the runtime needs none of them.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Engine sources + the CI wrapper. .dockerignore keeps node_modules, git
# history, docs, and experiments out so the copy stays small.
COPY . .
RUN chmod +x /engine/entrypoint.sh

ENTRYPOINT ["/engine/entrypoint.sh"]
