import Foundation

/// What a run's or fold's red count holds: its failed calls, and apart from them the runtime's
/// error lines (2026-11-09: a Codex session's fold read "Ran 344 tools · 7859 failed", because
/// 7,835 error notices of a steering retry loop were counted as failed calls). "N failed" counts
/// calls only, so it never exceeds the calls the fold ran; error lines read "N errors". The web's
/// twin is `countFoldFailures` / `foldFailureWords` in `web/src/components/sessions/fold-rows.ts`.
///
/// Every place that counts or labels a fold's failures goes through here
/// (`tests/web/ios-fold-failures-guard.test.ts`).
struct TimelineFoldFailures: Hashable, Sendable, ExpressibleByIntegerLiteral {
    /// Failed tool calls: never more than the calls counted.
    var calls: Int
    /// Error notices (session errors, a retry loop's lines): not calls.
    var errors: Int

    static let none = TimelineFoldFailures(calls: 0, errors: 0)

    init(calls: Int, errors: Int) {
        self.calls = calls
        self.errors = errors
    }

    /// A literal is failed calls alone, as the web's `foldFailureWords(3)` reads "3 failed".
    init(integerLiteral calls: Int) {
        self.init(calls: calls, errors: 0)
    }

    var isEmpty: Bool { calls <= 0 && errors <= 0 }

    /// A call that came back as an error. A question routed to the person is an answer, and a call
    /// the person stopped or turned down did not fail: the Stop marker beside it says what happened.
    static func isFailedCall(_ m: ChatMessage) -> Bool {
        m.kind == .tool && m.isError == true
            && !TimelineTurnShape.isRoutedQuestion(m) && !TimelineTurnShape.isInterruptedCall(m)
    }

    /// A runtime error line: a notification styled as an error.
    static func isErrorRow(_ m: ChatMessage) -> Bool {
        m.kind == .notification && NotificationStyling(message: m).isError
    }

    /// Count a stretch of rows.
    static func count<S: Sequence>(_ rows: S) -> TimelineFoldFailures where S.Element == ChatMessage {
        var out = TimelineFoldFailures.none
        for m in rows {
            if isFailedCall(m) { out.calls += 1 } else if isErrorRow(m) { out.errors += 1 }
        }
        return out
    }

    /// The red words: "2 failed", "1 error", "2 failed · 3 errors", or "" for none.
    var words: String {
        var parts: [String] = []
        if calls > 0 { parts.append("\(calls) failed") }
        if errors > 0 { parts.append("\(errors) \(errors == 1 ? "error" : "errors")") }
        return parts.joined(separator: " · ")
    }
}
