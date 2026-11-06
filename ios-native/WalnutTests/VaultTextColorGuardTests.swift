import XCTest

/// Passwords' rows are buttons (tap to copy, tap to fill). Inside a button, a hierarchical
/// style (`.primary`, `.secondary`) is a level of the button's own colour, the app's tint, so
/// every label and value read pale brown (2026-11-06). These views name the label colours
/// themselves (`Color.primary`, `Color.secondary`); this fails on a new hierarchical one.
final class VaultTextColorGuardTests: XCTestCase {
    func testPasswordsViewsNeverUseATintRelativeTextStyle() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let dirs = ["Shared/VaultUI", "Walnut/Views/Passwords", "WalnutAutoFill"]
        let pattern = try NSRegularExpression(pattern: #"foregroundStyle\(\s*\.(primary|secondary|tertiary|quaternary)\b"#)
        var files = 0
        var hits: [String] = []
        for dir in dirs {
            let url = root.appendingPathComponent(dir)
            let names = try FileManager.default.contentsOfDirectory(atPath: url.path).filter { $0.hasSuffix(".swift") }
            for name in names {
                let text = try String(contentsOf: url.appendingPathComponent(name), encoding: .utf8)
                files += 1
                for (i, line) in text.components(separatedBy: "\n").enumerated()
                where pattern.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil {
                    hits.append("\(dir)/\(name):\(i + 1)")
                }
            }
        }
        XCTAssertGreaterThanOrEqual(files, 6, "the Passwords sources moved: point this test at them")
        XCTAssertEqual(hits, [], "use Color.primary / Color.secondary: a hierarchical style takes the button's tint")
    }

    /// A Passwords screen pushed on top of the lock stays on the navigation stack when the
    /// vault locks, so each screen that shows vault content (each one with the privacy cover)
    /// must lock itself too. This fails on a new screen that has the cover but not the gate.
    func testEveryPasswordsScreenLocksItself() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let dir = root.appendingPathComponent("Walnut/Views/Passwords")
        var screens = 0
        var missing: [String] = []
        for name in try FileManager.default.contentsOfDirectory(atPath: dir.path) where name.hasSuffix(".swift") {
            let text = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
            let covers = text.components(separatedBy: ".vaultPrivacyCover()").count - 1
            let gates = text.components(separatedBy: ".vaultGate()").count - 1
            screens += covers
            if gates < covers { missing.append("\(name): \(covers) covered, \(gates) gated") }
        }
        XCTAssertGreaterThanOrEqual(screens, 3, "the Passwords screens moved: point this test at them")
        XCTAssertEqual(missing, [], "add .vaultGate() beside .vaultPrivacyCover()")
    }
}
