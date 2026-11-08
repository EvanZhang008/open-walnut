import XCTest
@testable import Walnut

/// Guard for the whole class of "the phone forgot what I had open" (the owner, 2026-11-08:
/// whatever was open last, a VP for example, must be what opens next time). The phone's twin
/// of the web's `tests/web/view-memory-guard.test.ts`. It reads the app's own source and fails
/// when a NEW member appears:
///
/// 1. a view choice held in `@State` from a literal: a picker enum of the app (`enum X: String,
///    CaseIterable`), or a name that says it is one (`show…`, `tab`, `mode`, `filter`, `sort…`,
///    `grouping`, `view…`, `scope`), not read through `ViewMemory` and not the flag of a sheet,
///    alert or dialog, unless it is listed below with why;
/// 2. an `@AppStorage` without `store: AppPrefs.defaults` (it would write the demo's choices
///    into the real app's preferences);
/// 3. the app's tab, or the page over an Org node's chat, no longer kept.
final class ViewMemoryGuardTests: XCTestCase {

    /// `path:name` → why it may reset.
    static let allowed: [String: String] = [
        "Views/Calendar/CalendarTabView.swift:mode": "kept by CalendarViewPreference, restored on appear",
        "Views/Calendar/CalendarTabView.swift:filter": "kept by CalendarFilterPreference, restored on appear",
        "Views/Chat/ComposerView.swift:mode": "the composer's mode model, not a choice",
        "Views/Org/OrgThreadsView.swift:showClosed": "the Closed shelf starts shut on purpose: 176 closed threads under the open ones",
        "Views/Sessions/SessionConversationView.swift:showRename": "the rename alert's flag, passed to the menu by binding",
        "Views/Sessions/NewSessionSheet.swift:mode": "a new draft's permission mode, from the draft start rule",
        "Views/Sessions/NewSessionChatView.swift:mode": "a new draft's permission mode, from the draft start rule",
    ]

    private static var appRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut")
    }

    private func sources() throws -> [(path: String, text: String)] {
        guard let walker = FileManager.default.enumerator(at: Self.appRoot, includingPropertiesForKeys: nil) else {
            throw XCTSkip("no source tree at \(Self.appRoot.path)")
        }
        var out: [(String, String)] = []
        for case let url as URL in walker where url.pathExtension == "swift" {
            let relative = String(url.path.dropFirst(Self.appRoot.path.count + 1))
            if relative.hasPrefix("Demo/") { continue }
            out.append((relative, try String(contentsOf: url, encoding: .utf8)))
        }
        XCTAssertGreaterThan(out.count, 50, "the walk found the app's sources")
        return out
    }

    private static func matches(_ pattern: String, _ text: String) -> [[String?]] {
        let regex = try! NSRegularExpression(pattern: pattern)
        let ns = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { m in
            (0..<m.numberOfRanges).map { i in
                let r = m.range(at: i)
                return r.location == NSNotFound ? nil : ns.substring(with: r)
            }
        }
    }

    func testEveryViewChoiceIsKeptOrListed() throws {
        let files = try sources()
        let pickerEnums = Set(files.flatMap { Self.matches(#"enum (\w+)\s*:\s*String\s*,[^{]*CaseIterable"#, $0.text).compactMap { $0[1] } })
        XCTAssertTrue(pickerEnums.contains("OrgNodeTab"), "the enum scan found the app's picker enums")
        let viewName = try NSRegularExpression(pattern: #"^(show[A-Z]\w*|tab|mode|filter|selection|grouping|sort\w*|view\w*|scope)$"#)
        var found: [String] = []
        var seen = Set<String>()
        for (path, text) in files {
            for line in text.components(separatedBy: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                for m in Self.matches(#"@State\s+(?:private\s+)?var\s+(\w+)\s*(?::\s*([\w.]+)\??)?\s*=\s*(.+)"#, line) {
                    guard let name = m[1], let initial = m[3] else { continue }
                    let type = m[2]?.split(separator: ".").last.map(String.init)
                    let named = viewName.firstMatch(in: name, range: NSRange(location: 0, length: (name as NSString).length)) != nil
                    guard named || (type.map(pickerEnums.contains) ?? false) else { continue }
                    if initial.contains("ViewMemory.") { continue }
                    if !Self.matches(#"(isPresented:|item:)\s*\$"# + name + #"\b"#, text).isEmpty { continue }
                    let key = "\(path):\(name)"
                    seen.insert(key)
                    if Self.allowed[key] == nil { found.append(key) }
                }
            }
        }
        XCTAssertEqual(found, [], """
            A view choice in @State resets on every relaunch. Read it from ViewMemory and write \
            each change back (or keep it with @AppStorage(..., store: AppPrefs.defaults)), or list \
            it in ViewMemoryGuardTests.allowed with why: \(found)
            """)
        let stale = Set(Self.allowed.keys).subtracting(seen)
        XCTAssertEqual(stale, [], "listed but no longer found, remove from the list: \(stale)")
    }

    func testEveryAppStorageFollowsTheDemoScope() throws {
        var found: [String] = []
        for (path, text) in try sources() {
            for (i, line) in text.components(separatedBy: "\n").enumerated()
            where line.contains("@AppStorage(") && !line.contains("store: AppPrefs.defaults") {
                found.append("\(path):\(i + 1)")
            }
        }
        XCTAssertEqual(found, [], "an @AppStorage without store: AppPrefs.defaults writes the demo into the real preferences: \(found)")
    }

    func testTheTabAndTheOrgPageAreKept() throws {
        let app = try String(contentsOf: Self.appRoot.appendingPathComponent("App/WalnutApp.swift"), encoding: .utf8)
        XCTAssertTrue(app.contains(#"ViewMemory.read("app", "tab""#), "the launch opens a fixed tab again")
        XCTAssertTrue(app.contains(#"ViewMemory.write(tab, "app", "tab")"#), "a tab change is no longer kept")
        let chat = try String(contentsOf: Self.appRoot.appendingPathComponent("Views/Sessions/SessionConversationView.swift"), encoding: .utf8)
        XCTAssertTrue(chat.contains(#"ViewMemory.write(route?.tab, "org", "page""#), "the page over an Org node's chat is no longer kept")
        XCTAssertTrue(chat.contains(#"ViewMemory.readOptional("org", "page""#), "the kept Org page is no longer put back")
    }

    func testReadWriteRoundTrip() {
        let suite = "view-memory-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(ViewMemory.read("org", "page", id: "n1", initial: OrgNodeTab.threads, defaults: defaults), .threads)
        ViewMemory.write(OrgNodeTab.brief, "org", "page", id: "n1", defaults: defaults)
        XCTAssertEqual(ViewMemory.readOptional("org", "page", id: "n1", as: OrgNodeTab.self, defaults: defaults), .brief)
        XCTAssertNil(ViewMemory.readOptional("org", "page", id: "n2", as: OrgNodeTab.self, defaults: defaults), "kept per node")
        ViewMemory.write(nil as OrgNodeTab?, "org", "page", id: "n1", defaults: defaults)
        XCTAssertNil(ViewMemory.readOptional("org", "page", id: "n1", as: OrgNodeTab.self, defaults: defaults))
        defaults.set("gone-view", forKey: ViewMemory.key("org", "page", id: "n1"))
        XCTAssertEqual(ViewMemory.read("org", "page", id: "n1", initial: OrgNodeTab.tasks, defaults: defaults), .tasks,
                       "a kept word no case has any more falls back")
    }
}
