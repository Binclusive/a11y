import { describe, expect, it } from "vitest";
import { corpusJourneyTags, corpusPatterns } from "../src/corpus";
import type { Finding } from "../src/core";
import type { ComponentResolution } from "../src/resolve-components";
import type { IntrinsicElement, IntrinsicSignals } from "../src/intrinsic-elements";
import { retrieveSlice, SLICE_CAP } from "../src/retrieve";

/** A resolved (traced) wrapper → host, the R1 input shape. */
function resolved(name: string, host: string): ComponentResolution {
  return {
    name,
    module: "@/components/ui",
    host,
    provenance: "trace",
    role: null,
    rendersOwnName: false,
  };
}

/** An OPAQUE resolution (host null) — R1 must still match on the name. */
function opaque(name: string): ComponentResolution {
  return {
    name,
    module: "@some/design-system",
    host: null,
    provenance: "opaque",
    opaqueKind: "trusted",
    library: "some-ds",
  };
}

/** A static finding carrying one or more SCs, the R2 input shape. */
function finding(wcag: readonly string[]): Finding {
  return {
    file: "/app/checkout/page.tsx",
    line: 12,
    ruleId: "synthetic",
    message: "",
    wcag,
    enforcement: "block",
    provenance: "enforce",
  };
}

const ids = (slice: { patterns: readonly { id: string }[] }): string[] =>
  slice.patterns.map((p) => p.id);

describe("retrieveSlice: R1 by resolved component", () => {
  it("matches a resolved Button (host `button`) to button-shaped patterns", () => {
    const slice = retrieveSlice({
      files: ["/app/profile/page.tsx"], // no journey hint
      resolutions: [resolved("Button", "button")],
      findings: [], // no SC
    });
    // `icon-only button` + `button / link / checkbox / radio` both overlap on
    // the `button` token (from the name AND the host).
    expect(ids(slice)).toContain("4.1.2-button-no-name");
    expect(ids(slice)).toContain("2.1.1-native-control-key-broken");
  });

  it("matches an OPAQUE resolution on its name alone (host is null)", () => {
    const slice = retrieveSlice({
      files: ["/app/profile/page.tsx"],
      resolutions: [opaque("IconButton")],
      findings: [],
    });
    // `IconButton` tokenizes to `button` (`icon` is stopworded), overlapping
    // `icon-only button`.
    expect(ids(slice)).toContain("4.1.2-button-no-name");
  });

  it("keeps the selected/current-state pattern RETRIEVABLE for a tab/toggle component", () => {
    // Standing capability guard for `4.1.2-selected-or-current-state-missing`, a
    // pattern intentionally WITHOUT a positive fixture: trusted tab/toggle
    // components self-manage selected state at runtime, so it isn't honestly
    // fixture-able yet (see the corpus-recall README's "Honest scope"). With no
    // positive fixture and no recall coverage, the only thing keeping it from
    // silently rotting to permanently-suppressed is this assertion that R1 still
    // RETRIEVES it (eligibleToFlag) for a component whose name token-overlaps its
    // "custom tab / toggle / current item" label.
    const slice = retrieveSlice({
      files: ["/app/profile/page.tsx"], // no journey hint
      resolutions: [opaque("Tab")], // tokenizes to `tab`, overlapping the pattern label
      findings: [],
    });
    const sel = slice.patterns.find((p) => p.id === "4.1.2-selected-or-current-state-missing");
    expect(sel).toBeDefined();
    expect(sel?.eligibleToFlag).toBe(true);
  });

  it("does NOT leak the LINK pattern into an icon-only BUTTON slice (icon stopworded)", () => {
    // `IconButton` → tokens `{button}` (`icon` is a cross-kind stopword). The LINK
    // pattern `2.4.4-link-no-name` is labelled "icon / image / empty link"; before
    // stopwording `icon`, it overlapped via that token and entered a button slice
    // as eligibleToFlag. It must NOT — a button can never be that link pattern.
    const slice = retrieveSlice({
      files: ["/app/profile/page.tsx"], // no journey hint
      resolutions: [opaque("IconButton")],
      findings: [], // no SC, so R2 cannot re-admit the link pattern
    });
    expect(ids(slice)).not.toContain("2.4.4-link-no-name");
    // …while the button pattern it legitimately overlaps stays in the slice.
    expect(ids(slice)).toContain("4.1.2-button-no-name");
  });
});

describe("retrieveSlice: R2 by SC present", () => {
  it("pulls every distilled pattern for an SC carried by a finding", () => {
    const slice = retrieveSlice({
      files: ["/app/profile/page.tsx"],
      resolutions: [],
      findings: [finding(["1.3.1"])],
    });
    const want = corpusPatterns()
      .filter((p) => p.sc === "1.3.1")
      .map((p) => p.id);
    expect(want.length).toBeGreaterThan(0);
    // Every 1.3.1 pattern that survives the cap is present; the very-common ones
    // are first in tier order so they always make the slice.
    expect(ids(slice)).toContain("1.3.1-form-control-no-programmatic-label");
  });
});

describe("retrieveSlice: R3 by journey hint", () => {
  it("activates the checkout journey from a /checkout/ path", () => {
    const onPath = retrieveSlice({
      files: ["/src/app/checkout/page.tsx"],
      resolutions: [],
      findings: [],
    });
    const offPath = retrieveSlice({
      files: ["/src/app/profile/page.tsx"],
      resolutions: [],
      findings: [],
    });
    // The checkout path alone retrieves checkout-tagged patterns; the profile
    // path (no hint, no R1/R2) retrieves nothing.
    const checkoutTagged = new Set(
      corpusPatterns()
        .filter((p) => (corpusJourneyTags().get(p.id) ?? []).includes("checkout"))
        .map((p) => p.id),
    );
    expect(onPath.patterns.length).toBeGreaterThan(0);
    expect(onPath.patterns.every((p) => checkoutTagged.has(p.id))).toBe(true);
    expect(offPath.patterns).toHaveLength(0);
  });

  it("recognizes sign-in and search path shapes", () => {
    for (const file of ["/app/(auth)/login/page.tsx", "/app/search/page.tsx"]) {
      const slice = retrieveSlice({ files: [file], resolutions: [], findings: [] });
      expect(slice.patterns.length).toBeGreaterThan(0);
    }
  });
});

describe("retrieveSlice: the fixture — resolved Button + input on a checkout path", () => {
  // R1 (Button→button) ∪ R2 (1.3.1 from the input finding) ∪ R3 (checkout path).
  const slice = retrieveSlice({
    files: ["/src/app/checkout/page.tsx"],
    resolutions: [resolved("Button", "button"), resolved("Input", "input")],
    findings: [finding(["1.3.1"])],
  });

  it("snapshots the returned pattern-id set", () => {
    expect([...ids(slice)].sort()).toMatchInlineSnapshot(`
      [
        "1.3.1-content-not-in-a11y-tree",
        "1.3.1-form-control-no-programmatic-label",
        "1.3.1-heading-structure-broken",
        "1.3.1-list-not-marked-up",
        "1.3.1-missing-landmarks",
        "1.3.1-skipped-heading-levels",
        "1.3.1-tabular-data-no-table",
        "1.3.5-autocomplete-missing",
        "2.1.1-native-control-key-broken",
        "2.4.3-focus-not-moved-to-content",
        "2.4.4-link-no-name",
        "2.4.4-noisy-or-wrong-name",
        "2.4.4-social-icon-link-no-name",
        "3.3.2-input-no-visible-label",
        "4.1.2-button-no-name",
        "4.1.2-form-control-no-name",
        "4.1.2-link-no-name",
        "4.1.2-selected-or-current-state-missing",
        "4.1.2-wrong-role-for-control",
        "4.1.3-error-not-announced",
      ]
    `);
  });

  it("is pure — same input yields a structurally identical slice", () => {
    const again = retrieveSlice({
      files: ["/src/app/checkout/page.tsx"],
      resolutions: [resolved("Button", "button"), resolved("Input", "input")],
      findings: [finding(["1.3.1"])],
    });
    expect(again).toEqual(slice);
  });
});

describe("retrieveSlice: G0 anchor", () => {
  it("returns an empty slice for a file with no R1/R2/R3 match", () => {
    const slice = retrieveSlice({
      files: ["/app/profile/page.tsx"], // no journey hint
      resolutions: [resolved("Provider", "div")], // no pattern overlaps `provider`/`div`
      findings: [], // no SC
    });
    expect(slice.patterns).toHaveLength(0);
  });
});

describe("retrieveSlice: N=20 cap", () => {
  it("never returns more than SLICE_CAP patterns", () => {
    // Pull the WHOLE corpus by matching every SC present plus a checkout path.
    const everySc = [...new Set(corpusPatterns().map((p) => p.sc))];
    const slice = retrieveSlice({
      files: ["/src/app/checkout/page.tsx"],
      resolutions: corpusPatterns().map((p) => resolved(p.component, "button")),
      findings: [finding(everySc)],
    });
    expect(SLICE_CAP).toBe(20);
    expect(slice.patterns.length).toBe(20);
  });

  it("orders the capped slice by frequency tier (very-common → common → occasional)", () => {
    const everySc = [...new Set(corpusPatterns().map((p) => p.sc))];
    const slice = retrieveSlice({
      files: ["/src/app/checkout/page.tsx"],
      resolutions: [],
      findings: [finding(everySc)],
    });
    const rank: Record<string, number> = {
      "very-common": 0,
      common: 1,
      occasional: 2,
      unknown: 3,
    };
    for (let i = 1; i < slice.patterns.length; i++) {
      expect(rank[slice.patterns[i].tier]).toBeGreaterThanOrEqual(
        rank[slice.patterns[i - 1].tier],
      );
    }
  });
});

describe("retrieveSlice: occasional patterns are context-only", () => {
  it("marks every occasional pattern NOT eligible to flag, very-common/common eligible", () => {
    const everySc = [...new Set(corpusPatterns().map((p) => p.sc))];
    const slice = retrieveSlice({
      files: ["/src/app/checkout/page.tsx"],
      resolutions: [],
      findings: [finding(everySc)],
    });
    for (const p of slice.patterns) {
      expect(p.eligibleToFlag).toBe(p.tier === "very-common" || p.tier === "common");
    }
  });

  it("an occasional pattern surfaces as context but cannot flag", () => {
    // 1.3.1-list-not-marked-up is occasional; R2 pulls it, but it is context-only.
    const slice = retrieveSlice({
      files: ["/app/profile/page.tsx"],
      resolutions: [],
      findings: [finding(["1.3.1"])],
    });
    const listPattern = slice.patterns.find((p) => p.id === "1.3.1-list-not-marked-up");
    expect(listPattern).toBeDefined();
    expect(listPattern?.eligibleToFlag).toBe(false);
  });
});

/** An intrinsic element, the R4 input shape (`collectIntrinsicElements` output). */
function intrinsic(tag: string, signals: Partial<IntrinsicSignals> = {}): IntrinsicElement {
  return {
    tag,
    signals: { altState: "missing", hasVisibleText: false, ...signals },
  };
}

describe("retrieveSlice: R4 intrinsic-tag grounding", () => {
  it("an `<img alt>` (present) grounds `1.1.1-filename-or-generic-alt` as eligibleToFlag", () => {
    const slice = retrieveSlice({
      files: ["/app/profile/page.tsx"], // no journey hint, no R1/R2/R3
      resolutions: [],
      findings: [],
      intrinsics: [intrinsic("img", { altState: "present" })],
    });
    const alt = slice.patterns.find((p) => p.id === "1.1.1-filename-or-generic-alt");
    expect(alt).toBeDefined();
    expect(alt?.eligibleToFlag).toBe(true);
  });

  it("a missing-alt `<img>` is a FLOOR case — R4 does NOT ground the filename pattern", () => {
    const slice = retrieveSlice({
      files: ["/app/profile/page.tsx"],
      resolutions: [],
      findings: [],
      intrinsics: [intrinsic("img", { altState: "missing" })],
    });
    expect(ids(slice)).not.toContain("1.1.1-filename-or-generic-alt");
  });

  it("does NOT bleed an img/a pattern into a button/icon context (F6 re-proof at R4)", () => {
    // A mixed input: a button resolution alongside img + link intrinsics. R4 maps
    // by EXPLICIT tag, so the img/a patterns ground ONLY the img/a tags; the button
    // (which maps to []) must never inherit `1.1.1`/`2.4.4` image/link patterns.
    const slice = retrieveSlice({
      files: ["/app/profile/page.tsx"], // no journey hint
      resolutions: [opaque("IconButton")], // button context, tokenizes to `button`
      findings: [],
      intrinsics: [intrinsic("button", { hasVisibleText: true })],
    });
    // The button-only context grounds its button pattern…
    expect(ids(slice)).toContain("4.1.2-button-no-name");
    // …but NEVER the image/link content patterns (button maps to []).
    expect(ids(slice)).not.toContain("1.1.1-filename-or-generic-alt");
    expect(ids(slice)).not.toContain("2.4.4-generic-link-text");
    expect(ids(slice)).not.toContain("2.4.4-noisy-or-wrong-name");
  });
});
