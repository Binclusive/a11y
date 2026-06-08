/**
 * The MATRIX axes for cross-stack a11y measurement.
 *
 * The DESIGN-SYSTEM axis is the SEARCH key: each entry's `deps` are the npm
 * package names we grep for in `package.json` across GitHub. One repo can only
 * be slotted into one design system here (the one we searched it under).
 *
 * The FRAMEWORK axis is NOT searched — it is DETECTED post-clone from the
 * cloned repo's package.json (see `detectFramework`). That keeps discovery cheap
 * (one search axis) while still producing a 2-D design-system × framework grid
 * in the final report.
 */

export interface DesignSystem {
  /** Stable short key used in manifest/results/report. */
  key: string;
  /** Human label for report tables. */
  label: string;
  /** npm package names that signal this design system in a package.json. */
  deps: string[];
}

export const DESIGN_SYSTEMS: DesignSystem[] = [
  { key: "mui", label: "MUI", deps: ["@mui/material"] },
  { key: "chakra", label: "Chakra UI", deps: ["@chakra-ui/react"] },
  { key: "mantine", label: "Mantine", deps: ["@mantine/core"] },
  { key: "antd", label: "Ant Design", deps: ["antd"] },
  { key: "radix", label: "Radix UI", deps: ["@radix-ui/react-dialog"] },
  { key: "headlessui", label: "Headless UI", deps: ["@headlessui/react"] },
  { key: "reactAria", label: "React Aria", deps: ["react-aria-components"] },
  { key: "baseui", label: "Base UI", deps: ["@base-ui/react"] },
];

/** Lookup a design system by key. */
export function designSystemByKey(key: string): DesignSystem | undefined {
  return DESIGN_SYSTEMS.find((d) => d.key === key);
}

/**
 * A FRAMEWORK discovery target.
 *
 * The primary discovery axis is design-system (above). But some frameworks
 * never surface that way: a cold design-system search ranks by stars and the
 * winners skew next / react / react-router / vite-react, so remix / cra / gatsby
 * cells stay empty. This second axis searches GitHub for the FRAMEWORK's own
 * dep so those cells get filled directly.
 *
 * The checker is TSX-only and CRA/Gatsby apps skew heavily to `.jsx`, so the
 * `tsHint` query biases discovery toward TypeScript repos (it pairs the dep with
 * a `tsconfig.json` match). `own` lists the framework's own infra/monorepos to
 * skip so a search for "gatsby" doesn't just rank gatsbyjs/gatsby first.
 */
export interface FrameworkTarget {
  /** Framework key, matching a `detectFramework` return value. */
  key: string;
  /** npm package name that signals this framework in a package.json. */
  dep: string;
  /** Code-search query that biases toward TypeScript repos (over-fetch + prefer TS). */
  tsHint: string;
  /** owner/name repos to skip (the framework's own monorepo / infra). */
  own: string[];
}

export const FRAMEWORK_TARGETS: FrameworkTarget[] = [
  {
    key: "remix",
    dep: "@remix-run/react",
    tsHint: '"@remix-run/react" filename:tsconfig.json',
    own: ["remix-run/remix", "prisma/prisma-examples"],
  },
  {
    key: "gatsby",
    dep: "gatsby",
    tsHint: '"gatsby" filename:tsconfig.json',
    own: [
      "gatsbyjs/gatsby",
      "definitelytyped/definitelytyped",
      "freecodecamp/freecodecamp",
      "yarnpkg/berry",
    ],
  },
  {
    key: "cra",
    dep: "react-scripts",
    tsHint: '"react-scripts" filename:tsconfig.json',
    own: ["facebook/create-react-app", "microsoft/typescript-error-deltas"],
  },
];

/**
 * The own-monorepo of each design system — we skip these during discovery so a
 * search for "@mui/material" doesn't just rank mui's own repo first.
 * Keyed by design-system key; values are `owner/name` (lowercased) to skip.
 */
export const OWN_MONOREPOS: Record<string, string[]> = {
  mui: ["mui/material-ui", "mui/mui-x", "mui/base-ui", "mui/toolpad"],
  chakra: ["chakra-ui/chakra-ui"],
  mantine: ["mantinedev/mantine"],
  antd: ["ant-design/ant-design", "ant-design/ant-design-pro"],
  radix: ["radix-ui/primitives", "radix-ui/themes", "radix-ui/website"],
  headlessui: ["tailwindlabs/headlessui"],
  reactAria: ["adobe/react-spectrum"],
  baseui: ["mui/base-ui", "uber/baseweb"],
};

type PkgDeps = Record<string, string>;

interface PkgJson {
  dependencies?: PkgDeps;
  devDependencies?: PkgDeps;
  peerDependencies?: PkgDeps;
}

/**
 * Detect the React framework a cloned repo uses, from its package.json deps.
 *
 * Precedence is deliberate: Remix/Next ship react-router transitively, so they
 * must be checked BEFORE the bare react-router branch. Vite is checked before
 * the react-scripts (CRA) fallback. Everything else falls through to "react".
 */
export function detectFramework(pkgJson: PkgJson): string {
  const deps: PkgDeps = {
    ...(pkgJson.dependencies ?? {}),
    ...(pkgJson.devDependencies ?? {}),
    ...(pkgJson.peerDependencies ?? {}),
  };
  const has = (name: string) => Object.hasOwn(deps, name);

  if (has("next")) return "next";
  if (has("@remix-run/react")) return "remix";
  if (has("gatsby")) return "gatsby";
  if (has("react-router") || has("react-router-dom")) return "react-router";
  if (has("@vitejs/plugin-react") || has("@vitejs/plugin-react-swc")) return "vite-react";
  if (has("react-scripts")) return "cra";
  return "react";
}
