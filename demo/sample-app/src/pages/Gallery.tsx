// Gallery page — INTRINSIC bugs the cold scan catches with ZERO config.
// Every element here is a raw HTML host, so jsx-a11y inspects it directly
// without needing the design system declared.
import { TrashIcon } from "lucide-react";

export function Gallery() {
  return (
    <main>
      <h1>Photo gallery</h1>

      {/* BUG: raw <img> with no alt — 1.1.1 Non-text Content */}
      <img src="/photos/sunset.jpg" />

      {/* BUG: raw <a href="#"> — anchor-is-valid, a link that goes nowhere */}
      <a href="#">Read more</a>

      {/* A raw icon-only <button>. jsx-a11y leaves it alone (it can't prove the
          icon child renders no text), so this one is a deliberate near-miss the
          checker does NOT flag — a reminder that zero-FP discipline cuts both
          ways. The @acme/ui IconButton version in SettingsForm.tsx IS flagged. */}
      <button onClick={() => undefined}>
        <TrashIcon />
      </button>

      {/* CORRECT: a labelled image — zero false positive expected */}
      <img src="/photos/team.jpg" alt="The Acme team at the 2025 offsite" />

      {/* CORRECT: a labelled button — zero false positive expected */}
      <button onClick={() => undefined}>
        Delete selected
      </button>
    </main>
  );
}
