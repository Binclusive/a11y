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

/// Walk OUTWARD from `expr` collecting every `.modifier(...)` applied to it as
/// the base of a postfix chain. SwiftUI parses `Image(…).accessibilityLabel("x")`
/// as nested MemberAccess on the OUTSIDE of the call, so the modifiers applied to
/// an expression are found by climbing PARENTS, not children. Stops at the first
/// node that is not part of the contiguous postfix/member chain.
func modifiersAppliedTo(_ expr: some ExprSyntaxProtocol) -> [(name: String, arg: String?)] {
    var result: [(String, String?)] = []
    var current: Syntax? = Syntax(expr).parent
    while let node = current {
        // A member access `.foo` whose base is the (growing) chain.
        if let member = node.as(MemberAccessExprSyntax.self) {
            let name = member.declName.baseName.text
            var arg: String? = nil
            if let outerCall = member.parent?.as(FunctionCallExprSyntax.self) {
                arg = firstArgText(of: outerCall)
            }
            result.append((name, arg))
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

/// Does the modifier chain directly attached to `expr` carry a name-providing
/// treatment, an explicit hide, or a label-combine that pulls a sibling name in?
func chainHasAccessibleTreatment(_ expr: some ExprSyntaxProtocol) -> Bool {
    for (name, arg) in modifiersAppliedTo(expr) {
        if nameProvidingModifiers.contains(name) { return true }
        if name == "accessibilityHidden", (arg ?? "").contains("true") { return true }
        // `.accessibilityElement(children: .combine | .contain)` merges siblings —
        // a sibling `Text` then supplies the name. Treat as covered.
        if name == "accessibilityElement" { return true }
    }
    return false
}

/// The nearest enclosing function call whose callee identifier is in `names`.
/// Returns the call plus the matched name. Used to find the accessibility-element
/// ancestor (Button/NavigationLink/…) an `Image`/control lives inside.
func nearestEnclosingCall(
    of node: Syntax,
    whereCalleeIn names: Set<String>,
    maxDepth: Int = 24
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

/// Does `call`'s argument list (positional or trailing/labeled closure) contain a
/// `Text("…")`, a string-titled `Label`/`Button`, OR a non-empty FIRST string
/// literal positional argument? Any of these supplies the element's accessible
/// name. This is the in-subtree name search used after climbing to an ancestor.
func subtreeSuppliesName(_ node: SyntaxProtocol) -> Bool {
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
    // A leading string-literal title on ANY other call: `Button("Save") { … }`,
    // `NavigationLink("Home") { … }`.
    if let call = node.as(FunctionCallExprSyntax.self),
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
        if subtreeSuppliesName(child) { return true }
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
