import XCTest
@testable import Walnut

/// Guard for the whole class of "a task's status drawn some other way" (2026-11-21, the user:
/// he could not tell Working from Not started; the lead: one status icon everywhere, every
/// state its own shape, Working moving). The phone's twin of the web's status icon guard. It
/// reads the app's, the widget's and the shared sources and fails when a NEW member appears:
///
/// 1. a `Circle()` or an `Image(systemName:)` whose colour or symbol comes from a task's state
///    (its user status, phase, done flag, or a state colour), instead of `TaskStateIcon`;
/// 2. a retired status symbol ("circle.lefthalf.filled", the work card's hammer and hand);
/// 3. a done / not done symbol pair picked from a task's state;
/// 4. a state colour used outside the icon in a file not listed below with why;
/// 5. a surface that wore the icon going back to something else, and the widget extension
///    losing the icon's source file.
///
/// Plus the mapping from the task model to the icon, over every state.
final class TaskStateIconGuardTests: XCTestCase {

    /// Files that use a state colour for something that is no status mark, with why.
    static let colourAllowed: [String: String] = [
        "Walnut/Views/Chat/ChatDrawerOrg.swift": "the needs and working count badges: numbers on a capsule",
        "Walnut/Views/Org/OrgNodePage.swift": "the Threads tab's count badge",
        "Walnut/Views/Tasks/WorkCardSheet.swift": "the chosen list chip's fill and outline, beside its TaskStateIcon",
        "Walnut/Timeline/TimelineRowBuilder.swift": "the About pills' dot is a glyph in UIKit attributed text, laid out off the main actor; it takes the icon's colour",
    ]

    /// Every surface that draws a task's state, all through the icon.
    static let surfaces = [
        "Walnut/Views/Tasks/TeamStatusViews.swift",
        "Walnut/Views/Tasks/TaskBoardRow.swift",
        "Walnut/Views/Tasks/TaskRow.swift",
        "Walnut/Views/Tasks/TaskDetailSheet.swift",
        "Walnut/Views/Tasks/TaskDetailExtras.swift",
        "Walnut/Views/Tasks/BoardStatusSectionViews.swift",
        "Walnut/Views/Tasks/WorkCardSheet.swift",
        "Walnut/Views/Calendar/CalendarRows.swift",
        "Walnut/Views/Sessions/SessionTaskRow.swift",
        "Walnut/Views/Org/OrgNodeTasksView.swift",
        "Walnut/Views/Org/OrgThreadsView.swift",
        "Walnut/Views/Chat/ChatDrawerOrg.swift",
        "WalnutWidgets/WorkCardLiveActivity.swift",
    ]

    private static var root: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    /// The app's, the shared and the widget's sources, the demo and the icon itself left out.
    private func sources() throws -> [(path: String, text: String)] {
        var out: [(String, String)] = []
        for dir in ["Walnut", "Shared", "WalnutWidgets"] {
            let base = Self.root.appendingPathComponent(dir)
            guard let walker = FileManager.default.enumerator(at: base, includingPropertiesForKeys: nil) else {
                throw XCTSkip("no source tree at \(base.path)")
            }
            for case let url as URL in walker where url.pathExtension == "swift" {
                let relative = String(url.path.dropFirst(Self.root.path.count + 1))
                if relative.hasPrefix("Walnut/Demo/") || url.lastPathComponent == "TaskStateIcon.swift" { continue }
                out.append((relative, try String(contentsOf: url, encoding: .utf8)))
            }
        }
        XCTAssertGreaterThan(out.count, 50, "the walk found the app's sources")
        return out
    }

    private static func regex(_ pattern: String) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern)
    }

    private static func firstMatch(_ re: NSRegularExpression, _ text: String) -> NSRange? {
        re.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length))?.range
    }

    /// A shape or symbol (2), a retired symbol (2) or a done pair (3) drawn from a task's state.
    func testNoTaskStatusIsDrawnWithoutTheIcon() throws {
        let mark = Self.regex(#"Circle\(\)|Image\(systemName:"#)
        let stateSource = Self.regex(#"UserStatePill\.color\(|\.iconState\b|TaskIconState|TeamStatusModel\.state\(|statusKind|userStatus|\bUserState\b|isDone|\.phase\b"#)
        let donePair = Self.regex(#"Image\(systemName:\s*[\w.!]*(?:[Dd]one|statusKind|phase)\b[^?]*\?\s*"[\w.]*circle"#)
        let retired = [#""circle.lefthalf.filled""#, #""hammer.circle"#, #""hand.raised.circle"#]
        var found: [String] = []
        for (path, text) in try sources() {
            let lines = text.components(separatedBy: "\n")
            for (i, line) in lines.enumerated() where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                for symbol in retired where line.contains(symbol) { found.append("\(path):\(i + 1) retired \(symbol)") }
                if Self.firstMatch(donePair, line) != nil { found.append("\(path):\(i + 1) a done pair") }
                guard let at = Self.firstMatch(mark, line) else { continue }
                // The mark's expression: from the mark on, and the modifier lines under it.
                var expression = (line as NSString).substring(from: at.location)
                var j = i + 1
                while j < lines.count, lines[j].trimmingCharacters(in: .whitespaces).hasPrefix(".") {
                    expression += "\n" + lines[j]
                    j += 1
                }
                if Self.firstMatch(stateSource, expression) != nil { found.append("\(path):\(i + 1)") }
            }
        }
        XCTAssertEqual(found, [], "a task's state is drawn without TaskStateIcon: draw TaskStateIcon(state: TeamStatusModel.iconState(of: task)) instead: \(found)")
    }

    /// (4) A state colour outside the icon is a status mark in the making, unless listed with why.
    func testEveryStateColourUseIsListed() throws {
        let colour = Self.regex(#"UserStatePill\.color\(|\.iconState\.color|\.icon\.(?:ui)?[cC]olor"#)
        var seen = Set<String>()
        for (path, text) in try sources() where path != "Walnut/Views/Tasks/TeamStatusViews.swift" {
            for line in text.components(separatedBy: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                if Self.firstMatch(colour, line) != nil { seen.insert(path) }
            }
        }
        let unlisted = seen.subtracting(Self.colourAllowed.keys)
        XCTAssertEqual(unlisted, [], "a state colour drawn outside TaskStateIcon: draw the icon, or list the file in colourAllowed with why: \(unlisted.sorted())")
        let stale = Set(Self.colourAllowed.keys).subtracting(seen)
        XCTAssertEqual(stale, [], "listed but no longer found, remove from the list: \(stale.sorted())")
    }

    /// (5) The surfaces keep the icon, and the widget extension compiles its source.
    func testTheSurfacesWearTheIcon() throws {
        for path in Self.surfaces {
            let text = try String(contentsOf: Self.root.appendingPathComponent(path), encoding: .utf8)
            XCTAssertTrue(text.contains("TaskStateIcon("), "\(path) no longer draws its task states with TaskStateIcon")
        }
        let project = try String(contentsOf: Self.root.appendingPathComponent("project.yml"), encoding: .utf8)
        XCTAssertTrue(project.contains("- path: Shared/TaskStateIcon.swift"), "the widget extension lost the icon's source file")
        let icon = try String(contentsOf: Self.root.appendingPathComponent("Shared/TaskStateIcon.swift"), encoding: .utf8)
        XCTAssertTrue(icon.contains("accessibilityReduceMotion"), "Working's breathing no longer stops under Reduce Motion")
    }

    // MARK: - The mapping

    private func task(
        phase: String = "IN_PROGRESS", status: String = "in_progress", user: WalnutUserStatus? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: "t", title: "Task", status: status, phase: phase, priority: "none", project: "Walnut",
            dueDate: nil, createdAt: "2026-11-20T00:00:00Z", updatedAt: "2026-11-21T00:00:00Z", completedAt: nil,
            starred: nil, pinned: nil, tags: nil, summary: nil, parentTaskId: nil, userStatus: user
        )
    }

    func testEveryStateMapsFromTheTask() {
        let cases: [(String, WalnutTask, TaskIconState)] = [
            ("asks the user", task(phase: "NEED_ACTION", user: .init(state: "needs", ask: "Approve?")), .needs),
            ("a result to read", task(phase: "WAITING", user: .init(state: "read", toRead: "result")), .read),
            ("to read from an older server", task(phase: "WAITING", user: .init(state: "waiting", toRead: "answer")), .read),
            ("its session runs", task(user: .init(state: "working")), .working),
            ("waits on another task", task(phase: "WAITING", user: .init(state: "waiting", kind: "task", waitingOn: "Its worker")), .waiting),
            ("stuck is a kind of waiting", task(phase: "WAITING", user: .init(state: "waiting", kind: "stuck")), .waiting),
            ("snoozed by a start date", task(phase: "TODO", user: .init(state: "waiting", snoozed: .init(until: "2026-12-01"))), .snoozed),
            ("a snooze wins over to read", task(phase: "WAITING", user: .init(state: "waiting", snoozed: .init(until: "2026-12-01"), toRead: "result")), .snoozed),
            ("nobody started it", task(phase: "TODO", status: "todo", user: .init(state: "waiting", kind: "not-started")), .todo),
            ("finished", task(phase: "COMPLETE", status: "done"), .done),
            ("finished wins over an old ask", task(phase: "COMPLETE", status: "done", user: .init(state: "needs", ask: "Approve?")), .done),
            // No status this build reads: the phase.
            ("phase IN_PROGRESS", task(phase: "IN_PROGRESS"), .working),
            ("phase NEED_ACTION", task(phase: "NEED_ACTION"), .needs),
            ("phase WAITING", task(phase: "WAITING"), .waiting),
            ("phase TODO", task(phase: "TODO", status: "todo"), .todo),
            ("a state this build does not know", task(phase: "TODO", status: "todo", user: .init(state: "someday")), .todo),
        ]
        for (name, t, want) in cases {
            XCTAssertEqual(TeamStatusModel.iconState(of: t), want, name)
        }
        XCTAssertEqual(Set(cases.map { $0.2 }), Set(TaskIconState.allCases), "every icon state is reached from a task")
    }

    func testARowsGroupDecidesItsIcon() {
        // A work card list puts its rows in its own group, whatever the status says now.
        let running = task(user: .init(state: "working"))
        XCTAssertEqual(TeamStatusModel.iconState(TeamStatusRow(task: running, state: .needs, status: running.userStatus, depth: 1)), .needs)
        XCTAssertEqual(TeamStatusModel.iconState(TeamStatusRow(task: running, state: .done, status: nil, depth: 1)), .done)
        // Inside Waiting / snoozed the status tells the three apart.
        let fresh = task(phase: "TODO", status: "todo", user: .init(state: "waiting", kind: "not-started"))
        XCTAssertEqual(TeamStatusModel.iconState(TeamStatusRow(task: fresh, state: .waiting, status: fresh.userStatus, depth: 1)), .todo)
        // No status this build reads: only a TODO was never started (the web's waitFacts).
        XCTAssertEqual(TeamStatusModel.iconState(.waiting, status: nil, phase: "TODO"), .todo)
        XCTAssertEqual(TeamStatusModel.iconState(.waiting, status: nil, phase: "WAITING"), .waiting)
        XCTAssertEqual(TeamStatusModel.iconState(.waiting, status: nil, phase: "NEED_ACTION"), .waiting)
        let toRead = task(phase: "WAITING", user: .init(state: "read", toRead: "result"))
        XCTAssertEqual(TeamStatusModel.iconState(TeamStatusRow(task: toRead, state: .needs, status: toRead.userStatus, depth: 1)), .read)
    }

    /// A board row under a status section wears its section's icon, the web's `sectionIconState`.
    func testABoardSectionDecidesItsRowsIcon() {
        XCTAssertEqual(BoardStatusSectionModel.iconState(.read, in: .needs), .read)
        XCTAssertEqual(BoardStatusSectionModel.iconState(.working, in: .needs), .needs)
        XCTAssertEqual(BoardStatusSectionModel.iconState(.working, in: .waiting), .waiting)
        XCTAssertEqual(BoardStatusSectionModel.iconState(.needs, in: .waiting), .waiting)
        XCTAssertEqual(BoardStatusSectionModel.iconState(.snoozed, in: .waiting), .snoozed)
        XCTAssertEqual(BoardStatusSectionModel.iconState(.todo, in: .waiting), .todo)
        XCTAssertEqual(BoardStatusSectionModel.iconState(.working, in: .done), .done)
        // A band, Watching and Background hold every state: the task's own.
        for own in TaskIconState.allCases {
            XCTAssertEqual(BoardStatusSectionModel.iconState(own, in: nil), own)
            XCTAssertEqual(BoardStatusSectionModel.iconState(own, in: .watching), own)
            XCTAssertEqual(BoardStatusSectionModel.iconState(own, in: .background), own)
        }
    }

    func testASnapshotMapsFromItsPhase() {
        XCTAssertEqual(TeamStatusModel.iconState(phase: "IN_PROGRESS", status: nil), .working)
        XCTAssertEqual(TeamStatusModel.iconState(phase: "NEED_ACTION", status: nil), .needs)
        XCTAssertEqual(TeamStatusModel.iconState(phase: "WAITING", status: nil), .waiting)
        XCTAssertEqual(TeamStatusModel.iconState(phase: "TODO", status: "todo"), .todo)
        XCTAssertEqual(TeamStatusModel.iconState(phase: nil, status: "done"), .done)
        XCTAssertEqual(TeamStatusModel.iconState(phase: nil, status: nil), .todo)
    }

    /// One word per state, and the app's other state words are the icon's.
    func testTheWordsAreOneTable() {
        XCTAssertEqual(TaskIconState.allCases.map(\.label),
                       ["Needs you", "To read", "Working", "Waiting", "Snoozed", "Not started", "Completed"])
        XCTAssertEqual(UserState.needs.label, TaskIconState.needs.label)
        XCTAssertEqual(UserState.working.label, TaskIconState.working.label)
        XCTAssertEqual(UserState.done.label, TaskIconState.done.label)
        XCTAssertEqual(TeamStatusModel.notStartedLabel, TaskIconState.todo.label)
        XCTAssertEqual(WorkCardList.allCases.map(\.label), ["Working", "Needs you", "Completed"])
        XCTAssertEqual(UserState.allCases.map(\.icon), [.needs, .read, .working, .waiting, .done])
    }

    /// Working is always green, Needs you always red, To read amber, the rest grey.
    func testTheColours() {
        XCTAssertEqual(TaskIconState.needs.uiColor, .systemRed)
        XCTAssertEqual(TaskIconState.working.uiColor, .systemGreen)
        XCTAssertEqual(TaskIconState.read.uiColor, .systemOrange)
        for quiet in [TaskIconState.waiting, .snoozed, .todo, .done] {
            XCTAssertEqual(quiet.uiColor, .systemGray, quiet.rawValue)
        }
    }
}
