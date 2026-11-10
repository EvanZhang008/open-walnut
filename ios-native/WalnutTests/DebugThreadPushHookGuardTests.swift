import XCTest

/// Guard for the UI tests' thread push hook (`DebugThreadPushLink`, `DebugRevealMarker`,
/// `ThreadPushLiveUITests`): it exists only in DEBUG builds, and it arms a thread push exactly
/// as the notification delegate does, so what the UI tests prove about a running app is what a
/// real tap does. Reads the app's own source.
final class DebugThreadPushHookGuardTests: XCTestCase {

    private static var appRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut")
    }

    private static func source(_ relative: String) throws -> String {
        try String(contentsOf: appRoot.appendingPathComponent(relative), encoding: .utf8)
    }

    /// Each line of `text` with whether it sits inside a `#if DEBUG` branch.
    static func debugLines(_ text: String) -> [(line: String, inDebug: Bool)] {
        var stack: [Bool] = [] // per open #if: whether the branch being read is a DEBUG one
        var out: [(String, Bool)] = []
        for raw in text.components(separatedBy: "\n") {
            let t = raw.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("#if ") {
                stack.append(t == "#if DEBUG")
            } else if t.hasPrefix("#elseif") || t == "#else" {
                if !stack.isEmpty { stack[stack.count - 1] = false }
            } else if t.hasPrefix("#endif") {
                if !stack.isEmpty { stack.removeLast() }
            }
            out.append((raw, stack.contains(true)))
        }
        return out
    }

    func testTheHookIsCompiledOnlyIntoDebugBuilds() throws {
        guard let walker = FileManager.default.enumerator(at: Self.appRoot, includingPropertiesForKeys: nil) else {
            throw XCTSkip("no source tree at \(Self.appRoot.path)")
        }
        let names = ["DebugThreadPushLink", "DebugRevealMarker", "DebugRevealRecord", "DebugSwapPhaseMarker", "debugThreadPushKey)"]
        var uses = 0
        for case let url as URL in walker where url.pathExtension == "swift" {
            let text = try String(contentsOf: url, encoding: .utf8)
            for (i, entry) in Self.debugLines(text).enumerated() {
                let code = entry.line.trimmingCharacters(in: .whitespaces)
                guard !code.hasPrefix("//"), names.contains(where: { code.contains($0) }) else { continue }
                uses += 1
                XCTAssertTrue(entry.inDebug, "\(url.lastPathComponent):\(i + 1) uses the debug thread push hook outside #if DEBUG")
            }
        }
        // The definitions, the two link entry points, the card's mark and the launch argument's read.
        XCTAssertGreaterThanOrEqual(uses, 6, "the walk found the hook's uses")
    }

    func testTheHookArmsAThreadPushTheWayTheNotificationDelegateDoes() throws {
        let router = try Self.source("Core/LetterDeepLink.swift")
        let start = try XCTUnwrap(router.range(of: "didReceive response: UNNotificationResponse"), "the tap callback")
        let rest = router[start.upperBound...]
        let body = rest[..<(rest.range(of: "func userNotificationCenter(")?.lowerBound ?? rest.endIndex)]
        let hook = try Self.source("App/DebugThreadPushLink.swift")
        for line in [
            "guard let thread = ThreadDeepLink.target(fromPush: userInfo) else { return",
            "ThreadDeepLink.shared.arm(thread, source: ThreadDeepLink.tapSource)",
        ] {
            XCTAssertTrue(body.contains(line), "the notification delegate no longer reads: \(line)")
            XCTAssertTrue(hook.contains(line), "the debug hook no longer reads: \(line)")
        }
        // It hands the tap to the mailbox and nothing further: no step of the open is its own.
        let code = hook.components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
        for shortcut in ["OrgNodeLink", "OrgNodePageLink", "deliverPending", "openThread", "pending ="] {
            XCTAssertFalse(code.contains(shortcut),"the debug hook takes a step a real tap leaves to the app: \(shortcut)")
        }
    }

    func testTheLineCounterReadsNestedBranches() {
        let text = "a\n#if DEBUG\nb\n#if os(iOS)\nc\n#endif\n#else\nd\n#endif\ne"
        let marks = Self.debugLines(text).map(\.inDebug)
        XCTAssertEqual(marks, [false, true, true, true, true, true, false, false, false, false])
    }
}
