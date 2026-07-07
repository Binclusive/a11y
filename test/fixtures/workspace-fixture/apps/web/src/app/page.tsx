// App-Router page in a nested src/app dir. Imports the workspace design system
// (@acme/ui/button), a path-aliased local wrapper (@/components/local-link),
// framework primitives (next/link), and SIX opaque lucide icons — so the
// design-system ranking must pick @acme/ui, not next or the icon library.
import { Button } from "@acme/ui/button";
import { Bell, Check, Home, Search, Star, User } from "lucide-react";
import Link from "next/link";
import { Trans } from "react-i18next";
import { LocalLink } from "@/components/local-link";

export default function Page() {
  return (
    <div>
      <Home />
      <Search />
      <Bell />
      <Star />
      <User />
      <Check />
      <Button>Save</Button>
      <LocalLink href="/about">About</LocalLink>
      <Link href="/home">Home</Link>
      {/* Trans-injected link — NOT empty at runtime, must NOT flag. */}
      <Trans
        i18nKey="cta"
        defaults="<0>Create an account</0> to continue"
        components={[<LocalLink href="/register" key="r" />]}
      />
      {/* Genuinely empty anchor — MUST flag. */}
      <a href="/empty" />
    </div>
  );
}
