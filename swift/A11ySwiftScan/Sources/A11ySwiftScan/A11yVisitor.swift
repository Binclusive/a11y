import SwiftSyntax

/// Walks one parsed `.swift` file and emits findings for the two STATIC rules:
///
///   swiftui/image-no-label  (WCAG 1.1.1) — an informative `Image(…)` with no
///       accessible name on it OR any ancestor up to the nearest a11y element.
///   swiftui/control-no-name (WCAG 4.1.2) — an icon-only `Button` / `.onTapGesture`
///       view whose accessible name is empty after climbing.
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
        // If the whole tap-target chain already carries a label, it's named.
        if chainHasAccessibleTreatment(base) { return .visitChildren }
        // If the chain is hidden, skip.
        if chainHasAccessibleTreatment(node) { return .visitChildren }
        // If the tapped subtree contains visible text, VoiceOver reads that.
        if subtreeSuppliesName(base) { return .visitChildren }
        // Climbing up: a labeled ancestor control covers it.
        if enclosingAccessibilityElementSuppliesName(Syntax(node)) { return .visitChildren }
        // Climbing up: an enclosing container merged via `.accessibilityElement
        // (children: .combine)` + a label supplies the name for this child.
        if enclosingCombinedElementSuppliesName(Syntax(node)) { return .visitChildren }

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
        let (named, soleInteractiveContent) = ancestorNameStatus(for: Syntax(node))
        if named { return }

        // SF Symbol special case: a bare `Image(systemName:)` carries an implicit
        // VoiceOver name from the symbol. Inside a NON-interactive context that is
        // an acceptable (if weak) name — don't flag. Flag it only when it is the
        // SOLE content of an interactive element whose action it can't describe
        // (a "trash" glyph on a delete button still needs "Delete"): that case is
        // the control-no-name rule's job, reported on the control, so here we
        // simply don't emit an image finding for an implicitly-named symbol.
        if isSystemImage(node) { return }

        let severity = soleInteractiveContent ? "critical" : "serious"
        let where_ = soleInteractiveContent
            ? "is the sole content of an interactive element and"
            : "is informative and"
        findings.append(Finding(
            file: filePath,
            line: line(of: node),
            ruleId: "swiftui/image-no-label",
            message: "Image \(where_) has no accessible name on it or any ancestor up to the nearest accessibility element. Add .accessibilityLabel(\"…\"), or mark it decorative with Image(decorative:) / .accessibilityHidden(true).",
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
        // A titled button is named: Button("Save") { … } / Button("S", systemImage:)
        if subtreeSuppliesName(node) { return }
        // A `.accessibilityLabel` on the Button's own chain names it.
        if chainHasAccessibleTreatment(node) { return }
        // A `.accessibilityHidden(true)` Button is out of the tree.
        // (already covered by chainHasAccessibleTreatment)

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
    nearestEnclosingCall(of: node, whereCalleeIn: ["Label"], maxDepth: 10) != nil
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

// MARK: - The climb: ancestor name status for an Image

/// Walk UP from an `Image` node to the nearest accessibility-element ancestor and
/// decide whether a name is supplied. Returns:
///   - named: true if an ancestor (or its own chain / subtree) supplies a name,
///     OR no a11y-element ancestor exists AND the image carries no name (then the
///     caller decides via decorative/system checks).
///   - soleInteractiveContent: true when the nearest a11y-element ancestor IS an
///     interactive control (Button/NavigationLink/Link/Menu/Toggle/toolbar item)
///     and that control supplies NO name — i.e. the missing label leaves an
///     interactive element unusable, so the image finding is "critical".
func ancestorNameStatus(for imageNode: Syntax) -> (named: Bool, soleInteractiveContent: Bool) {
    guard let (call, name) = nearestEnclosingCall(
        of: imageNode,
        whereCalleeIn: accessibilityElementContainers
    ) else {
        // No accessibility-element ancestor: the Image stands alone. It is named
        // only if its own chain carries a treatment (already checked by caller),
        // so report "not named, not interactive".
        return (named: false, soleInteractiveContent: false)
    }

    // The ancestor exists. Is it named? A title string, a `.accessibilityLabel`
    // on the ancestor's chain, or sibling Text inside it all count.
    let ancestorNamed =
        subtreeSuppliesName(call) || chainHasAccessibleTreatment(call)

    if ancestorNamed {
        return (named: true, soleInteractiveContent: false)
    }

    // Unnamed ancestor. Is it interactive? Then the missing label is critical.
    let interactive: Set<String> = [
        "Button", "NavigationLink", "Link", "Menu", "Toggle",
        "ToolbarItem", "ToolbarItemGroup", "Stepper", "Picker",
    ]
    return (named: false, soleInteractiveContent: interactive.contains(name))
}

/// Climb to the nearest accessibility-element ancestor and ask whether it
/// supplies a name (used by the `.onTapGesture` path).
func enclosingAccessibilityElementSuppliesName(_ node: Syntax) -> Bool {
    guard let (call, _) = nearestEnclosingCall(
        of: node,
        whereCalleeIn: accessibilityElementContainers
    ) else { return false }
    return subtreeSuppliesName(call) || chainHasAccessibleTreatment(call)
}

/// Climb the ENCLOSING modifier chain looking for a generic combined-element
/// container that supplies a name: a `.accessibilityElement(children: .combine)`
/// (or `.contain`) PAIRED with a `.accessibilityLabel` / `.accessibilityValue` /
/// `.accessibilityRepresentation` applied to the same enclosing view (an HStack /
/// VStack / ZStack / custom view, NOT necessarily a Button). VoiceOver then reads
/// the merged element's label, so a tappable child inside it is named.
///
/// This is distinct from `enclosingAccessibilityElementSuppliesName`, which only
/// recognizes the named-control containers (Button/NavigationLink/…). Here we
/// recognize the "container view + combine + label" idiom that IceCubesApp uses
/// to make a whole row one accessible button.
func enclosingCombinedElementSuppliesName(_ node: Syntax, maxDepth: Int = 28) -> Bool {
    var current: Syntax? = node.parent
    var depth = 0
    var sawCombine = false
    var sawLabel = false
    while let n = current, depth < maxDepth {
        if let member = n.as(MemberAccessExprSyntax.self) {
            let name = member.declName.baseName.text
            if name == "accessibilityElement" { sawCombine = true }
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
