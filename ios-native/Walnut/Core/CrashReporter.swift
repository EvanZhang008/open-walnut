import Foundation
import MetricKit

/// Crash-diagnostics closer for TestFlight builds. TestFlight's own crash
/// feedback lands in App Store Connect where the crash log payload is often
/// unavailable via API, and `AppLog`'s buffer dies with the process on a hard
/// crash — so crashes were invisible to us. MetricKit delivers crash (and
/// hang) diagnostics from the PREVIOUS launch, which we forward through the
/// existing AppLog → `/api/v1/client-logs` pipeline: every crash shows up in
/// `/tmp/open-walnut/ios-client/<device>-<day>.log` on the server, stack
/// included, no user action needed.
final class CrashReporter: NSObject, MXMetricManagerSubscriber {
    static let shared = CrashReporter()

    /// Call once at app startup.
    func start() {
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                AppLog.error("crash", "crash from previous launch", [
                    "signal": crash.signal.map(String.init) ?? "?",
                    "exceptionType": crash.exceptionType.map(String.init) ?? "?",
                    "exceptionCode": crash.exceptionCode.map(String.init) ?? "?",
                    "terminationReason": crash.terminationReason ?? "?",
                    "appVersion": crash.applicationVersion,
                    "stack": Self.compactStack(crash.callStackTree),
                ])
            }
            for hang in payload.hangDiagnostics ?? [] {
                AppLog.error("crash", "hang from previous launch", [
                    "duration": "\(hang.hangDuration)",
                    "stack": Self.compactStack(hang.callStackTree),
                ])
            }
        }
        // Crash forensics shouldn't wait for the next background/threshold
        // trigger — push now while we have the user's attention span.
        AppLog.shared.uploadIfNeeded(force: true)
    }

    /// AppLog meta is [String:String] with modest line sizes — flatten the
    /// call-stack tree JSON and cap it. The full tree is huge (all threads,
    /// full offsets); the first chunk carries the crashing frames, which is
    /// what actually identifies the bug.
    private static func compactStack(_ tree: MXCallStackTree) -> String {
        let json = String(data: tree.jsonRepresentation(), encoding: .utf8) ?? "?"
        return String(json.prefix(6_000))
    }
}
