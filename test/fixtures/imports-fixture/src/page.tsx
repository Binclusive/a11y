// Imports own-code wrappers via package.json `#`-prefixed subpath imports, the
// EXTENSIONLESS form TypeScript's own resolution can't follow. `#app/*` is a
// string `imports` value; `#lib/*` is a conditional-object value.
import { AppButton } from "#app/components/app-button";
import { AppLink } from "#lib/app-link";

export default function Page() {
  return (
    <div>
      <AppButton type="button">Save</AppButton>
      <AppLink href="/home">Home</AppLink>
    </div>
  );
}
