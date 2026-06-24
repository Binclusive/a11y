/**
 * The Unity AST layer — L1 of the Unity static producer (issue #71, ADR 0004), the
 * analog of `liquid-ast.ts` for the Shopify path.
 *
 * It parses a Unity **Force-Text** serialized `.prefab` / `.unity` (scene) file — a
 * YAML 1.1 subset with Unity's `--- !u!<classID> &<fileID>` document tags — into a
 * walkable node graph the structural-absence rules (later children) reason over:
 * GameObjects, their Components, the `m_Children` transform hierarchy, and each
 * component's `m_Script` guid for identity resolution via the built-in-widget
 * registry (`unity-guid-registry.ts`).
 *
 * Two precision seams live here, both honoring the resolver's invariant — map to the
 * correct host or stay OPAQUE, never the wrong host:
 *   1. **Serialization mode.** A binary-serialized (non-Force-Text) asset is opaque
 *      by construction; we detect the absence of the `%YAML` text-mode signature and
 *      return `{ kind: "opaque", reason: "binary" }` rather than guessing. (ADR 0004.)
 *   2. **Component identity.** A component whose `m_Script` guid is a known built-in
 *      resolves to that widget; an unknown guid (a custom MonoBehaviour) resolves
 *      OPAQUE. `.meta` resolution of custom components is out of scope (ADR 0004).
 *
 * We hand-roll a line-oriented YAML subset rather than pulling a full YAML library:
 * Unity's `!u!`/`&fileID` document tags are non-standard and break standard parsers,
 * and we only need a small, well-defined field surface (object header, `m_Name`,
 * `m_GameObject`, `m_Children`, `m_Script` guid, `m_text`). One malformed file
 * returns opaque, never throws — one bad asset must not abort a whole-project scan.
 */

import { resolveWidgetGuid, type UnityWidgetKind } from "./unity-guid-registry";

/** A Unity object's stable in-file id (the `&<fileID>` anchor), as a string key. */
export type FileId = string;

/** A serialized Unity Component (Transform, MonoBehaviour, Renderer, …) attached to
 * a GameObject. Built-in native components (Transform, CanvasRenderer) carry no
 * `m_Script`; MonoBehaviours carry the `m_Script` guid we resolve identity from. */
export interface UnityComponent {
  /** This component's `&fileID` anchor. */
  readonly fileId: FileId;
  /** The Unity class id from the `!u!<classID>` document tag (e.g. 114 = MonoBehaviour). */
  readonly classId: number;
  /** The serialized type name (the first mapping key after the header, e.g.
   * "MonoBehaviour", "RectTransform"). */
  readonly typeName: string;
  /** The GameObject this component is attached to (`m_GameObject` back-link). */
  readonly gameObjectId: FileId | null;
  /** The `m_Script` guid for a MonoBehaviour, lowercased — the identity key. `null`
   * for native components (no script reference). */
  readonly scriptGuid: string | null;
  /** Child transform `fileID`s from `m_Children` (present on RectTransform/Transform). */
  readonly children: readonly FileId[];
  /** A static `m_text` literal, when present (TMP/Text accessible-name source). The
   * #70 label seam reads this; captured here so the graph is sufficient for it. */
  readonly text: string | null;
}

/** A serialized GameObject — the node the hierarchy is built from. */
export interface UnityGameObject {
  /** This GameObject's `&fileID` anchor. */
  readonly fileId: FileId;
  /** `m_Name` — the GameObject's name in the hierarchy. */
  readonly name: string;
  /** The `fileID`s of the components attached to it (`m_Component` list). */
  readonly componentIds: readonly FileId[];
  /** The resolved component objects attached to it (filled after the graph is built). */
  readonly components: readonly UnityComponent[];
}

/** The parsed node graph — GameObjects + Components, indexed by `fileID`, with the
 * transform hierarchy walkable via `childGameObjects`. */
export interface UnityGraph {
  readonly gameObjects: ReadonlyMap<FileId, UnityGameObject>;
  readonly components: ReadonlyMap<FileId, UnityComponent>;
}

/**
 * Parse outcome. A binary asset, or one we cannot parse, is OPAQUE with a reason —
 * never a partial/guessed graph (the precision invariant). The caller decides whether
 * to surface the opaque state (it must, per ADR 0004 — opaque is reported, not
 * silently skipped).
 */
export type UnityParseResult =
  | { readonly kind: "graph"; readonly graph: UnityGraph }
  | { readonly kind: "opaque"; readonly reason: "binary" | "parse-error"; readonly message?: string };

/** A component's resolved identity — a known built-in widget, or OPAQUE (a custom
 * MonoBehaviour, or a native component with no widget meaning). Never a wrong widget. */
export type ComponentIdentity =
  | { readonly kind: "widget"; readonly widget: UnityWidgetKind; readonly host: string }
  | { readonly kind: "opaque" };

/** The Force-Text signature Unity writes at the top of a text-serialized asset. Its
 * absence is the binary (non-Force-Text) tell. */
const FORCE_TEXT_SIGNATURE = "%YAML";

/**
 * Detect whether a serialized asset is Force-Text (readable YAML) or binary. Binary
 * Unity assets do not begin with the `%YAML` directive; Force-Text always does. This
 * is the one real precondition external-static analysis carries (ADR 0004) — and it
 * is detectable, so we stay opaque on binary rather than guess.
 */
export function isForceText(source: string): boolean {
  return source.trimStart().startsWith(FORCE_TEXT_SIGNATURE);
}

const HEADER_RE = /^--- !u!(\d+) &(\d+)/;
const FILEID_RE = /fileID:\s*(\d+)/;
const GUID_RE = /guid:\s*([0-9a-fA-F]{32})/;

/** Strip a trailing YAML comment and surrounding whitespace from a scalar value. */
function scalar(raw: string): string {
  return raw.replace(/\s+#.*$/, "").trim();
}

/** One raw `--- !u!N &id` document block, pre-split for field extraction. */
interface RawDoc {
  readonly classId: number;
  readonly fileId: FileId;
  readonly typeName: string;
  readonly lines: readonly string[];
}

/** Split a Force-Text source into its `--- !u!N &id` document blocks. */
function splitDocuments(source: string): RawDoc[] {
  const docs: RawDoc[] = [];
  const lines = source.split("\n");
  let current: { classId: number; fileId: FileId; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const typeName = (current.body.find((l) => /^\S/.test(l)) ?? "").replace(/:\s*$/, "").trim();
    docs.push({ classId: current.classId, fileId: current.fileId, typeName, lines: current.body });
  };

  for (const line of lines) {
    const header = HEADER_RE.exec(line);
    if (header) {
      flush();
      current = { classId: Number(header[1]), fileId: header[2]!, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return docs;
}

/** Read the `m_Children` block: every `fileID` on the `- {fileID: N}` items that
 * follow the `m_Children:` key, stopping at the next sibling key (dedent to a
 * `m_`-prefixed line). */
function readChildren(lines: readonly string[]): FileId[] {
  const out: FileId[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^\s*m_Children:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/^\s*-\s*\{fileID:/.test(line)) {
        const m = FILEID_RE.exec(line);
        if (m && m[1] !== "0") out.push(m[1]!);
        continue;
      }
      // `m_Children: []` inline, or the next key — block is over.
      break;
    }
  }
  return out;
}

/** Read the `m_Component` list: the `component: {fileID: N}` entries. */
function readComponentIds(lines: readonly string[]): FileId[] {
  const out: FileId[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^\s*m_Component:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/^\s*-\s*component:/.test(line)) {
        const m = FILEID_RE.exec(line);
        if (m && m[1] !== "0") out.push(m[1]!);
        continue;
      }
      if (/^\s*-/.test(line)) continue; // tolerate other list shapes
      break;
    }
  }
  return out;
}

/** First captured scalar for `key:` in the block, or null. */
function field(lines: readonly string[], key: string): string | null {
  const re = new RegExp(`^\\s*${key}:\\s*(.*)$`);
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return scalar(m[1] ?? "");
  }
  return null;
}

/**
 * Parse a Unity serialized asset into a node graph, or report it OPAQUE.
 *
 * Returns `{ kind: "opaque", reason: "binary" }` for a non-Force-Text asset (the
 * detectable precondition, ADR 0004), `{ kind: "opaque", reason: "parse-error" }` if
 * the text is unparseable, and `{ kind: "graph", graph }` otherwise. Never throws —
 * one bad asset must not take down a whole-project scan.
 */
export function parseUnityDocument(source: string): UnityParseResult {
  if (!isForceText(source)) {
    return { kind: "opaque", reason: "binary" };
  }

  try {
    const docs = splitDocuments(source);
    const components = new Map<FileId, UnityComponent>();
    const gameObjectsRaw = new Map<FileId, { name: string; componentIds: FileId[] }>();

    for (const doc of docs) {
      if (doc.typeName === "GameObject") {
        gameObjectsRaw.set(doc.fileId, {
          name: field(doc.lines, "m_Name") ?? "",
          componentIds: readComponentIds(doc.lines),
        });
        continue;
      }
      // Everything else is a component attached to some GameObject.
      const goLine = doc.lines.find((l) => /^\s*m_GameObject:/.test(l));
      const gameObjectId = goLine
        ? (() => {
            const m = FILEID_RE.exec(goLine);
            return m && m[1] !== "0" ? m[1]! : null;
          })()
        : null;
      const scriptLine = doc.lines.find((l) => /^\s*m_Script:/.test(l));
      const guidMatch = scriptLine ? GUID_RE.exec(scriptLine) : null;
      components.set(doc.fileId, {
        fileId: doc.fileId,
        classId: doc.classId,
        typeName: doc.typeName,
        gameObjectId,
        scriptGuid: guidMatch ? guidMatch[1]!.toLowerCase() : null,
        children: readChildren(doc.lines),
        text: field(doc.lines, "m_text"),
      });
    }

    const gameObjects = new Map<FileId, UnityGameObject>();
    for (const [fileId, raw] of gameObjectsRaw) {
      const attached = raw.componentIds
        .map((id) => components.get(id))
        .filter((c): c is UnityComponent => c != null);
      gameObjects.set(fileId, {
        fileId,
        name: raw.name,
        componentIds: raw.componentIds,
        components: attached,
      });
    }

    return { kind: "graph", graph: { gameObjects, components } };
  } catch (error) {
    return {
      kind: "opaque",
      reason: "parse-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Resolve a component's identity via the built-in-widget GUID registry. A known
 * built-in guid → that widget; an unknown guid (custom MonoBehaviour) or a native
 * component with no script → OPAQUE. Never maps to a wrong widget — the precision
 * invariant at the identity seam.
 */
export function resolveComponentIdentity(
  _graph: UnityGraph,
  component: UnityComponent,
): ComponentIdentity {
  if (component.scriptGuid == null) return { kind: "opaque" };
  const widget = resolveWidgetGuid(component.scriptGuid);
  if (!widget) return { kind: "opaque" };
  return { kind: "widget", widget: widget.widget, host: widget.host };
}

/**
 * Walk a GameObject's transform children one level down. Unity's hierarchy lives on
 * the *transform* components, not the GameObjects: a GameObject's RectTransform/
 * Transform lists child *transform* `fileID`s in `m_Children`, and each child
 * transform's `m_GameObject` points back to the child GameObject. This resolves that
 * indirection so callers walk GameObject→GameObject directly.
 */
export function childGameObjects(graph: UnityGraph, parent: UnityGameObject): UnityGameObject[] {
  const out: UnityGameObject[] = [];
  for (const component of parent.components) {
    for (const childTransformId of component.children) {
      const childTransform = graph.components.get(childTransformId);
      if (!childTransform?.gameObjectId) continue;
      const childGo = graph.gameObjects.get(childTransform.gameObjectId);
      if (childGo) out.push(childGo);
    }
  }
  return out;
}
