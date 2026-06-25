import Foundation

/// A single static accessibility finding. The shape is the engine↔TS contract:
/// each item serializes to EXACTLY the JSON object the TS `scanSwift` collector
/// parses (see `src/collect-swift.ts`):
///
///     { "file": string, "line": number,
///       "ruleId": "swiftui/image-no-label" | "swiftui/control-no-name",
///       "message": string, "wcag": ["1.1.1"], "severity": "serious" | "critical" }
///
/// `wcag` is an array (always one element here) to match the web tool's
/// `Finding.wcag: readonly string[]`. `severity` is "critical" only when the
/// missing name leaves an interactive element with no accessible name at all
/// (the element is unusable by VoiceOver), else "serious".
public struct Finding: Encodable {
    public let file: String
    public let line: Int
    public let ruleId: String
    public let message: String
    public let wcag: [String]
    public let severity: String
}
