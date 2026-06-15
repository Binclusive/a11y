import { dirname } from "node:path";
import ts from "typescript";
import { resolveImportsSubpath } from "./imports-resolve";
import { lookupRegistry } from "./registry";
import { resolveWorkspaceImport } from "./workspace-resolve";

/**
 * Source-tracing fallback: resolve a wrapper component to the single host
 * primitive it renders, by reading its definition from source.
 *
 * This is what makes the checker work on codebases we have never seen. For any
 * wrapper NOT in the registry, we resolve its import to a source file, parse
 * it, find the component definition, and answer: (a) does it render exactly one
 * host element, and (b) does it forward its props? If both hold, we infer the
 * mapping. Everything ambiguous returns null -> the component is reported
 * OPAQUE rather than mis-mapped. Honesty over coverage.
 *
 * Resolution uses the *containing file's own tsconfig* (paths / baseUrl /
 * exports), i.e. exactly the resolution the customer's build uses — never a
 * hardcoded package layout.
 */

const HOST_TAG = /^[a-z]/; // lowercase JSX name = intrinsic host element

/** How many wrapper hops we follow before giving up (wrapper-of-wrapper). */
const MAX_DEPTH = 3;

/**
 * The Radix module whose `Slot` is the polymorphic pass-through primitive. The
 * shadcn convention `asChild ? <Slot {...props}/> : <button {...props}/>` makes
 * `Slot` a TRANSPARENT branch: when `asChild` is set the wrapper renders AS its
 * own child, so the only fixed accessible host it can be is the OTHER branch
 * (`button`). We identify it by its import origin, never by the bare name
 * `Slot` — a repo can name something else `Slot`, and only the Radix one has
 * this pass-through semantics.
 */
const RADIX_SLOT_MODULE = "@radix-ui/react-slot";

/**
 * tsconfig-aware module resolver, cached per containing-directory so we parse
 * each tsconfig once. Mirrors how the customer's own toolchain resolves
 * imports.
 */
function makeResolver(): (specifier: string, fromFile: string) => string | null {
  const optionsCache = new Map<string, ts.CompilerOptions>();
  const baseOptions: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    allowJs: true,
  };
  const host = ts.createCompilerHost(baseOptions);

  function optionsFor(fromFile: string): ts.CompilerOptions {
    const dir = dirname(fromFile);
    const cfgPath = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json");
    const cacheKey = cfgPath ?? "<none>";
    const cached = optionsCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let opts = baseOptions;
    if (cfgPath !== undefined) {
      const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
      if (read.config !== undefined) {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(cfgPath));
        // Keep the customer's `baseUrl` + `paths` (so `@/...` aliases resolve)
        // but NEVER let their `moduleResolution` downgrade ours. Many real
        // configs omit it or set a legacy value ("None"/"Classic"); honoring
        // that would disable `node_modules` and `exports` resolution entirely,
        // making every package import opaque. We always resolve with Bundler.
        opts = {
          ...parsed.options,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          module: ts.ModuleKind.ESNext,
          allowJs: true,
        };
      }
    }
    optionsCache.set(cacheKey, opts);
    return opts;
  }

  return (specifier, fromFile) => {
    const opts = optionsFor(fromFile);
    const resolved = ts.resolveModuleName(specifier, fromFile, opts, host);
    return resolved.resolvedModule?.resolvedFileName ?? null;
  };
}

const resolve = makeResolver();

/**
 * Resolve an import specifier to a source file path, relative to `fromFile`.
 *
 * Three layers, in order:
 *   1. tsconfig-aware TS resolution — handles relative imports, `@/...` path
 *      aliases, and packages present in an installed `node_modules`.
 *   2. workspace resolution — follows a `@scope/pkg/subpath` import to the real
 *      source under `packages/*` via the monorepo's workspace config, for the
 *      common case where the design system is an un-built workspace package
 *      (and may not be symlinked into `node_modules` at all).
 *   3. package.json `imports` subpaths — follows a `#`-prefixed internal import
 *      (`#app/components/button`) to own-code source via the nearest
 *      package.json's `imports` map. TS resolves a `#`-import only when it
 *      carries an explicit extension; the bare extensionless form (the common
 *      one) falls through to here, the third own-code alias source alongside
 *      tsconfig `paths`.
 *
 * Returns `null` only when no layer can reach real source (a bare external
 * dependency with no types on disk, etc.) — the caller then keeps the wrapper
 * opaque rather than guessing.
 */
export function resolveRoute(specifier: string, fromFile: string): string | null {
  const viaTs = resolve(specifier, fromFile);
  if (viaTs !== null) return viaTs;
  const viaWorkspace = resolveWorkspaceImport(specifier, fromFile);
  if (viaWorkspace !== null) return viaWorkspace;
  return resolveImportsSubpath(specifier, fromFile);
}

/** What a local JSX name was imported as. */
export interface ImportBinding {
  /** Module specifier it came from. */
  readonly module: string;
  /**
   * The exported name being referenced. For `import { Button }` -> "Button";
   * for `import X` (default) -> "default"; for `import * as NS` the binding is
   * the namespace and `member` carries the accessed member (`NS.Root`).
   */
  readonly imported: string;
  /** Namespace import flag; member access (`NS.Root`) is resolved by the caller. */
  readonly isNamespace: boolean;
}

const fileCache = new Map<string, ts.SourceFile | null>();

function readSource(filePath: string): ts.SourceFile | null {
  const cached = fileCache.get(filePath);
  if (cached !== undefined) return cached;
  const text = ts.sys.readFile(filePath);
  const sf =
    text === undefined
      ? null
      : ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  fileCache.set(filePath, sf);
  return sf;
}

/**
 * Collect every imported binding in a source file, keyed by the LOCAL name as
 * used in JSX. Namespace imports key on the namespace identifier; the resolver
 * pairs them with the accessed member.
 */
export function collectLocalImports(sf: ts.SourceFile): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const module = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (clause === undefined) continue;

    // Default import: `import X from "mod"`
    if (clause.name !== undefined) {
      out.set(clause.name.text, { module, imported: "default", isNamespace: false });
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      // `import * as NS from "mod"`
      out.set(bindings.name.text, { module, imported: "*", isNamespace: true });
    } else if (ts.isNamedImports(bindings)) {
      // `import { A, B as C } from "mod"`
      for (const el of bindings.elements) {
        const local = el.name.text;
        const imported = el.propertyName?.text ?? local;
        out.set(local, { module, imported, isNamespace: false });
      }
    }
  }
  return out;
}

/**
 * Local JSX names that render AS their child (carry no fixed host), drawn from
 * a file's import map. Today that is exactly the Radix `Slot`, identified by
 * its import from {@link RADIX_SLOT_MODULE} — never by the bare name. Both the
 * named (`import { Slot } from "@radix-ui/react-slot"`) and namespace
 * (`import * as SlotPrimitive from "@radix-ui/react-slot"` → `SlotPrimitive.Root`)
 * spellings reduce to the local identifier the JSX tag uses, so the tag set can
 * test membership directly.
 */
function transparentLocalNames(imports: ReadonlyMap<string, ImportBinding>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [local, binding] of imports) {
    if (binding.module === RADIX_SLOT_MODULE) out.add(local);
  }
  return out;
}

/**
 * Result of tracing a wrapper: the host primitive plus how we found it, and the
 * explicit ARIA `role` the host carries when one is statically set.
 *
 * `role` is the library's INTERNAL role on the rendered host — captured from a
 * static `role="…"` string literal on the traced host JSX, or supplied by a
 * registry rule for a known toggle primitive (Radix `Checkbox` → `button` with
 * `role="checkbox"`). It exists so a traced toggle (host `button`/`input`, role
 * `checkbox`/`switch`/`radio`) is not mistaken for a bare button/input
 * downstream. Absent (a dynamic or missing role) ⇒ the host's implicit role;
 * nothing changes. Only toggle roles are acted on by consumers.
 */
export interface TraceResult {
  readonly host: string;
  readonly via: "registry" | "trace";
  readonly role?: string;
  /**
   * Whether the wrapper's own render body gives the host a STATIC accessible
   * name — captured by scanning the returned JSX for a literal `aria-label`/
   * `aria-labelledby` on the host, an `sr-only` / visually-hidden span with
   * static text, or static (non-icon) text children. The name lives INSIDE the
   * wrapper, invisible at the self-closing call site, so a host-strength control
   * with no call-site name is NOT actually nameless — downstream skips the
   * no-name check, exactly as a toggle role is skipped.
   *
   * Conservative: only a CLEARLY static name sets it true; anything uncertain
   * (dynamic expression, icon-only child) leaves it false. A registry hit has no
   * source to scan, so it is always false (registries map only leaf primitives).
   * False-negative-safe — it can only ADD suppression, never a new finding.
   */
  readonly rendersOwnName: boolean;
}

/**
 * The JSX element a component ultimately renders, plus whether it spreads
 * props. `tag` is the literal/identifier of the single returned root element.
 * `role` is a STATIC `role="…"` string literal on the single host element, when
 * one is set — threaded out so a homegrown `<button role="checkbox">` toggle is
 * recognized as a toggle, not a bare button.
 */
interface RenderShape {
  /** Distinct root element tag names returned across all return paths. */
  readonly tags: ReadonlySet<string>;
  readonly spreadsProps: boolean;
  /** Static `role` literal on the (single) host element, or `null`. */
  readonly role: string | null;
  /**
   * Whether the (single) host element is given a STATIC accessible name by the
   * wrapper's own render body — a literal `aria-label`/`aria-labelledby`, an
   * `sr-only`/visually-hidden span with static text, or static non-icon text
   * children. Conservative: only a clear static name sets it true.
   */
  readonly rendersOwnName: boolean;
}

/**
 * The static `role` string literal on an opening element, or `null` for an
 * absent, empty, or DYNAMIC role (`role={x}`). Only a literal counts — a dynamic
 * role is unknowable, so per "uncertain → skip" it changes nothing.
 */
function staticRoleOf(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string | null {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    // `role` is a plain identifier attribute, never an `ns:name` form.
    if (!ts.isIdentifier(attr.name) || attr.name.text !== "role") continue;
    const init = attr.initializer;
    if (init === undefined) return null;
    if (ts.isStringLiteral(init)) return init.text.trim() === "" ? null : init.text;
    if (
      ts.isJsxExpression(init) &&
      init.expression !== undefined &&
      ts.isStringLiteral(init.expression)
    ) {
      return init.expression.text.trim() === "" ? null : init.expression.text;
    }
    return null; // dynamic/computed role — unknowable
  }
  return null;
}

/**
 * Whether the opening element carries a STATIC, non-empty `aria-label` or
 * `aria-labelledby` string literal — a directly-readable accessible name on the
 * host. A dynamic value (`aria-label={x}`) is unknowable, so per "uncertain →
 * skip" it does NOT count as a captured static name here.
 */
function hasStaticAriaName(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (!ts.isIdentifier(attr.name)) continue;
    if (attr.name.text !== "aria-label" && attr.name.text !== "aria-labelledby") continue;
    const init = attr.initializer;
    if (init === undefined) continue; // boolean-ish attr, no value to read
    if (ts.isStringLiteral(init)) {
      if (init.text.trim() !== "") return true;
      continue;
    }
    if (
      ts.isJsxExpression(init) &&
      init.expression !== undefined &&
      ts.isStringLiteral(init.expression) &&
      init.expression.text.trim() !== ""
    ) {
      return true;
    }
    // dynamic / computed — unknowable, keep looking for another static name
  }
  return false;
}

/** Visually-hidden utility class names that carry an accessible name in text. */
const VISUALLY_HIDDEN_CLASS = /(^|\s)(sr-only|visually-hidden|visuallyhidden|screen-reader-only)(\s|$)/;

/**
 * Whether an element's `className` is a static string literal containing a
 * visually-hidden utility class (`sr-only`, `visually-hidden`, …). Only a
 * literal counts — a dynamic `className={cn(...)}` is unknowable.
 */
function hasVisuallyHiddenClass(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (!ts.isIdentifier(attr.name) || attr.name.text !== "className") continue;
    const init = attr.initializer;
    if (init === undefined) return false;
    if (ts.isStringLiteral(init)) return VISUALLY_HIDDEN_CLASS.test(init.text);
    if (
      ts.isJsxExpression(init) &&
      init.expression !== undefined &&
      ts.isStringLiteral(init.expression)
    ) {
      return VISUALLY_HIDDEN_CLASS.test(init.expression.text);
    }
    return false;
  }
  return false;
}

/** Whether a JSX child is a static, non-empty text node. */
function isStaticTextChild(child: ts.JsxChild): boolean {
  return ts.isJsxText(child) && child.text.trim() !== "";
}

/**
 * Whether an element renders an internal STATIC accessible name. Scans the
 * element's direct children for:
 *   - a nested element with a visually-hidden class (`<span className="sr-only">
 *     Previous slide</span>`) that carries static text, OR
 *   - a direct static text child (`<button>Save</button>`) that is real,
 *     visible label text.
 * An icon-only child (`<ChevronLeft/>`) or a dynamic expression child carries no
 * static name and is ignored. Conservative by construction: anything unreadable
 * leaves the result false.
 */
function rendersStaticNameInChildren(element: ts.JsxElement): boolean {
  for (const child of element.children) {
    if (isStaticTextChild(child)) return true;
    if (ts.isJsxElement(child)) {
      const opening = child.openingElement;
      // A visually-hidden span whose text is static → that text is the name.
      if (hasVisuallyHiddenClass(opening) && child.children.some(isStaticTextChild)) return true;
    }
  }
  return false;
}

/**
 * Whether the host element (and its subtree) is given a clear STATIC accessible
 * name by the wrapper: a literal `aria-label`/`aria-labelledby` on the host, or
 * a static name rendered in its children (sr-only span / visible text). Used
 * only for an actual JSX ELEMENT host; a self-closing host has no children and
 * relies on the aria attributes alone.
 */
function rendersOwnNameOf(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  if (hasStaticAriaName(opening)) return true;
  if (ts.isJsxElement(node)) return rendersStaticNameInChildren(node);
  return false;
}

/** Find the JSX element name of a returned/rendered expression. */
function jsxTagOf(expr: ts.Expression): {
  tag: string | null;
  spreads: boolean;
  role: string | null;
  rendersOwnName: boolean;
} {
  let node: ts.Node = expr;
  // Unwrap parens.
  while (ts.isParenthesizedExpression(node)) node = node.expression;

  let opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null = null;
  let element: ts.JsxElement | ts.JsxSelfClosingElement | null = null;
  if (ts.isJsxElement(node)) {
    opening = node.openingElement;
    element = node;
  } else if (ts.isJsxSelfClosingElement(node)) {
    opening = node;
    element = node;
  }
  if (opening === null || element === null) {
    return { tag: null, spreads: false, role: null, rendersOwnName: false };
  }

  const tagNode = opening.tagName;
  const tag = ts.isIdentifier(tagNode)
    ? tagNode.text
    : ts.isPropertyAccessExpression(tagNode) && ts.isIdentifier(tagNode.expression)
      ? // `LabelPrimitive.Root` -> keep the namespaced form so the tracer can
        // resolve the namespace import AND know which member was rendered.
        `${tagNode.expression.text}.${tagNode.name.text}`
      : null;

  const spreads = opening.attributes.properties.some((p) => ts.isJsxSpreadAttribute(p));
  return { tag, spreads, role: staticRoleOf(opening), rendersOwnName: rendersOwnNameOf(element) };
}

/**
 * Walk a function/arrow body and collect the JSX root tags it returns and
 * whether any of them spread props. Handles:
 *   - arrow with expression body: `(props) => <x {...props}/>`
 *   - block body with `return <x .../>`
 *   - `const Comp = cond ? "tag" : Other; return <Comp .../>` — resolves the
 *     variable to its string-literal host when one branch is a literal tag.
 *
 * `transparentTags` are local names that render AS their child and therefore
 * carry no fixed host (the Radix `Slot`). They are dropped from the collected
 * set, so the canonical shadcn `asChild ? <Slot/> : <button/>` collapses from
 * `{Slot, button}` to `{button}` and resolves instead of going opaque. A
 * GENUINELY composite component (`{div, span}` with no Slot) keeps both tags
 * and stays opaque — only the pass-through primitive is removed.
 */
function renderShapeOf(
  fn: ts.FunctionLikeDeclaration,
  transparentTags: ReadonlySet<string>,
): RenderShape {
  const tags = new Set<string>();
  let spreadsProps = false;
  // Static `role` literal on a recorded host element, when exactly one is seen.
  // Stays meaningful only for a single-host shape (the conservative gate), which
  // is the only shape the tracer resolves anyway.
  let role: string | null = null;
  // Whether the recorded host branch gives the host a static accessible name in
  // the wrapper's own body. Like `role`, meaningful only for the single-host
  // shape we resolve. Sticky-true once any host branch renders a name.
  let rendersOwnName = false;
  // Local `const Comp = ... "tag" ...` literal hosts, so `<Comp/>` resolves.
  const localHostVars = new Map<string, string>();

  const body = fn.body;
  if (body === undefined) return { tags, spreadsProps, role, rendersOwnName };

  function recordExpr(expr: ts.Expression): void {
    const { tag, spreads, role: exprRole, rendersOwnName: exprName } = jsxTagOf(expr);
    if (tag === null) return;
    // Resolve a local polymorphic variable (`Comp`) to its literal host.
    const resolved = localHostVars.get(tag) ?? tag;
    // A transparent pass-through (Radix Slot) carries no host of its own —
    // skip it so the sibling host branch is the wrapper's resolved host. The
    // namespace form `<SlotPrimitive.Root/>` keys on the namespace local
    // (before the dot), so test that too.
    const localOfTag = resolved.includes(".") ? resolved.slice(0, resolved.indexOf(".")) : resolved;
    if (transparentTags.has(resolved) || transparentTags.has(localOfTag)) {
      if (spreads) spreadsProps = true;
      return;
    }
    tags.add(resolved);
    // Carry the role of the (host) branch. With a single host — the only shape
    // we resolve — there is exactly one role to carry.
    if (exprRole !== null) role = exprRole;
    // Carry whether the (host) branch renders its own static accessible name.
    if (exprName) rendersOwnName = true;
    if (spreads) spreadsProps = true;
  }

  // Arrow with expression body.
  if (!ts.isBlock(body)) {
    recordExpr(body);
    return { tags, spreadsProps, role, rendersOwnName };
  }

  // Collect local host-variable assignments first (e.g. asChild ? Slot : "button").
  for (const stmt of body.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
      const init = decl.initializer;
      if (ts.isConditionalExpression(init)) {
        for (const branch of [init.whenTrue, init.whenFalse]) {
          if (ts.isStringLiteral(branch)) localHostVars.set(decl.name.text, branch.text);
        }
      } else if (ts.isStringLiteral(init)) {
        localHostVars.set(decl.name.text, init.text);
      }
    }
  }

  // Then collect returned JSX.
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      recordExpr(node.expression);
    }
    // Do not descend into nested function bodies — their returns aren't ours.
    if (ts.isFunctionLike(node) && node !== fn) return;
    ts.forEachChild(node, visit);
  };
  for (const stmt of body.statements) visit(stmt);

  return { tags, spreadsProps, role, rendersOwnName };
}

/** Extract the component function for an exported name from a source file. */
function findComponentFn(sf: ts.SourceFile, exportName: string): ts.FunctionLikeDeclaration | null {
  let result: ts.FunctionLikeDeclaration | null = null;

  const target = exportName === "default" ? null : exportName;

  for (const stmt of sf.statements) {
    // `export function Name() {}` or `function Name() {}`
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) {
      if (target !== null && stmt.name.text === target) return stmt;
    }
    // `const Name = (...) => ...` or `const Name = forwardRef(...)`
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
        if (target !== null && decl.name.text !== target) continue;
        const fn = unwrapToFunction(decl.initializer);
        if (fn !== null) {
          if (target !== null) return fn;
          result = fn;
        }
      }
    }
  }
  return result;
}

/**
 * Where an export name is RE-EXPORTED from, resolved from a barrel file. A
 * monorepo design system commonly publishes a barrel
 * (`@calcom/ui/components/button` -> `index.ts`) that only re-exports:
 *
 *   export { Button } from "./Button";        // named, possibly `as`
 *   export * from "@calcom/ui-core";          // star (re-exports everything)
 *
 * The component DEFINITION lives one (or more) hops away, so a tracer that
 * stops at the barrel reports the wrapper opaque. This finds the next hop.
 */
interface ReExportHop {
  /** Module specifier to follow (relative to the barrel file). */
  readonly module: string;
  /** Export name to look up in that module (`default` / the original name). */
  readonly exportName: string;
}

/**
 * Find every place `exportName` could be re-exported FROM in a barrel file.
 *
 *   - named re-export `export { Button } from "./x"` / `{ B as Button }` — the
 *     hop's `exportName` is the ORIGINAL name in `./x` (before the `as`).
 *   - star re-export `export * from "./y"` — `exportName` is unknown at the
 *     barrel, so every star target is a candidate carrying the SAME name.
 *
 * Named matches come first (deterministic); star targets are appended as
 * fallbacks. An empty result means the name isn't re-exported here.
 */
function findReExports(sf: ts.SourceFile, exportName: string): ReExportHop[] {
  const named: ReExportHop[] = [];
  const stars: ReExportHop[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (spec === undefined || !ts.isStringLiteral(spec)) continue; // not a re-export
    const module = spec.text;
    const clause = stmt.exportClause;
    if (clause === undefined) {
      // `export * from "mod"` — the name (if exported) keeps its identity.
      stars.push({ module, exportName });
      continue;
    }
    if (ts.isNamedExports(clause)) {
      for (const el of clause.elements) {
        // `export { Orig as Public }` -> el.name = Public, el.propertyName = Orig.
        const publicName = el.name.text;
        if (publicName !== exportName) continue;
        const original = el.propertyName?.text ?? publicName;
        named.push({ module, exportName: original });
      }
    }
    // `export * as NS from "mod"` (namespace re-export) doesn't expose a single
    // component name we can trace — skip it.
  }
  return [...named, ...stars];
}

/**
 * Unwrap a component initializer to its function-like node. Handles bare
 * arrow/function expressions and `forwardRef(fn)` / `memo(fn)` wrappers.
 */
function unwrapToFunction(expr: ts.Expression): ts.FunctionLikeDeclaration | null {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return expr;
  if (ts.isCallExpression(expr)) {
    // forwardRef(fn) / memo(fn) / React.forwardRef(fn) — first fn arg is the component.
    const fnArg = expr.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    if (fnArg !== undefined && (ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg))) {
      return fnArg;
    }
  }
  return null;
}

/**
 * Trace a wrapper component to its single host primitive.
 *
 * @param specifier  module the wrapper is imported from (relative to `fromFile`)
 * @param exportName the imported export name (`default`, `Button`, `Root`, ...)
 * @param fromFile   the file doing the importing (for resolution context)
 */
export function traceComponent(
  specifier: string,
  exportName: string,
  fromFile: string,
  depth = 0,
  reExportDepth = 0,
): TraceResult | null {
  // Registry first — deterministic, no source needed. Carry the registry's
  // toggle `role` (Radix Checkbox/Switch, antd Switch) so the host isn't read
  // as a bare button/input downstream.
  const reg = lookupRegistry(specifier, exportName);
  // A registry hit maps a leaf primitive and has no source body to scan, so it
  // never carries an internally-rendered name.
  if (reg !== null) return { host: reg.host, via: "registry", role: reg.role, rendersOwnName: false };

  if (depth >= MAX_DEPTH) return null;

  const defFile = resolveRoute(specifier, fromFile);
  if (defFile === null) return null;

  const sf = readSource(defFile);
  if (sf === null) return null;

  const fn = findComponentFn(sf, exportName);
  if (fn === null) {
    // No local definition here. The file may be a barrel that re-exports the
    // component from elsewhere (`export { Button } from "./Button"` / `export *
    // from "@scope/core"`). Follow each re-export hop to the real definition.
    // Bounded by its own budget so a deep barrel chain can't loop forever and
    // doesn't starve the wrapper-render hop budget.
    if (reExportDepth >= MAX_DEPTH) return null;
    for (const hop of findReExports(sf, exportName)) {
      const traced = traceComponent(hop.module, hop.exportName, defFile, depth, reExportDepth + 1);
      if (traced !== null) return traced;
    }
    return null;
  }

  const defImports = collectLocalImports(sf);
  const transparentTags = transparentLocalNames(defImports);
  const shape = renderShapeOf(fn, transparentTags);

  // Conservative gate: exactly one distinct root tag, and props are forwarded.
  if (shape.tags.size !== 1 || !shape.spreadsProps) return null;
  const [tag] = [...shape.tags];

  // Intrinsic host element -> done. Carry a static `role="…"` literal on it
  // (e.g. a homegrown `<button role="checkbox">` toggle) so it isn't mistaken
  // for a bare button/input downstream. `undefined` when no static role. Carry
  // `rendersOwnName` too: a host given a static name in the wrapper's body
  // (sr-only span / aria-label / text child) is named, not a nameless control.
  if (HOST_TAG.test(tag)) {
    return {
      host: tag,
      via: "trace",
      role: shape.role ?? undefined,
      rendersOwnName: shape.rendersOwnName,
    };
  }

  // The wrapper renders ANOTHER component. Resolve its import within the
  // definition file and recurse one hop. Two shapes:
  //   - plain identifier `<Other .../>`            -> look up "Other"
  //   - namespace member `<NS.Member .../>` (Radix) -> look up "NS", trace "Member"
  const dotIndex = tag.indexOf(".");
  const localName = dotIndex === -1 ? tag : tag.slice(0, dotIndex);
  const member = dotIndex === -1 ? null : tag.slice(dotIndex + 1);

  const inner = defImports.get(localName);
  if (inner === undefined) return null;

  // For a namespace import the export we trace is the accessed member; for a
  // named/default import it's whatever name it was imported under.
  const innerExport = inner.isNamespace ? member : inner.imported;
  if (innerExport === null) return null;

  const innerResult = traceComponent(inner.module, innerExport, defFile, depth + 1);
  if (innerResult === null) return null;
  // The role comes from this wrapper's static `role="…"` on the inner element if
  // it set one (`<CheckboxPrimitive.Root role="checkbox" …>`); otherwise inherit
  // the inner component's role (the Radix-registry toggle role on the primitive).
  const role = shape.role ?? innerResult.role;
  // The name can live at EITHER hop: this wrapper may render the name itself
  // (the shadcn carousel — `CarouselPrevious` puts the `sr-only` span around an
  // inner `<Button>`), or the inner component may already render it. A name at
  // either level means the resolved host is named, so OR them.
  const rendersOwnName = shape.rendersOwnName || innerResult.rendersOwnName;
  return { host: innerResult.host, via: innerResult.via, role, rendersOwnName };
}

/**
 * The local identifier a `const X = …` VALUE alias points at, when `X` is bound
 * to a bare identifier or a member access — NOT a function. The shadcn barrel
 * convention re-publishes a primitive as `const Dialog = DialogPrimitive.Root`
 * (member) or `const Toaster = Sonner` (identifier); both are value aliases whose
 * identity IS the thing on the right. Returns the LEFTMOST identifier (`DialogPrimitive`,
 * `Sonner`) so the caller can resolve it through the file's import map. Returns
 * `null` for a function/arrow/`forwardRef(…)` initializer — that is a real
 * component definition, handled by {@link findComponentFn}, not an alias.
 */
function findValueAlias(sf: ts.SourceFile, exportName: string): string | null {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== exportName) continue;
      const init = decl.initializer;
      if (init === undefined) continue;
      // `const X = Other`
      if (ts.isIdentifier(init)) return init.text;
      // `const X = NS.Member` (or `NS.Member.Sub`) -> leftmost identifier `NS`.
      if (ts.isPropertyAccessExpression(init)) {
        let expr: ts.Expression = init;
        while (ts.isPropertyAccessExpression(expr)) expr = expr.expression;
        if (ts.isIdentifier(expr)) return expr.text;
      }
    }
  }
  return null;
}

/**
 * The ORIGIN module a THIN own-code wrapper ultimately aliases — so the coverage
 * classifier can bucket a local `@/components/ui/*` barrel by where its primitive
 * REALLY comes from, not by the `@/…` import string it happens to wear.
 *
 * `traceComponent` answers "what host does this render?" and returns null for a
 * host-LESS container primitive (`Dialog`, `Select` — context providers with no
 * DOM element). Those land in `declare` even though they are guaranteed Radix
 * underneath. This answers the narrower question that fixes that: "what module
 * does this wrapper pass through to?", returning e.g. `@radix-ui/react-dialog`.
 *
 * THIN — and ONLY thin — resolves, so an app composite is NEVER wrongly vouched
 * for:
 *   - value alias `const Dialog = DialogPrimitive.Root` -> the namespace's module;
 *   - single-tag, props-forwarding wrapper `forwardRef((p,r) => <X.Title {...p}/>)`
 *     (the same gate {@link traceComponent} uses) -> the inner element's module;
 *   - barrel re-export `export { Dialog } from "@scope/x"` -> that module.
 *
 * A multi-element render (Portal + Overlay + Content) is not thin -> `null`: it
 * stays an opaque unknown, exactly where a genuine composite belongs. Bounded by
 * {@link MAX_DEPTH} so an alias/wrapper chain can't loop.
 *
 * @param specifier  module the wrapper is imported from (relative to `fromFile`)
 * @param exportName the imported export name (`Dialog`, `Toaster`, …)
 * @param fromFile   the file doing the importing (resolution context)
 */
export function traceWrapperOrigin(
  specifier: string,
  exportName: string,
  fromFile: string,
  depth = 0,
): string | null {
  if (depth >= MAX_DEPTH) return null;

  const defFile = resolveRoute(specifier, fromFile);
  if (defFile === null) return null;
  const sf = readSource(defFile);
  if (sf === null) return null;

  const imports = collectLocalImports(sf);

  // (a) value alias: `const X = NS.Member` / `const X = Other`. Its identity is
  // whatever it points at — resolve that local to its import, else hop locally.
  const aliasLocal = findValueAlias(sf, exportName);
  if (aliasLocal !== null) {
    const inner = imports.get(aliasLocal);
    if (inner !== undefined) return inner.module;
    return traceWrapperOrigin(specifier, aliasLocal, fromFile, depth + 1);
  }

  const fn = findComponentFn(sf, exportName);
  if (fn === null) {
    // (c) barrel re-export: `export { X } from "mod"`. An external `mod` IS the
    // origin; an own-code `mod` is one more hop toward it.
    for (const hop of findReExports(sf, exportName)) {
      if (resolveRoute(hop.module, defFile) === null) return hop.module;
      const traced = traceWrapperOrigin(hop.module, hop.exportName, defFile, depth + 1);
      if (traced !== null) return traced;
    }
    return null;
  }

  // (b) thin single-tag forwarding wrapper. Same conservative gate traceComponent
  // applies — exactly one root tag, props forwarded — but here we want the inner
  // element's MODULE (the host-less primitive traceComponent couldn't map).
  const shape = renderShapeOf(fn, transparentLocalNames(imports));
  if (shape.tags.size !== 1 || !shape.spreadsProps) return null;
  const [tag] = [...shape.tags];
  // An intrinsic host (`<button>`) is a real host traceComponent already maps to
  // `checked`; it never reaches the opaque path, so it is not an origin alias.
  if (HOST_TAG.test(tag)) return null;
  const dot = tag.indexOf(".");
  const local = dot === -1 ? tag : tag.slice(0, dot);
  const inner = imports.get(local);
  if (inner !== undefined) return inner.module;
  return traceWrapperOrigin(specifier, local, fromFile, depth + 1);
}
