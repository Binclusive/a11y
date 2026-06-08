# a11y-checker

**Your linter can't see inside your components. This can.**

A local accessibility checker for React/TSX. It finds accessibility bugs at the
source — including inside the design-system components (`<Button>`,
`<IconButton>`, `<TextField>`) that a normal linter walks right past. It runs
entirely on your machine; nothing is uploaded.

---

## 1. Install (about a minute)

Requires **Node ≥ 20** and **pnpm**.

```bash
git clone <repo-url> a11y-checker && cd a11y-checker
pnpm install
pnpm scan path/to/your/app/src
```

Point it at any folder of `.tsx` files. That's the whole setup. Your code never
leaves the laptop — there's nothing to upload.

---

## 2. What it is

A normal accessibility linter (`eslint-plugin-jsx-a11y`) only checks the HTML it
can *see* — intrinsic `<button>`, `<input>`, `<img>`. The moment those are
wrapped in your own components, it goes blind.

a11y-checker resolves your components down to the real HTML underneath and
checks the accessible name/label you actually passed in — so it catches the
bugs that ship **inside** design systems, where other linters never look.

---

## 3. How it works

Two passes:

1. **The normal structural lint** — the same rules `eslint-plugin-jsx-a11y` runs.
2. **A call-site content check** — the part that's different. It traces your
   `<IconButton>` to the `<button>` it actually renders, then asks one question:
   *does this control have an accessible name?* An icon with no label, an input
   with only a placeholder — caught, with the fix.

```
<IconButton><TrashIcon /></IconButton>
      │  resolves to
      ▼
   <button>   ← no accessible name → a screen reader just says "button"
```

No configuration to start. Want to go deeper — teach it your own design system,
gate CI? See **[WALKTHROUGH.md](../WALKTHROUGH.md)**.

---

## 4. The killer demo — a real project

[`easy-ui`](https://github.com/DarkInventor/easy-ui) is a shadcn component kit
people install. Here's its share button, in the real repo:

```tsx
// components/ShareButtons.tsx
<Button variant="outline" size="icon" onClick={handleProfileVisit}>
  <Twitter className="h-4 w-4" />
</Button>
```

- **`eslint-plugin-jsx-a11y` (recommended): 0 problems.** The linter everyone
  runs ships this clean.
- **a11y-checker: caught it.** An icon-only button with no accessible name
  (WCAG 4.1.2). A screen reader announces only *"button"* — a blind user can't
  tell it shares to Twitter. The fix is one line: `aria-label="Share on Twitter"`.

And it isn't a one-off — across easy-ui's components (its command palette, its
launchpad toggle, its share buttons), every icon-only button is nameless, and
`eslint-plugin-jsx-a11y` passed every single one.

![a11y-checker vs eslint-plugin-jsx-a11y on easy-ui](killer.gif)

> Run it yourself: `pnpm demo:play demo/scenario.killer.json` (live), or
> `pnpm demo:record demo/scenario.killer.json` (re-render the GIF).

---

## 5. Next step

Gate it in CI — `scan` exits non-zero on a blocking finding:

```bash
pnpm scan ./src    # exit 1 = found a blocking accessibility bug
```

To adopt it with your own design system (one config file, then it catches bugs
*inside* your components too), follow **[WALKTHROUGH.md](../WALKTHROUGH.md)**.
