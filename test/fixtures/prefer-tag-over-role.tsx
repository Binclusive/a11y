// prefer-tag-over-role (#15), scoped to landmark/structural roles. The first two
// MUST flag (generic element with a native-equivalent landmark role); everything
// below MUST NOT — already-native elements, and the widget roles the stock
// jsx-a11y rule false-positives on (svg role="img" is the CORRECT accessible-SVG
// pattern, not a bug). The empty <td> is here too: never a control, never a role.
import * as React from "react";

export function RoleOverrides(props: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div>
      {/* MUST FLAG (2) */}
      <div role="region">A panel that should be a section</div>
      <span role="navigation">Nav that should be a nav</span>

      {/* MUST NOT — already the native element */}
      <section role="region">Already a section</section>
      <nav role="navigation">Already a nav</nav>

      {/* MUST NOT — widget / context roles we deliberately scope OUT */}
      <svg role="img" aria-label="Logo" />
      <div role="status">Saved</div>
      <button role="combobox">Pick one</button>
      <div role="presentation" />

      {/* MUST NOT — dynamic role value is unknowable */}
      <div role={props.role}>dynamic</div>

      {/* MUST NOT — not a control / no role: the react-doctor empty-cell shape */}
      <table>
        <tbody>
          <tr>
            <td className="collapse" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
