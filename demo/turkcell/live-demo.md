# Turkcell — Live Demo Script (3 commands)

Run these from the repo root: `a11y-checker-plugin/`. Requires `pnpm install`
done once (deps already vendored in this repo).

## 0) One-time setup — install the Chromium we render in

```bash
pnpm exec playwright install chromium
```

Run once per machine. On this laptop it's already installed, so this is a no-op
(it just confirms the browser is present).

## 1) The killer demo — scan Turkcell's live homepage

```bash
pnpm scan:url https://www.turkcell.com.tr
```

What the room sees: the tool opens real Chromium, renders the live Turkcell
homepage, runs axe-core against the rendered DOM, and prints **63 findings**
(58 serious / 5 moderate) — including **5 color-contrast** nodes the linter can't
see and **45 carousel keyboard-trap** findings tagged
`VERY COMMON · 21/26 orgs` from our audit corpus. Exit code 1 (blocking).

Optional second/third live pages (both render, ~10-20s each):

```bash
pnpm scan:url https://www.turkcell.com.tr/yardim            # 8 findings  (3 contrast)
pnpm scan:url https://www.turkcell.com.tr/cep-telefonlari   # 13 findings (1 CRITICAL image-alt, 8 contrast)
```

## 2) The local-file example — same engine, a file on disk

`scan:url` accepts a local path / `file://` URL too, so you can show the exact
same render+axe pipeline on a page you control:

```bash
# create a tiny broken page, then scan it
printf '%s\n' '<!doctype html><html><body>' \
  '<img src="x.png">' \
  '<a href="/next"></a>' \
  '<p style="color:#bbb;background:#fff">low contrast text</p>' \
  '</body></html>' > /tmp/broken.html

pnpm scan:url /tmp/broken.html
```

This fires `image-alt` (CRITICAL), `link-name` (SERIOUS), and `color-contrast`
(SERIOUS) on a 4-line file — the smallest possible "the render is the proof" demo.

## Razor / template caveat (one line)

Plain pages and live URLs render directly. **Server-rendered templates (Razor /
.cshtml, ERB, Blade, JSP) are not files you can point Chromium at — they need a
running server**, so for those, start the app locally (e.g. `dotnet run`) and scan
the resulting `http://localhost:<port>/...` URL instead of the template file.
