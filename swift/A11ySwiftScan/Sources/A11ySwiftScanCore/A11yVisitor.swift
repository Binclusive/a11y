import SwiftSyntax

/// Walks one parsed `.swift` file and emits findings for the STATIC rules:
///
///   swiftui/image-no-label   (WCAG 1.1.1) — an informative `Image(…)` with no
///       accessible name on it OR any ancestor up to the nearest a11y element.
///   swiftui/control-no-name  (WCAG 4.1.2) — an icon-only `Button` / `.onTapGesture`
///       view whose accessible name is empty after climbing.
///   swiftui/control-no-value (WCAG 4.1.2) — a `Slider`/`Stepper`/`Toggle`
///       (adjustable control) with no `.accessibilityValue` describing its
///       current value.
///
/// The ancestor-climb (see SyntaxClimb.swift) is what makes this precise: a bare
/// `Image` inside a labeled `Button`/`NavigationLink`/toolbar item is NOT flagged.
final class A11yVisitor: SyntaxVisitor {
    let filePath: String
    let converter: SourceLocationConverter
    var findings: [Finding] = []

    init(filePath: String, converter: SourceLocationConverter) {
        self.filePath = filePath
        self.converter = converter
        super.init(viewMode: .sourceAccurate)
    }

    private func line(of node: some SyntaxProtocol) -> Int {
        node.startLocation(converter: converter).line
    }

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
        guard let callee = calleeIdentifier(of: node) else { return .visitChildren }

        switch callee {
        case "Image":
            checkImage(node)
        case "Button":
            checkButtonControl(node)
        case "Slider", "Stepper", "Toggle":
            checkAdjustableControl(node, kind: callee)
        default:
            break
        }
        return .visitChildren
    }

    /// Flag a tappable non-button view: `.onTapGesture { … }` applied to a view
    /// whose subtree has no name and no `.accessibilityLabel` on the chain. The
    /// gesture turns the view into a de-facto control with no accessible name.
    override func visit(_ node: MemberAccessExprSyntax) -> SyntaxVisitorContinueKind {
        guard node.declName.baseName.text == "onTapGesture" else { return .visitChildren }
        // The base of `.onTapGesture` is the view it makes tappable.
        guard let base = node.base else { return .visitChildren }
        // A `.accessibilityHidden(true)` on the OUTER chain takes the tap target
        // out of the a11y tree — checked on the member node itself, not the base.
        if chainHasAccessibleTreatment(node) { return .visitChildren }
        // The single shared name predicate: a name on the tap base's own subtree
        // or chain, on a named ancestor control, or on an enclosing combine+label
        // container all count. A tappable view is a CHILD that INHERITS its name
        // from an enclosing labeled control, so the ancestor climb is enabled.
        // (Replaces the former 4-deep guard chain.)
        if accessibleNameExists(subtree: base, climbFrom: Syntax(node), inheritsAncestorName: true) {
            return .visitChildren
        }

        findings.append(Finding(
            file: filePath,
            line: line(of: node),
            ruleId: "swiftui/control-no-name",
            message: "Tappable view (.onTapGesture) has no accessible name — VoiceOver announces nothing. Add .accessibilityLabel(\"…\"), .accessibilityElement(children: .combine), and .accessibilityAddTraits(.isButton).",
            wcag: ["4.1.2"],
            severity: "serious"
        ))
        return .visitChildren
    }

    // MARK: - Rule: image-no-label (1.1.1)

    private func checkImage(_ node: FunctionCallExprSyntax) {
        // Don't-flag: `Image(decorative:)` — explicitly no semantic value.
        if isDecorativeImageInit(node) { return }
        // Don't-flag: a name-providing / hidden treatment directly on the Image.
        if chainHasAccessibleTreatment(node) { return }
        // Don't-flag: the icon content of a `Label("text", systemImage:)` — the
        // text is the label, the symbol is decorative-by-construction.
        if isInsideLabel(Syntax(node)) { return }

        // CLIMB: the nearest accessibility-element ancestor (Button /
        // NavigationLink / Link / toolbar item / …). If that ancestor supplies a
        // name — a title string, a `.accessibilityLabel`, or sibling Text — the
        // Image is NOT unlabeled. This is the false-positive killer.
        let status = ancestorNameStatus(for: Syntax(node))
        if case .named = status { return }
        // `soleInteractiveContent`: the nearest container exists, has no name, and
        // is itself an interactive control — the missing label makes it unusable,
        // so the image finding is `critical`. `.none` (no container) and a
        // non-interactive unnamed container are both `serious`.
        let soleInteractiveContent: Bool
        if case .unnamed(let interactive) = status { soleInteractiveContent = interactive }
        else { soleInteractiveContent = false }

        // SF Symbol special case: a bare `Image(systemName:)` carries an implicit
        // VoiceOver name from the symbol. Inside a NON-interactive context that is
        // an acceptable (if weak) name — don't flag. Flag it only when it is the
        // SOLE content of an interactive element whose action it can't describe
        // (a "trash" glyph on a delete button still needs "Delete"): that case is
        // the control-no-name rule's job, reported on the control, so here we
        // simply don't emit an image finding for an implicitly-named symbol.
        if isSystemImage(node) { return }

        let severity = soleInteractiveContent ? "critical" : "serious"
        let context = soleInteractiveContent
            ? "is the sole content of an interactive element and"
            : "is informative and"
        findings.append(Finding(
            file: filePath,
            line: line(of: node),
            ruleId: "swiftui/image-no-label",
            message: "Image \(context) has no accessible name on it or any ancestor up to the nearest accessibility element. Add .accessibilityLabel(\"…\"), or mark it decorative with Image(decorative:) / .accessibilityHidden(true).",
            wcag: ["1.1.1"],
            severity: severity
        ))
    }

    // MARK: - Rule: control-no-name (4.1.2)

    /// An icon-only `Button` whose accessible name is empty after climbing.
    /// Covers both spellings:
    ///   Button(action:) { Image(systemName: "ellipsis") }
    ///   Button { … } label: { Image(systemName: "ellipsis") }
    private func checkButtonControl(_ node: FunctionCallExprSyntax) {
        // The single shared name predicate. A `Button` IS the accessibility
        // element, so its name must come from its OWN subtree/chain (a title
        // string / sibling Text inside it, or a `.accessibilityLabel` /
        // `.accessibilityHidden(true)` on its chain) — NOT from a sibling `Text`
        // in a shared `ToolbarItemGroup`. So the named-control ancestor climb is
        // DISABLED here (`inheritsAncestorName: false`); only an explicit
        // combine+label container, which genuinely merges the button, still counts.
        if accessibleNameExists(subtree: ExprSyntax(node), climbFrom: Syntax(node), inheritsAncestorName: false) {
            return
        }

        // The button's content: does it contain a NON-systemName, NON-labeled
        // image only? If the only content is an Image with no name, the control
        // has no name. (systemName images carry an implicit symbol name, but for
        // a control that name rarely describes the ACTION — still, to stay at a
        // high precision floor we only flag when there is NO name source at all.)
        if buttonHasOnlyUnlabeledImage(node) {
            findings.append(Finding(
                file: filePath,
                line: line(of: node),
                ruleId: "swiftui/control-no-name",
                message: "Icon-only Button has no accessible name — VoiceOver announces nothing useful. Name the ACTION (not the icon): .accessibilityLabel(\"…\") on the Button.",
                wcag: ["4.1.2"],
                severity: "serious"
            ))
        }
    }

    // MARK: - Rule: control-no-value (4.1.2)

    /// A `Slider`/`Stepper`/`Toggle` is an ADJUSTABLE control: its accessible
    /// name says what it is, but VoiceOver users also need its CURRENT VALUE.
    /// Flag the control when nothing describes that value — and stay opaque
    /// (don't flag) on any treatment that plausibly covers it: a
    /// `.accessibilityValue`/`.accessibilityRepresentation` on its chain or
    /// subtree, an explicit `.accessibilityHidden(true)`, or a merging
    /// combine+label container above it. A `.accessibilityLabel` alone does NOT
    /// suppress this rule — a name is not a value (see `chainHasValueTreatment`).
    private func checkAdjustableControl(_ node: FunctionCallExprSyntax, kind: String) {
        if chainHasValueTreatment(node) { return }
        if subtreeContainsValueModifier(node) { return }
        if enclosingCombinedElementSuppliesName(Syntax(node)) { return }

        findings.append(Finding(
            file: filePath,
            line: line(of: node),
            ruleId: "swiftui/control-no-value",
            message: "\(kind) has no accessibilityValue — VoiceOver announces the control without its current value. Add .accessibilityValue(\"…\") describing the current value.",
            wcag: ["4.1.2"],
            severity: "serious"
        ))
    }

    /// True iff this Button's visible content is exactly an `Image` (or images)
    /// with NO text title anywhere and NO `.accessibilityLabel` on the Button.
    /// A `systemImage:` init or a contained `Text` makes it named, so this is the
    /// pure icon-only case.
    private func buttonHasOnlyUnlabeledImage(_ node: FunctionCallExprSyntax) -> Bool {
        // If any Text or title string exists in the subtree, it's named — handled
        // above; here we just need: is there an Image present and no name?
        return subtreeContainsImage(node) && !subtreeSuppliesName(node)
    }
}

// MARK: - Image classifiers

/// `Image(decorative:)` — decorative-by-construction, intentional. Don't flag.
func isDecorativeImageInit(_ call: FunctionCallExprSyntax) -> Bool {
    call.arguments.contains { $0.label?.text == "decorative" }
}

/// `Image(systemName:)` — an SF Symbol with an implicit VoiceOver name.
func isSystemImage(_ call: FunctionCallExprSyntax) -> Bool {
    call.arguments.contains { $0.label?.text == "systemName" }
}

/// Is `node` the icon content of an enclosing `Label(...)`? Climb a bounded
/// number of parents looking for a `Label` callee. `Label` supplies the text, so
/// its symbol is decorative-by-construction.
func isInsideLabel(_ node: Syntax) -> Bool {
    nearestEnclosingCall(of: node, whereCalleeIn: ["Label"], maxDepth: labelClimbMaxDepth) != nil
}

/// Does the subtree rooted at `node` contain any `Image(...)` call?
func subtreeContainsImage(_ node: SyntaxProtocol) -> Bool {
    for child in node.children(viewMode: .sourceAccurate) {
        if let call = child.as(FunctionCallExprSyntax.self),
           calleeIdentifier(of: call) == "Image" {
            return true
        }
        if subtreeContainsImage(child) { return true }
    }
    return false
}

// The ancestor climb (ancestorNameStatus), the combined-element climb
// (enclosingCombinedElementSuppliesName), and the shared accessibleNameExists
// predicate now live in SyntaxClimb.swift — one climb, one name predicate, shared
// by the image, tap, and button rules.
