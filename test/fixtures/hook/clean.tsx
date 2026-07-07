// A clean component — no jsx-a11y findings AND nothing for the recall layer to
// self-check: no intrinsic <a>/<img>, and a named <button> maps to [] in R4. The
// hook must no-op on this (no floor whisper, no recall self-check). (A raw <a>
// here would now correctly draw an R4 self-check — the same advisory an imported
// descriptive <Link> already draws — so the no-op fixture avoids anchors/images.)
export function CleanPanel() {
  return (
    <section>
      <p>Welcome back.</p>
      <button type="button">Go to dashboard</button>
    </section>
  );
}
