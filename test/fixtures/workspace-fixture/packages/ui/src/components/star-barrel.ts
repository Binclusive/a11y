// A star-re-export barrel: `export *` forwards every name, so the tracer must
// follow the star target to find `StarLink` (Cal.com's `export * from
// "@calcom/ui-core"` shape).
export * from "../core/star-link";
