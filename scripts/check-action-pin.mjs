// Drift gate for the action manifests' image pins (issue #2109).
//
// Each action*.yml pins an EXACT image tag for reproducibility — the root
// action.yml pins the static image :<version>, and a variant manifest pins the
// CANONICAL prefix form :<variant>-<version> (action-url/action.yml → :browser-<V>).
// The version TRAILS the variant so release-please's generic updater can repin it
// in lockstep (release-please-config.json), which is what removes the manual bump.
// The version of record is package.json; nothing else forces the pins to move with
// it, so this gate fails CI on drift and now asserts the FULL expected tag (not just
// the version portion — the old suffix-strip let a static-image pin slip onto the
// browser manifest and pass). It covers the root action.yml AND any subdirectory
// action.yml — the subdir form is how a second action is published (uses:
// owner/repo/<dir>@ref → <dir>/action.yml; see
// .patterns/github-actions/uses-resolution.md).
// Runnable locally (`pnpm check:action-pin`) and in CI.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const pkgVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

// Canonical tag per manifest: :<prefix><version>. The root action.yml is the static
// image (no prefix); action-url/action.yml is the browser variant (:browser-<V>).
// The version TRAILS the variant so release-please repins it, and so this gate can
// assert the FULL expected tag. A new variant manifest registers its prefix here —
// an unregistered one defaults to "" and fails until added (intended fail-loud).
const expectedPrefix = (file) => (file === "action-url/action.yml" ? "browser-" : "");

// Every action manifest: the root action.yml plus each subdirectory's action.yml
// (action-url/action.yml). A GitHub action manifest is ALWAYS named action.yml /
// action.yaml — the reference form (owner/repo@ref vs owner/repo/<dir>@ref) picks
// the directory, never the filename — so we look for that exact name at the root
// and one level down. node_modules and dot-directories are skipped.
const isManifestName = (name) => /^action\.ya?ml$/.test(name);
const manifests = [];
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && isManifestName(entry.name)) {
    manifests.push(entry.name);
  } else if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
    for (const inner of readdirSync(resolve(root, entry.name))) {
      if (isManifestName(inner)) manifests.push(`${entry.name}/${inner}`);
    }
  }
}
if (manifests.length === 0) {
  console.error("action-pin: no action.yml manifest found at repo root or one level down.");
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
  // EXACT match against the canonical form :<prefix><version> — no stripping. The
  // previous suffix-strip let a variant manifest pinning the bare :<version> (the
  // static image) pass, since only the version portion was compared; asserting the
  // full tag closes that hole.
  const tag = m[1];
  const expected = `${expectedPrefix(file)}${pkgVersion}`;
  if (tag !== expected) {
    errors.push(
      `${file}: DRIFT — pins a11y:${tag} but must pin a11y:${expected} (package.json is ${pkgVersion}).`,
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
