# Android-Matrix — XML-lane a11y-checker measurement

Cold-scan of `check-android` (ADR 0006, lane 1 — the in-TS XML producer, no JVM)
across **2** real OSS Android apps, SHA-pinned in `manifest.json`. Out-of-the-box:
no `init`, no manual declarations. These are the precision-validation runs that
shaped the XML producer; the SHA-pinned `android:matrix:check` gate harness is not
built yet (see `manifest.json`).

## Matrix — one row per repo (final, after the precision fixes)

| repo | sha | layouts | scanned | findings | blocking | image-no-label | control-no-name | editable-no-label | topRule |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| TeamNewPipe/NewPipe | `46a5964` | 116 | 301 | 27 | 27 | 18 | 9 | 0 | android-xml/image-no-label |
| AntennaPod/AntennaPod | `f7f0314` | 117 | 314 | 35 | 35 | 22 | 9 | 4 | android-xml/image-no-label |

`layouts` = hand-written `res/layout/*.xml`; `scanned` = android-namespaced XML the
producer actually read (incl. `-land`/`-v21`/config variants + other namespaced
resource XML). `blocking` == `findings` because neither repo ships a `binclusive.json`
(no contract → every finding blocks, the historical default).

## Precision iteration — what each app exposed and how it moved the numbers

The value of this corpus is not the final counts but the false-positive classes the
real layouts surfaced, each of which forced a producer fix. **Unit fixtures passed
throughout; only real code revealed these.**

| stage | NewPipe | AntennaPod | trigger |
|---|---:|---:|---|
| initial (flat list) | 110 | 39 | — |
| + honor `tools:ignore` / `importantForAccessibility` (subtree-inherited) | — | — | 39 NewPipe findings were on dev-suppressed elements |
| + descendant-name check (`control-no-name` looks *down* before firing) | **27** | — | 41 NewPipe findings were on containers named by their children |
| + stay opaque inside Material `TextInputLayout` | 27 | **35** | 4 AntennaPod findings were on fields the parent labels |

- **NewPipe: 110 → 27** (~70% of the initial findings were false positives). Drove
  the flat-list → **nested-tree** rewrite. After: 0 residual `tools:ignore` FPs;
  container-`control-no-name` FPs 41 → 1 (and that 1 is a true positive — an
  icon-only action row with no `contentDescription`).
- **AntennaPod: 39 → 35.** Validated the NewPipe fixes generalize to a different
  codebase (0 residual FPs of either class) and exposed the Material
  `TextInputLayout` class NewPipe lacked (no forms). `editable-no-label` 8 → 4; the
  4 survivors are all genuine bare `<EditText>`.

## What the survivors are (precision read)

- **High-confidence true positives**: unlabeled icon `ImageButton`s,
  `FloatingActionButton`s, clickable icon `ImageView`s, a `ChapterSeekBar`, and
  bare `<EditText>`s with neither `hint` nor `labelFor`. These are the canonical
  TalkBack failures the lane exists to catch.
- **Defensible (Android Lint agrees)**: `ImageView` thumbnails in list items with no
  `contentDescription` — flaggable, though some are decorative-by-adjacency.

## Known limitation — runtime-bound item-template text (ADR 0006)

The residual gray tier across both apps: RecyclerView / dialog **item templates**
(`*_item`, `*_row`, `list_*`) whose `Button`/`TextView` text or thumbnail
`contentDescription` is set at runtime in the adapter. Statically these look
nameless, so `control-no-name` / `image-no-label` fire on some of them (e.g.
AntennaPod's 6 no-icon Material `<Button>`s in `*_dialog_item` / `*_row`). Per the
decision recorded in ADR 0006 we **keep flagging and document** rather than scope
the rule by filename or trade away recall on genuinely-empty controls. This is the
runtime-binding signal the **Kotlin lane** (which reads the binding adapter) or the
corpus/recall layer is positioned to resolve later — honest noise, not a silent miss.

## Reproduce

```
git clone --depth 1 https://github.com/TeamNewPipe/NewPipe.git      # sha 46a5964
git clone --depth 1 https://github.com/AntennaPod/AntennaPod.git    # sha f7f0314
pnpm tsx ./src/cli.ts check-android <clone>        # add --json for the machine report
```
