// Drift gate for the action manifests' image pins (issue #2109).
//
// Each action*.yml pins an EXACT image tag — docker://ghcr.io/binclusive/a11y:<V>
// (or :<V>-<variant>, e.g. action-url.yml's :<V>-browser) — for reproducibility:
// a consumer resolving the Action at ref v<V> gets that exact digest. But the
// version of record is package.json. Nothing structurally forces them to move
// together, so a bump to 0.1.1 that publishes the new image while a manifest
// still serves 0.1.0 would silently ship a stale image. This gate makes that
// drift fail CI: bumping package.json REQUIRES a matching edit to every action
// manifest. It globs action*.yml, so a manifest the Phase-7 child adds
// (action-url.yml, pinned :<V>-browser) is covered with zero edits here.
// Runnable locally (`pnpm check:action-pin`) and in CI.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const pkgVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

// All root-level action manifests: action.yml today, action-url.yml tomorrow.
const manifests = readdirSync(root).filter((f) => /^action.*\.yml$/.test(f));
if (manifests.length === 0) {
  console.error("action-pin: no action*.yml manifest found at repo root.");
  process.exit(1);
}

const errors = [];
for (const file of manifests) {
  const src = readFileSync(resolve(root, file), "utf8");
  const m = src.match(/docker:\/\/ghcr\.io\/binclusive\/a11y:([^\s"']+)/);
  if (!m) {
    errors.push(`${file}: no \`docker://ghcr.io/binclusive/a11y:<version>\` pin found.`);
    continue;
  }
  // Strip an optional trailing "-<variant>" (e.g. "-browser") so both :0.1.0 and
  // :0.1.0-browser validate against package.json 0.1.0 — the VERSION portion is
  // what must match; the variant suffix is free.
  const tag = m[1];
  const version = tag.replace(/-[a-z0-9]+$/, "");
  if (version !== pkgVersion) {
    errors.push(
      `${file}: DRIFT — pins a11y:${tag} (version ${version}) but package.json is ${pkgVersion}. ` +
        `Re-pin to :${pkgVersion}${tag.length > version.length ? tag.slice(version.length) : ""}.`,
    );
  }
}

if (errors.length > 0) {
  console.error("action-pin: image-pin drift detected —");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `action-pin: OK — ${manifests.length} manifest(s) (${manifests.join(", ")}) all pin version ${pkgVersion}.`,
);
