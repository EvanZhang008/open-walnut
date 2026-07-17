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
                    "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?",
                    "stack": Self.compactStack(crash.callStackTree),
                ])
            }
            for hang in payload.hangDiagnostics ?? [] {
                AppLog.error("crash", "hang from previous launch", [
                    "duration": "\(hang.hangDuration)",
                    "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?",
                    "stack": Self.compactStack(hang.callStackTree),
                ])
            }
        }
        // Crash forensics must survive a follow-up crash AND reach the server
        // promptly: persist to disk first, then push immediately instead of
        // waiting for the next background/threshold trigger.
        AppLog.shared.persistNow()
        AppLog.shared.uploadIfNeeded(force: true)
    }

    /// Flatten the call-stack tree to one "uuid+offset" frame per line —
    /// the raw jsonRepresentation is so indentation-heavy that a 6000-char
    /// cap barely covered 30 frames of JSON noise and cut off the frames
    /// that identify the bug. The attributed (crashing) thread comes first;
    /// symbolicate later with the archived dSYM (see apple-dev skill).
    private static func compactStack(_ tree: MXCallStackTree) -> String {
        guard let root = try? JSONSerialization.jsonObject(with: tree.jsonRepresentation()) as? [String: Any],
              let stacks = root["callStacks"] as? [[String: Any]]
        else { return "unparseable" }

        var lines: [String] = []
        func walk(_ frames: [[String: Any]], depth: Int) {
            for frame in frames {
                guard lines.count < 80 else { return }
                let uuid = (frame["binaryUUID"] as? String)?.prefix(8) ?? "?"
                let name = frame["binaryName"] as? String ?? ""
                let offset = frame["offsetIntoBinaryTextSegment"] as? Int ?? 0
                lines.append("\(name.isEmpty ? String(uuid) : name)+\(offset)")
                if let sub = frame["subFrames"] as? [[String: Any]] {
                    walk(sub, depth: depth + 1)
                }
            }
        }
        // Attributed thread (the one that crashed/hung) first, others after.
        let ordered = stacks.sorted { ($0["threadAttributed"] as? Bool ?? false) && !($1["threadAttributed"] as? Bool ?? false) }
        for (i, stack) in ordered.enumerated() {
            guard lines.count < 80 else { break }
            let attributed = stack["threadAttributed"] as? Bool ?? false
            lines.append("--- thread\(i)\(attributed ? " (attributed)" : "") ---")
            walk(stack["callStackRootFrames"] as? [[String: Any]] ?? [], depth: 0)
        }
        return lines.joined(separator: "\n")
    }
}
