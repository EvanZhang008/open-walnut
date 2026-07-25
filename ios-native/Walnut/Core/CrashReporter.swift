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

    /// Build number of the process that is receiving the diagnostic — NOT the
    /// build that crashed. MetricKit delivers a previous launch's diagnostic, so
    /// after a TestFlight update these differ and reporting only this value
    /// mislabels an old-build crash as a new-build crash.
    private static var receivingBuild: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
    }

    /// Fingerprints of diagnostics already uploaded, so a kill between the
    /// successful POST and the follow-up persist can't inflate crash counts by
    /// re-reporting the same diagnostic on the next launch.
    private static let seenKey = "crash-fingerprints"
    private static let maxRememberedFingerprints = 60
    private var seenFingerprints: [String] = DiskCache.load([String].self, key: CrashReporter.seenKey) ?? []

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        var reported = 0
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                let stack = Self.compactStack(crash.callStackTree)
                // `applicationBuildVersion` is the build that actually crashed;
                // the running build rides along separately as receivedByBuild.
                let originBuild = crash.metaData.applicationBuildVersion
                let fingerprint = Self.fingerprint([
                    "crash",
                    crash.exceptionType.map(String.init) ?? "?",
                    crash.signal.map(String.init) ?? "?",
                    crash.terminationReason ?? "?",
                    originBuild,
                ], stack: stack)
                guard remember(fingerprint) else { continue }
                reported += 1
                AppLog.error("crash", "crash from previous launch", [
                    "signal": crash.signal.map(String.init) ?? "?",
                    "exceptionType": crash.exceptionType.map(String.init) ?? "?",
                    "exceptionCode": crash.exceptionCode.map(String.init) ?? "?",
                    "terminationReason": crash.terminationReason ?? "?",
                    "appVersion": crash.applicationVersion,
                    "build": originBuild,
                    "receivedByBuild": Self.receivingBuild,
                    "fingerprint": fingerprint,
                    "stack": stack,
                ])
            }
            for hang in payload.hangDiagnostics ?? [] {
                let stack = Self.compactStack(hang.callStackTree)
                let originBuild = hang.metaData.applicationBuildVersion
                let fingerprint = Self.fingerprint([
                    "hang",
                    String(format: "%.1f", hang.hangDuration.value),
                    originBuild,
                ], stack: stack)
                guard remember(fingerprint) else { continue }
                reported += 1
                AppLog.error("crash", "hang from previous launch", [
                    "duration": "\(hang.hangDuration)",
                    "build": originBuild,
                    "receivedByBuild": Self.receivingBuild,
                    "fingerprint": fingerprint,
                    "stack": stack,
                ])
            }
        }
        guard reported > 0 else { return }
        // Crash forensics must survive a follow-up crash AND reach the server
        // promptly: persist to disk first, then push immediately instead of
        // waiting for the next background/threshold trigger.
        AppLog.shared.persistNow()
        AppLog.shared.uploadIfNeeded(force: true)
    }

    /// Record a fingerprint; returns false when it was already reported.
    private func remember(_ fingerprint: String) -> Bool {
        guard !seenFingerprints.contains(fingerprint) else { return false }
        seenFingerprints.append(fingerprint)
        if seenFingerprints.count > Self.maxRememberedFingerprints {
            seenFingerprints.removeFirst(seenFingerprints.count - Self.maxRememberedFingerprints)
        }
        DiskCache.save(seenFingerprints, key: Self.seenKey)
        return true
    }

    /// Stable identity for a diagnostic: the classification fields plus the
    /// first 5 frames of the attributed thread (deeper frames drift with
    /// binary layout across builds, the top of the stack does not).
    private static func fingerprint(_ fields: [String], stack: String) -> String {
        let frames = stack
            .split(separator: "\n")
            .filter { !$0.hasPrefix("--- thread") }
            .prefix(5)
            .joined(separator: "|")
        return (fields + [frames]).joined(separator: "~")
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
