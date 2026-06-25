import SwiftSyntax

// MARK: - The ancestor-climb heuristic
//
// This file IS the point of the engine. A bare `Image` (or icon-only control) is
// NOT automatically a violation: SwiftUI merges children into one accessibility
// element when an ancestor is itself an accessibility element, and the ANCESTOR's
// name is what VoiceOver reads. The naïve spike checked only the modifier chain
// glued directly to the `Image` and was ~50% true-positive. Here we climb UP the
// syntax tree to the nearest accessibility-element ancestor (Button /
// NavigationLink / Link / Toolbar item / Label / `.accessibilityElement`
// container) and check for a name THERE before flagging.

// MARK: - Depth bounds for the tree walks
//
// SwiftUI view bodies nest deeply (a row inside a list inside a navigation
// stack inside a tab). The upward climbs and the downward subtree walk are
// bounded so a pathological tree can't make a scan loop forever, while staying
// generous enough to clear every real nesting depth IceCubesApp exercises.

/// Max parents to climb when searching for an accessibility-element *container*
/// ancestor (Button / NavigationLink / `.accessibilityElement(children:)`).
/// 24 clears the deepest real container nesting observed in the corpus.
let containerClimbMaxDepth = 24

/// Max parents to climb when looking only for an enclosing `Label(...)` — a
/// `Label`'s icon sits very near it, so this is intentionally tighter than the
/// container climb to avoid claiming a distant unrelated `Label`.
let labelClimbMaxDepth = 10

/// Max parents to climb when pairing a `.accessibilityElement(children:.combine)`
/// with a `.accessibilityLabel` on the SAME enclosing view-modifier chain. Both
/// modifiers live on one container's chain, so this is bounded like the container
/// climb plus a small margin for the intervening member/call nodes of the chain.
let combinedElementClimbMaxDepth = 28

/// Max depth the downward `subtreeSuppliesName` recursion descends. A SwiftUI
/// `body` is a finite expression tree, but bounding the recursion makes the walk
/// robust against a degenerate input and caps work per node. 32 comfortably
/// clears the deepest real view-builder nesting (a labeled control whose name
/// lives several closures down).
let subtreeNameMaxDepth = 32

/// SwiftUI accessibility modifiers that supply (or remove the need for) a name.
/// Presence of any of these in a modifier chain means "this subtree has an
/// accessible treatment" — we must not flag an `Image`/control under it.
let nameProvidingModifiers: Set<String> = [
    "accessibilityLabel",
    "accessibilityValue",
    "accessibilityRepresentation",
    "accessibilityChildren",
]

/// Identifiers that, used as a call's callee, introduce an accessibility-element
/// ANCESTOR — VoiceOver reads ONE element for the whole subtree, so the name may
/// live on the ancestor's label/title rather than on the inner `Image`.
let accessibilityElementContainers: Set<String> = [
    "Button",
    "NavigationLink",
    "Link",
    "Menu",
    "Toggle",
    "Label",
    "Stepper",
    "Picker",
    // `PhotosPicker` / `ShareLink` render as a SINGLE accessibility element (like a
    // Button); a `.accessibilityLabel` on their chain — or a `ShareLink` title —
    // names their whole content, so an inner `Image` is not unlabeled. Without
    // these the climb missed the label and flagged a labelled control's image.
    "PhotosPicker",
    "ShareLink",
    "ToolbarItem",
    "ToolbarItemGroup",
]

/// The text of a modifier-call's first argument, trimmed — used to read e.g.
/// the bool passed to `.accessibilityHidden(true)` or the string passed to
/// `.accessibilityLabel("…")`.
func firstArgText(of call: FunctionCallExprSyntax) -> String? {
    call.arguments.first?.expression.description
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// One modifier observed on a postfix chain: its name, the trimmed text of its
/// first argument (for legacy callers), and the call node itself when the
/// modifier was applied with `(...)` — so a caller can inspect the real argument
/// list (labels, expression kinds) instead of substring-matching its text.
struct ChainModifier {
    let name: String
    let arg: String?
    let call: FunctionCallExprSyntax?
}

/// Walk OUTWARD from `expr` collecting every `.modifier(...)` applied to it as
/// the base of a postfix chain. SwiftUI parses `Image(…).accessibilityLabel("x")`
/// as nested MemberAccess on the OUTSIDE of the call, so the modifiers applied to
/// an expression are found by climbing PARENTS, not children. Stops at the first
/// node that is not part of the contiguous postfix/member chain.
func modifiersAppliedTo(_ expr: some ExprSyntaxProtocol) -> [ChainModifier] {
    var result: [ChainModifier] = []
    var current: Syntax? = Syntax(expr).parent
    while let node = current {
        // A member access `.foo` whose base is the (growing) chain.
        if let member = node.as(MemberAccessExprSyntax.self) {
            let name = member.declName.baseName.text
            var arg: String? = nil
            var call: FunctionCallExprSyntax? = nil
            if let outerCall = member.parent?.as(FunctionCallExprSyntax.self) {
                arg = firstArgText(of: outerCall)
                call = outerCall
            }
            result.append(ChainModifier(name: name, arg: arg, call: call))
            current = node.parent
            continue
        }
        // A function call whose callee is the chain (the `(…)` that applies a
        // modifier). Keep climbing through it.
        if node.is(FunctionCallExprSyntax.self) {
            current = node.parent
            continue
        }
        // Anything else (CodeBlockItem, closure, tuple, argument) ends the chain
        // that is directly glued to this expression.
        break
    }
    return result
}

/// Is `expr` the boolean literal `true`? Matches the real `BooleanLiteralExpr`
/// (token `true`), NOT a substring — so `.accessibilityHidden(isTrueColor)` or a
/// variable named `…true…` is correctly NOT treated as an explicit hide. A
/// runtime-variable condition is a guess, and guessing "hidden" is the worst
/// failure (a silent false negative), so we require the literal.
func isBooleanTrueLiteral(_ expr: ExprSyntax) -> Bool {
    guard let lit = expr.as(BooleanLiteralExprSyntax.self) else { return false }
    return lit.literal.tokenKind == .keyword(.true)
}

/// Does `.accessibilityHidden(...)` carry a literal `true`? Reads the FIRST
/// argument's expression off the actual call (not its description text).
func accessibilityHiddenIsTrue(_ call: FunctionCallExprSyntax?) -> Bool {
    guard let first = call?.arguments.first else { return false }
    return isBooleanTrueLiteral(first.expression)
}

/// Does `.accessibilityElement(...)` actually MERGE its children into one
/// element? Only `.accessibilityElement(children: .combine)` and `… .contain` do.
/// A bare `.accessibilityElement()` or `.accessibilityElement(children: .ignore)`
/// makes the view ONE element but supplies NO name from the subtree — treating it
/// as "covers the subtree" would silently suppress a real missing-name finding.
/// So we require `children:` to be `.combine` or `.contain`.
func accessibilityElementMergesChildren(_ call: FunctionCallExprSyntax?) -> Bool {
    guard let call else { return false }
    for arg in call.arguments where arg.label?.text == "children" {
        if let member = arg.expression.as(MemberAccessExprSyntax.self) {
            let kind = member.declName.baseName.text
            return kind == "combine" || kind == "contain"
        }
    }
    return false
}

/// Does the modifier chain directly attached to `expr` carry a name-providing
/// treatment, an explicit hide (`accessibilityHidden(true)`), or a children-
/// merging `.accessibilityElement(children: .combine|.contain)` that pulls a
/// sibling name in?
func chainHasAccessibleTreatment(_ expr: some ExprSyntaxProtocol) -> Bool {
    for m in modifiersAppliedTo(expr) {
        if nameProvidingModifiers.contains(m.name) { return true }
        // Real boolean literal `true`, never a substring of an identifier.
        if m.name == "accessibilityHidden", accessibilityHiddenIsTrue(m.call) { return true }
        // ONLY `.combine` / `.contain` merge siblings so a sibling `Text` can
        // supply the name. A bare `.accessibilityElement()` / `children:.ignore`
        // does NOT — it must NOT silence a missing-name finding.
        if m.name == "accessibilityElement", accessibilityElementMergesChildren(m.call) { return true }
    }
    return false
}

/// The nearest enclosing function call whose callee identifier is in `names`.
/// Returns the call plus the matched name. Used to find the accessibility-element
/// ancestor (Button/NavigationLink/…) an `Image`/control lives inside.
func nearestEnclosingCall(
    of node: Syntax,
    whereCalleeIn names: Set<String>,
    maxDepth: Int = containerClimbMaxDepth
) -> (call: FunctionCallExprSyntax, name: String)? {
    var current: Syntax? = node.parent
    var depth = 0
    while let n = current, depth < maxDepth {
        if let call = n.as(FunctionCallExprSyntax.self),
           let name = calleeIdentifier(of: call),
           names.contains(name) {
            return (call, name)
        }
        current = n.parent
        depth += 1
    }
    return nil
}

/// The bare identifier of a call's callee (`Button(…)` -> "Button",
/// `Image(systemName:)` -> "Image"). `nil` for non-identifier callees
/// (member-access callees like `foo.bar()` etc.).
func calleeIdentifier(of call: FunctionCallExprSyntax) -> String? {
    if let ref = call.calledExpression.as(DeclReferenceExprSyntax.self) {
        return ref.baseName.text
    }
    return nil
}

/// An `Image`'s OWN leading positional literal is the ASSET NAME, not a visible
/// label — `Image("logo")` reads nothing to VoiceOver. So when we test whether a
/// call supplies a name, an `Image(...)` callee must be EXCLUDED from the
/// "leading positional string literal is a name" rule, otherwise the very
/// `Image` being checked self-suppresses its own `image-no-label` finding.
/// (Climbing to a NAMED ANCESTOR — Button/Label/Text — stays valid; only the
/// image's own asset literal is disqualified.)
private func calleeIsImage(_ call: FunctionCallExprSyntax) -> Bool {
    calleeIdentifier(of: call) == "Image"
}

/// Does `call`'s argument list (positional or trailing/labeled closure) contain a
/// `Text("…")`, a string-titled `Label`/`Button`, OR a non-empty FIRST string
/// literal positional argument? Any of these supplies the element's accessible
/// name. This is the in-subtree name search used after climbing to an ancestor.
func subtreeSuppliesName(_ node: SyntaxProtocol, depth: Int = subtreeNameMaxDepth) -> Bool {
    if depth <= 0 { return false }
    // The node itself is a `Label(...)` / `Text(...)` with a leading title — the
    // title (literal OR variable like `group.title`) is the accessible name. This
    // is the common `Label(group.title, systemImage:).onTapGesture{}` shape.
    if let call = node.as(FunctionCallExprSyntax.self),
       let name = calleeIdentifier(of: call),
       name == "Label" || name == "Text",
       let first = call.arguments.first,
       first.label == nil,
       isNonEmptyExpr(first.expression) {
        return true
    }
    // A leading string-literal title on ANY other call — `Button("Save") { … }`,
    // `NavigationLink("Home") { … }` — EXCEPT an `Image(...)`, whose leading
    // literal is its asset name, not a label (see `calleeIsImage`).
    if let call = node.as(FunctionCallExprSyntax.self),
       !calleeIsImage(call),
       let first = call.arguments.first,
       first.label == nil,
       isNonEmptyStringLiteral(first.expression) {
        return true
    }
    // A `systemImage:`/`image:` labeled init means the OTHER positional is the
    // title text — `Button("Save", systemImage: "checkmark")`.
    if let call = node.as(FunctionCallExprSyntax.self) {
        for arg in call.arguments where arg.label?.text == "systemImage" || arg.label?.text == "image" {
            // the title positional is what names it; if any positional string exists, covered
            for a in call.arguments where a.label == nil && isNonEmptyStringLiteral(a.expression) {
                return true
            }
        }
    }
    // Recurse over the subtree for any of three name sources:
    //   1. `Text(<anything non-empty>)`     — renders visible text
    //   2. `Label(<title>, …)`              — Label ALWAYS renders its title
    //      (even a variable title like `group.title` — it is text at runtime)
    //   3. a `.accessibilityLabel` / `.accessibilityRepresentation` /
    //      `.accessibilityValue` modifier anywhere in the subtree (a nested
    //      view-builder closure can carry the label on an inner view).
    for child in node.children(viewMode: .sourceAccurate) {
        // (3) A name-providing accessibility modifier on any descendant chain.
        if let member = child.as(MemberAccessExprSyntax.self),
           nameProvidingModifiers.contains(member.declName.baseName.text) {
            return true
        }
        if let call = child.as(FunctionCallExprSyntax.self),
           let name = calleeIdentifier(of: call) {
            // (1) Any `Text(arg)` with a non-empty argument — literal OR variable.
            // A variable/interpolated Text is text at runtime; treating it as a
            // name is the conservative (precision-first) choice.
            if name == "Text", let first = call.arguments.first,
               isNonEmptyExpr(first.expression) {
                return true
            }
            // (2) Any `Label(title, …)` with a leading positional argument.
            if name == "Label", let first = call.arguments.first,
               first.label == nil, isNonEmptyExpr(first.expression) {
                return true
            }
        }
        if subtreeSuppliesName(child, depth: depth - 1) { return true }
    }
    return false
}

/// Is `expr` a non-empty string-literal expression? `"Save"` -> true,
/// `""` -> false, `someVar` / interpolation -> false (we only count literal,
/// statically-visible text as a name; a variable could be empty at runtime, but
/// flagging it would be a guess — we conservatively treat it as a name when it's
/// any string literal with content).
func isNonEmptyStringLiteral(_ expr: ExprSyntax) -> Bool {
    guard let str = expr.as(StringLiteralExprSyntax.self) else { return false }
    let inner = str.segments.description.trimmingCharacters(in: .whitespacesAndNewlines)
    return !inner.isEmpty
}

/// Is `expr` a non-empty NAME source — a non-empty string literal, OR a variable /
/// member / interpolation that renders text at runtime? Used for `Text(...)` and
/// `Label(...)` titles where the argument is often a property (`group.title`,
/// `account.displayName`) rather than a literal. An empty string literal is the
/// only thing that is NOT a name.
func isNonEmptyExpr(_ expr: ExprSyntax) -> Bool {
    if let str = expr.as(StringLiteralExprSyntax.self) {
        return !str.segments.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    // Non-literal (variable / member / call / interpolation): renders text.
    return true
}

// MARK: - The unified ancestor climb

/// The result of climbing UP to the nearest accessibility-element container.
/// Three REAL, distinct states — collapsing them into a single `Bool` lost the
/// difference between "no container above" and "a container above that has no
/// name", which the image rule's severity decision depends on:
///
///   - `.none`                — no accessibility-element container ancestor at all.
///     The node stands alone; only its own chain can name it.
///   - `.unnamed(interactive)` — a container exists but supplies NO name. The
///     missing label is `critical` when that container is itself interactive
///     (Button/NavigationLink/…) — an unusable control — else `serious`.
///   - `.named(let name)`     — a container exists and DOES supply a name (a title
///     string, a sibling `Text`, or a `.accessibilityLabel` on its chain); the
///     inner node is covered. `name` is the container's callee for callers that
///     want it (`nil` when the name came from a chain modifier, not a title).
enum AncestorNameStatus {
    case none
    case unnamed(interactive: Bool)
    case named(ancestorName: String?)
}

/// Interactive accessibility-element containers — when one of these is the
/// nearest container AND it has no name, the inner element is unusable, so the
/// finding is `critical`.
let interactiveContainers: Set<String> = [
    "Button", "NavigationLink", "Link", "Menu", "Toggle",
    "ToolbarItem", "ToolbarItemGroup", "Stepper", "Picker",
    "PhotosPicker", "ShareLink",
]

/// THE single upward climb (collapsed from the former `ancestorNameStatus` +
/// `enclosingAccessibilityElementSuppliesName`, which asked the same question over
/// the same container set). Walk UP to the nearest accessibility-element container
/// (Button / NavigationLink / Label / `.accessibilityElement(children:)` /…) and
/// report whether it supplies a name — see {@link AncestorNameStatus}. The image
/// rule derives `soleInteractiveContent` from the `.unnamed(interactive:)` case;
/// the tap rule only cares whether the result is `.named`.
func ancestorNameStatus(for node: Syntax) -> AncestorNameStatus {
    guard let (call, name) = nearestEnclosingCall(
        of: node,
        whereCalleeIn: accessibilityElementContainers
    ) else {
        return .none
    }
    // A title string, a sibling `Text` inside it, or a `.accessibilityLabel` on
    // the container's own chain all name the merged element.
    if subtreeSuppliesName(call) || chainHasAccessibleTreatment(call) {
        return .named(ancestorName: name)
    }
    return .unnamed(interactive: interactiveContainers.contains(name))
}

/// Climb the ENCLOSING modifier chain looking for a generic combined-element
/// container that supplies a name: a `.accessibilityElement(children: .combine)`
/// (or `.contain`) PAIRED with a `.accessibilityLabel` / `.accessibilityValue` /
/// `.accessibilityRepresentation` applied to the same enclosing view (an HStack /
/// VStack / ZStack / custom view, NOT necessarily a Button). VoiceOver then reads
/// the merged element's label, so a tappable child inside it is named.
///
/// Distinct from `ancestorNameStatus`, which recognizes named-control containers
/// (Button/NavigationLink/…). Here we recognize the "container view + combine +
/// label" idiom IceCubesApp uses to make a whole row one accessible button.
///
/// A bare `.accessibilityElement()` or `children:.ignore` does NOT merge children,
/// so it must NOT count as the combine half of the pair (see
/// `accessibilityElementMergesChildren`) — otherwise the row's child would be
/// silently treated as named.
func enclosingCombinedElementSuppliesName(_ node: Syntax, maxDepth: Int = combinedElementClimbMaxDepth) -> Bool {
    var current: Syntax? = node.parent
    var depth = 0
    var sawCombine = false
    var sawLabel = false
    while let n = current, depth < maxDepth {
        if let member = n.as(MemberAccessExprSyntax.self) {
            let name = member.declName.baseName.text
            if name == "accessibilityElement",
               accessibilityElementMergesChildren(member.parent?.as(FunctionCallExprSyntax.self)) {
                sawCombine = true
            }
            if nameProvidingModifiers.contains(name) { sawLabel = true }
            // The pair can appear in any order up the chain; once both are seen
            // on the enclosing chain the merged element is named.
            if sawCombine && sawLabel { return true }
        }
        current = n.parent
        depth += 1
    }
    return false
}

/// THE one shared accessible-name predicate, ORing every name source a control's
/// name can come from:
///   1. on its own subtree       (`subtreeSuppliesName`)
///   2. on its own modifier chain (`chainHasAccessibleTreatment` — label / merge / hide)
///   3. on a named ancestor CONTAINER (`ancestorNameStatus` → `.named`) — only when
///      the node INHERITS its name from an enclosing element (a tappable child),
///      NOT when the node IS the accessibility element itself.
///   4. on an enclosing combine+label container (`enclosingCombinedElementSuppliesName`)
///
/// `subtree` is the view whose own subtree/chain is checked (the tap base, or the
/// Button call); `climbFrom` is the node the ancestor climb starts at (the
/// `.onTapGesture` member, or the Button call). Both the `.onTapGesture` rule and
/// `checkButtonControl` call this — one predicate, no duplicated guard chains.
///
/// `inheritsAncestorName` gates source (3): a `.onTapGesture` view is a CHILD that
/// inherits the name of the enclosing labeled control (Button/NavigationLink/…),
/// so it climbs. A `Button` IS the accessibility element — its name must come from
/// its OWN subtree/chain, never from a sibling `Text` in a shared `ToolbarItemGroup`
/// — so it does NOT climb to named-control ancestors. The combine+label container
/// climb (4) stays shared: it requires an explicit `.accessibilityElement(children:
/// .combine)+label`, which genuinely merges a child into the named element.
func accessibleNameExists(
    subtree: some ExprSyntaxProtocol,
    climbFrom: Syntax,
    inheritsAncestorName: Bool
) -> Bool {
    if subtreeSuppliesName(subtree) { return true }
    if chainHasAccessibleTreatment(subtree) { return true }
    if inheritsAncestorName, case .named = ancestorNameStatus(for: climbFrom) { return true }
    if enclosingCombinedElementSuppliesName(climbFrom) { return true }
    return false
}
