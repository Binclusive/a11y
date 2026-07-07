import A11ySwiftScanCore
import Foundation

// A11ySwiftScan <dir>
//
// Thin executable shell: all behavior — file discovery, the SwiftSyntax climb,
// and the JSON output — lives in the testable `A11ySwiftScanCore` library. This
// shell exists only to forward the process arguments and exit with the code the
// engine returns, so `swift test` can exercise the engine directly while the
// shipped binary stays a one-liner.
exit(runA11ySwiftScan(arguments: CommandLine.arguments))
