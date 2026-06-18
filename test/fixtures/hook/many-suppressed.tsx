// A generic-text Link (so the recall self-check fires) inside a form of MANY
// labelled inputs — each <label>…<input/></label> puts a label-ancestor
// suppressor on the input's line. With >8 suppressed lines, the hook must CAP the
// "already-named — don't flag" list rather than dump every line number.
import { Link } from "@mui/material";

export function SignupForm() {
  return (
    <form>
      <Link href="/help">click here</Link>
      <label>First<input name="first" /></label>
      <label>Last<input name="last" /></label>
      <label>Email<input name="email" /></label>
      <label>Phone<input name="phone" /></label>
      <label>Street<input name="street" /></label>
      <label>City<input name="city" /></label>
      <label>State<input name="state" /></label>
      <label>Zip<input name="zip" /></label>
      <label>Country<input name="country" /></label>
      <label>Notes<input name="notes" /></label>
    </form>
  );
}
