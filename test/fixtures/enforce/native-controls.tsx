// Native form-control coverage (issue #16): a bare `<input>`/`<select>`/
// `<textarea>` with no accessible name is the real bug react-doctor catches via
// control-has-associated-label and we used to miss. The MUST-NOT cases lock the
// "tighter than react-doctor" guarantee — especially the empty <td>, the exact
// layout-cell shape react-doctor false-positives on.
export function NativeControls(props: Record<string, unknown>) {
  return (
    <form>
      {/* MUST FLAG — genuinely nameless native controls (4) */}
      <input type="text" />
      <input placeholder="Search commands…" />
      <select>
        <option>One</option>
      </select>
      <textarea />

      {/* MUST NOT — labelled / associable */}
      <input aria-label="Email" />
      <input id="phone" />
      <label>
        Full name
        <input type="text" />
      </label>

      {/* MUST NOT — name-exempt input types */}
      <input type="submit" value="Send" />
      <input type="checkbox" />
      <input type="radio" />
      <input type="hidden" />

      {/* MUST NOT — hidden / untabbable, not an announced control */}
      <input tabIndex={-1} />
      <input className="sr-only hidden" />
      <input hidden />

      {/* MUST NOT — spread could carry any name attr */}
      <input {...props} />

      {/* MUST NOT — not a control at all: the react-doctor empty-<td> FP shape */}
      <table>
        <tbody>
          <tr>
            <td className="collapse-column"></td>
            <td className="collapse-column"></td>
          </tr>
        </tbody>
      </table>
    </form>
  );
}
