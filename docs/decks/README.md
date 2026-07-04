# a11y-checker — reference decks

Two sibling presentation decks for `@binclusive/a11y`. Reference / north-star
material, not tied to a launch date.

| Deck | File | Audience | Theme |
|------|------|----------|-------|
| **Engineering** | `engineering.html` | the team — how the machine works, conceptually | dark "blueprint" |
| **Eng deep-dive** | `engineering-deep.html` | engineers — the hard problems, approaches, and solutions | dark "blueprint" |
| **Customer** | `customer.html` | a11y-literate buyers — what it is, why it's different, where it fits | light sibling |
| **Numbers** | `numbers.html` | anyone who wants proof — the corpus + nine real OSS runs, misses included | dark "blueprint" |
| **Showcase** | `showcase.html` | a live demo — two popular projects scanned cold, the real findings | dark "blueprint" |

All four run off one design system (`deck.css` + `deck.js`). Engineering is 12
slides (~12–15 min); eng deep-dive is 15 slides (~15–18 min); customer is 11
slides (~10–13 min); numbers is 13 slides (~12–15 min).

`engineering.html` and `engineering-deep.html` are companions, not duplicates:
the first is the conceptual *what the machine does* (the five stages, the two
passes, the discipline); the second is the *how we built it* — each hard problem
stated, then the approach, then the solution we shipped (source-tracing, the
resolution ladder, the conservatism guards, the react-admin 22→1 case study, the
determinism boundary). The numbers deck is the superset proof — its data covers
the leadership (moat), engineering (validation), and customer (real-project)
angles in one telling, so it doesn't fork into separate audience cuts.

Every figure in `numbers.html` is sourced from the feature dir's `evidence.md`
(corpus) and `oss-targets.md` (the OSS scorecard). If those measurements are
re-run, update the deck's stat blocks, the inversion bars, and the scorecard table.

## Present

Double-click either `.html` file, or serve the folder and open it:

```
cd packages/a11y-checker/docs/decks
python3 -m http.server 8080      # then open http://localhost:8080/customer.html
```

Press **F11** for full screen.

### Keys

| Key | Action |
|-----|--------|
| `→` `Space` `PageDown` | next slide |
| `←` `PageUp` | previous slide |
| `Home` / `End` | first / last |
| `O` or `Esc` | contents overview (then `1`–`9` to jump, or click) |
| `1`–`9` | jump to that slide |

The URL tracks the slide (`…/customer.html#5`), so you can deep-link or refresh
without losing your place. Swipe works on touch screens.

## The anchor line

> **Audits find what shipped. The checker stops it shipping.**

It's on the customer title slide and reused at "where it fits." If someone forgets
every other line, they repeat that one.

## Editing

- **Copy** lives directly in the HTML — each slide is a `<section class="slide">`
  with a headline (`h2`) and spoken paragraphs (`p.spoken`). Edit in place.
- **Look** lives in `deck.css` (one token system, two themes via `data-theme`).
- **Behaviour** (keys, focus, the live region) lives in `deck.js` — shared, no deps.
- Keep each slide's `data-title` in sync with its headline; it drives the contents
  overview and the screen-reader slide announcement.

## Accessibility

The decks are built to the standard the product sells: semantic headings, one
`h1` each, visible focus, AA contrast in both themes, status shown by glyph + word
(never color alone), a polite live region announcing each slide, `role="img"` +
`aria-label` on every code specimen and diagram, inactive slides held `inert`, and
`prefers-reduced-motion` honored. If you add a slide, keep that bar.
