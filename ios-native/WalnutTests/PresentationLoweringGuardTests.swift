import XCTest
@testable import Walnut

/// Guard for "a push opened its page under a sheet that stayed up" (2026-11-08 review, round 1:
/// Session Controls over the pushed thread; a task's details and the Tasks draft on another tab)
/// and for "a push tore down the view under a sheet holding his words" (round 2: a task's
/// description being edited, a VP's instructions, a session note). A push navigation goes through
/// ONE gate, `OrgNodeLink`, which lowers every presentation first through
/// `PresentationLowering.lowerForNavigation` (closing the app window's presentation chain from its
/// root), or HOLDS the request while a sheet keeps unsaved work. This reads the app's own source
/// and fails when a new piece breaks that:
///
///  1. Every `.sheet`, `.fullScreenCover` and `.popover` is presented on the app window's chain:
///     nothing makes a view controller its own presentation context (`definesPresentationContext`,
///     a current-context style), and the only other window is the Talk panel's, listed.
///  2. A sheet refuses to close only through `holdsNavigation` (never a bare
///     `interactiveDismissDisabled`), and every one is listed with the view that hosts it and why.
///  3. No push reaches a host while such a sheet is up: the gate publishes a request in one place,
///     after it asked whether a sheet holds his work, and the pages only ever take requests that
///     came out of it. The push navigation selects Chat only for a request past the gate, and the
///     work card link reads the same rule.
final class PresentationLoweringGuardTests: XCTestCase {

    private static var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func appSources() throws -> [(path: String, code: [String])] {
        let root = Self.iosRoot.appendingPathComponent("Walnut")
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else {
            throw XCTSkip("no source tree at \(root.path)")
        }
        var out: [(String, [String])] = []
        for case let url as URL in walker where url.pathExtension == "swift" {
            let relative = String(url.path.dropFirst(Self.iosRoot.path.count + 1))
            let lines = try String(contentsOf: url, encoding: .utf8).components(separatedBy: "\n")
            // Code only: a comment that names a modifier is no use of it.
            let code = lines.map { line -> String in
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.hasPrefix("//") || t.hasPrefix("///") || t.hasPrefix("*") { return "" }
                if let r = line.range(of: " // ") { return String(line[..<r.lowerBound]) }
                return line
            }
            out.append((relative, code))
        }
        XCTAssertGreaterThan(out.count, 50, "the walk found the app's sources")
        return out
    }

    private static func count(_ needle: String, in code: [String]) -> Int {
        code.reduce(0) { $0 + $1.components(separatedBy: needle).count - 1 }
    }

    /// Sheets that refuse to close hold a navigation until he saves or closes them, on purpose.
    /// File → how many, the view that hosts them (what a push would tear down), and why.
    private static let holdsANavigation: [String: (count: Int, host: String, why: String)] = [
        "Walnut/App/WalnutApp.swift": (1, "the tab view", "an approval a script waits on, while it is pending: a decision he owes"),
        "Walnut/Views/Calendar/CalendarCreateSheet.swift": (1, "the calendar", "an event being created, or a title, project or time he has not added"),
        "Walnut/Views/Chat/ComposerView.swift": (1, "the chat's composer", "the camera, while it is up: a photo being taken or not yet used"),
        "Walnut/Views/Shared/ReplyPictures.swift": (1, "a reply's picture row", "the camera, while it is up: a photo being taken or not yet used"),
        "Walnut/Views/Sessions/AgentMemorySheet.swift": (1, "a node's chat (SessionConversationView)", "instructions he edited and did not save, or a save running"),
        "Walnut/Views/Sessions/Changes/DiffReviewViews.swift": (2, "a file's diff (SessionFileDiffView) and the Changed page (SessionChangesSheet)", "a line comment he wrote and did not add, or a review being sent"),
        "Walnut/Views/Sessions/NewSessionChatView.swift": (1, "the Tasks tab", "a session being created, or a folder, mode, model, project or sync he picked"),
        "Walnut/Views/Sessions/NewSessionSheet.swift": (1, "the Tasks tab", "a session being created, its first message on its way, or words and picks he has not started"),
        "Walnut/Views/Sessions/SessionComposerSheets.swift": (2, "a session's chat (SessionConversationView)", "a fork running or its words not sent; a session note he changed and did not save"),
        "Walnut/Views/Sessions/SessionExtrasSheets.swift": (1, "a session's chat (SessionConversationView)", "a side question being written, asked or its voice transcribed"),
        "Walnut/Views/Sessions/SessionPathPicker.swift": (1, "the new session page", "a path he typed and did not pick"),
        "Walnut/Views/Sessions/SessionQueueViews.swift": (1, "a session's chat (SessionConversationView)", "a queued message he edited and did not save"),
        "Walnut/Views/Tasks/TaskDetailSheet.swift": (2, "wherever a task's details open", "a title being renamed; a due day picked and not Set"),
        "Walnut/Views/Tasks/TaskFieldEditorSheet.swift": (1, "a task's details (TaskDetailSheet, also inside a node page's task session)", "the task's description or note editor: words he changed"),
        "Walnut/Views/Tasks/TaskProjectPicker.swift": (1, "a task's details or the new session page", "a new project's name being typed"),
    ]

    /// How each file that takes his input keeps it from a push navigation, which closes whatever
    /// is presented (2026-11-08 review, round 3: the calendar's create sheet lost a typed title and
    /// a moved time). A file that takes input is listed here, or this fails.
    private enum Keeps {
        /// A sheet that holds the push while it has unsaved input (`.holdsNavigation(<dirty>)`).
        case holds
        /// A draft kept outside the view, which the view opens on again: the token names its store.
        case draft(String)
        /// Every change is applied as it is made: nothing is unsaved.
        case savedOnChange
        /// A binding into the page that shows it, which keeps it (named in `why`).
        case parentKeeps
        /// Not presented: a tab's own page or a pushed page, which a push does not close.
        case notPresented
        /// An alert's text field: an alert cannot hold, so its words stay in the state behind it
        /// until his own Cancel or answer ends them, and it opens on them again.
        case alert
    }

    private static let inputKeeping: [String: (keeps: Keeps, why: String)] = [
        "Walnut/Views/Calendar/CalendarCreateSheet.swift": (.holds, "CalendarCreate.edited: a title, project, moved time, all-day or sync change"),
        "Walnut/Views/Calendar/CalendarFilterSheet.swift": (.savedOnChange, "each toggle is the calendar's filter, applied at once"),
        "Walnut/Views/Calendar/CalendarRows.swift": (.notPresented, "the month view's quick-add row, on the Calendar tab itself"),
        "Walnut/Views/Calendar/CalendarTabView.swift": (.notPresented, "the tab's own view switch"),
        "Walnut/Views/Chat/ChatDrawer.swift": (.alert, "rename: renameDraftFor keeps his words for the same chat; the agent switch applies at once"),
        "Walnut/Views/Chat/ChatView.swift": (.alert, "the first-message dialogs: their words stay for the same node (orgFirstMessageFor)"),
        "Walnut/Views/Chat/ComposerView.swift": (.draft("ComposerDrafts"), "the composer's words and pictures; the camera holds a push while up"),
        "Walnut/Views/Inbox/CeoNoteSheet.swift": (.draft("ComposerDrafts"), "the note to the CEO, per letter"),
        "Walnut/Views/Inbox/InboxItemConfirmation.swift": (.draft("InboxItemStore"), "the item's fields, per item and action, in the app-wide store"),
        "Walnut/Views/Inbox/InboxItemTaskSelector.swift": (.draft("InboxItemStore"), "the search and the pick, in the app-wide store"),
        "Walnut/Views/Inbox/LetterReaderView.swift": (.notPresented, "a pushed page; its reply is kept by LetterReplyStore"),
        "Walnut/Views/Notes/NoteEditorView.swift": (.savedOnChange, "the raw Markdown sheet's edits are adopted on any dismiss (adoptRawEdits)"),
        "Walnut/Views/Notes/NotesView.swift": (.alert, "New Note: the name stays until Create or Cancel; the search is the tab's own"),
        "Walnut/Views/Org/OrgNodePage.swift": (.notPresented, "the page's own view switch"),
        "Walnut/Views/Org/OrgNodeTasksView.swift": (.savedOnChange, "its grouping is kept in AppStorage"),
        "Walnut/Views/Org/OrgThreadsView.swift": (.draft("ComposerDrafts"), "a Follow up's words and pictures, per thread"),
        "Walnut/Views/Passwords/PasswordsSetupView.swift": (.notPresented, "a page pushed from Settings"),
        "Walnut/Views/Passwords/PasswordsHomeView.swift": (.notPresented, "its search, on a pushed page"),
        "Walnut/Views/Sessions/AgentMemorySheet.swift": (.holds, "instructions changed from what was read"),
        "Walnut/Views/Sessions/Changes/DiffReviewViews.swift": (.holds, "a line comment typed and not added, or one being sent; added comments live in the session's DiffReview"),
        "Walnut/Views/Sessions/NewSessionSheet.swift": (.holds, "a first message, or a folder, host or mode changed from what it offered"),
        "Walnut/Views/Sessions/PermissionRequestCard.swift": (.draft("PermissionAnswerDrafts"), "a note, the picks, other text and pictures, per request"),
        "Walnut/Views/Sessions/SessionComposerSheets.swift": (.holds, "a fork's words; a note changed from the saved one"),
        "Walnut/Views/Sessions/SessionExtrasSheets.swift": (.holds, "a side question being written"),
        "Walnut/Views/Sessions/SessionLifecycleDialogs.swift": (.alert, "rename: only Cancel or Rename end the words"),
        "Walnut/Views/Sessions/SessionPathPicker.swift": (.holds, "a path typed and not picked"),
        "Walnut/Views/Sessions/SessionQueueViews.swift": (.holds, "a queued message changed from what is queued"),
        "Walnut/Views/Settings/AppleHealthView.swift": (.notPresented, "a Settings page; each switch is saved as it changes"),
        "Walnut/Views/Settings/FocusMusicView.swift": (.notPresented, "a Settings page; each change is saved as it is made"),
        "Walnut/Views/Settings/RoutinesView.swift": (.notPresented, "a Settings page; each switch is saved as it changes"),
        "Walnut/Views/Settings/SettingsView.swift": (.notPresented, "the Settings tab itself"),
        "Walnut/Views/SetupView.swift": (.notPresented, "the pairing screen, shown before any push can come"),
        "Walnut/Views/Shared/ReplyPictures.swift": (.holds, "the camera holds a push while it is up; the pictures are their composer's"),
        "Walnut/Views/Tasks/TaskDetailSheet.swift": (.holds, "a title being renamed; a due day picked and not Set"),
        "Walnut/Views/Tasks/TaskFieldEditorSheet.swift": (.holds, "the description or note editor changed from where it started"),
        "Walnut/Views/Tasks/TaskProjectPicker.swift": (.holds, "a new project's name being typed"),
        "Walnut/Views/Tasks/TaskPropertiesList.swift": (.savedOnChange, "the status applies at once; the project picker is its own sheet"),
        "Walnut/Views/Tasks/TaskSyncViews.swift": (.parentKeeps, "a binding into its create page, which holds it (CalendarCreateSheet, NewSessionChatView)"),
        "Walnut/Views/Tasks/TasksView.swift": (.notPresented, "the Tasks tab's own search"),
    ]

    /// An input control in a line of code: a SwiftUI one, the camera, or a search field.
    private static let inputControl = try! NSRegularExpression(
        pattern: #"(?<![A-Za-z0-9_.])(TextField|TextEditor|SecureField|DatePicker|Picker|Toggle|Stepper|Slider|PhotosPicker|CameraPicker)\(|\.searchable\("#)

    func testEveryInputAPushCouldCloseIsKept() throws {
        var takesInput: Set<String> = []
        for (path, code) in try appSources() {
            let inputs = code.reduce(0) { n, line in
                n + Self.inputControl.numberOfMatches(in: line, range: NSRange(line.startIndex..., in: line))
            }
            let bare = Self.count(".holdsNavigation()", in: code)
            let holds = Self.count(".holdsNavigation(", in: code)
            if bare > 0 {
                XCTAssertTrue(Self.holdsANavigation[path]?.why.contains("while it is up") == true,
                              "\(path) holds a push unconditionally (.holdsNavigation()): hold only while there is unsaved input, or list why it must hold while it is up")
            }
            guard inputs > 0 else { continue }
            takesInput.insert(path)
            guard let listed = Self.inputKeeping[path] else {
                XCTFail("\(path) takes his input and is not listed: a push closes every sheet, so make it hold the push while it has unsaved input (.holdsNavigation(<dirty>)) or keep a draft it opens on again, then list it in inputKeeping with how")
                continue
            }
            XCTAssertGreaterThan(listed.why.count, 10, "\(path): say how it keeps his input")
            switch listed.keeps {
            case .holds:
                XCTAssertGreaterThan(holds, 0, "\(path) is listed as holding a push but has no holdsNavigation")
            case .draft(let store):
                XCTAssertGreaterThan(Self.count(store, in: code), 0, "\(path) is listed as keeping a draft in \(store) but never names it")
            case .savedOnChange, .parentKeeps, .notPresented, .alert:
                break
            }
        }
        for path in Self.inputKeeping.keys where !takesInput.contains(path) {
            XCTFail("\(path) is listed as taking input but takes none: take it off inputKeeping")
        }
        XCTAssertGreaterThanOrEqual(takesInput.count, 30, "the walk finds the app's input")
    }

    /// The calendar's create sheet holds a push exactly while it holds something he has not added.
    func testTheCalendarSheetHoldsOnlyWhatHeChanged() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let end = start.addingTimeInterval(3600)
        func edited(title: String = "", project: String = "", start s: Date? = nil, end e: Date? = nil,
                    allDay: Bool = false, syncLocal: Bool = false) -> Bool {
            CalendarCreate.edited(title: title, project: project, start: s ?? start, end: e ?? end, isAllDay: allDay,
                                  syncLocal: syncLocal, seedStart: start, seedEnd: end, seedAllDay: false)
        }
        XCTAssertFalse(edited(), "as it opened: a push closes it")
        XCTAssertFalse(edited(title: "   "), "blank words are nothing")
        XCTAssertTrue(edited(title: "Dentist"))
        XCTAssertTrue(edited(project: "Home"))
        XCTAssertTrue(edited(start: start.addingTimeInterval(900)), "a moved start")
        XCTAssertTrue(edited(end: end.addingTimeInterval(1800)), "a moved end")
        XCTAssertTrue(edited(allDay: true))
        XCTAssertTrue(edited(syncLocal: true))
    }

    /// Windows other than the app's: their own presentations are not the app's chain.
    private static let otherWindows: [String: String] = [
        "Walnut/Talk/TalkPanel.swift": "the Talk panel sits above the app on purpose and is no navigation's to close",
        // `PresentationLowering` names a window kind; it makes none.
    ]

    func testEveryPresentationIsOnTheAppWindowsChain() throws {
        var presentations = 0
        var inViews = 0
        for (path, code) in try appSources() {
            let here = [".sheet(", ".fullScreenCover(", ".popover("].reduce(0) { $0 + Self.count($1, in: code) }
            presentations += here
            if path.hasPrefix("Walnut/Views/") { inViews += here }
            for needle in ["definesPresentationContext = true", ".currentContext", ".overCurrentContext"] {
                XCTAssertEqual(Self.count(needle, in: code), 0,
                               "\(path) uses \(needle): its presentations leave the app window's chain, which a push navigation closes (PresentationLowering)")
            }
            if Self.count("UIWindow(", in: code) > 0 {
                XCTAssertNotNil(Self.otherWindows[path],
                                "\(path) makes a window of its own: what it presents is not closed for a push navigation. List it here with why, or present in the app's window")
            }
            if path.hasSuffix("/TalkPanel.swift") {
                XCTAssertEqual([".sheet(", ".fullScreenCover("].reduce(0) { $0 + Self.count($1, in: code) }, 0,
                               "the Talk panel's window presents nothing a push navigation would have to close")
            }
        }
        XCTAssertGreaterThanOrEqual(presentations, 60, "the walk finds the app's presentations")
        // 48 under Views/ on 2026-11-09: the task page raises its sheets from its root now (main's 467a29f93).
        XCTAssertGreaterThanOrEqual(inViews, 45, "the walk finds the presentations under Views/")
    }

    func testEverySheetThatRefusesToCloseIsListed() throws {
        var seen: [String: Int] = [:]
        for (path, code) in try appSources() {
            if path != "Walnut/Views/Shared/HoldsNavigation.swift" {
                XCTAssertEqual(Self.count(".interactiveDismissDisabled(", in: code), 0,
                               "\(path) refuses a swipe down with a bare interactiveDismissDisabled: use .holdsNavigation(_:), which also holds a push navigation until he is done and says so")
            }
            let n = Self.count(".holdsNavigation(", in: code)
            guard n > 0 else { continue }
            seen[path] = n
            guard let listed = Self.holdsANavigation[path] else {
                XCTFail("\(path) has a sheet that refuses to close (holdsNavigation): a push navigation waits behind it. List it in holdsANavigation with its host and why, or let it close and keep its work (as the Follow up draft does)")
                continue
            }
            XCTAssertEqual(n, listed.count, "\(path): \(n) sheets refuse to close, \(listed.count) listed (\(listed.why))")
            XCTAssertFalse(listed.host.isEmpty, "\(path): name the view that hosts it")
        }
        for path in Self.holdsANavigation.keys where seen[path] == nil {
            XCTFail("\(path) is listed as holding a navigation but no sheet there refuses to close: take it off the list")
        }
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: Self.iosRoot.appendingPathComponent(relative), encoding: .utf8)
    }

    /// The text of the declaration `name` in `text`, to its closing brace at the same depth. The
    /// scan starts at `name` itself, so a name that ends in its own `{` (a class) counts that brace
    /// and runs to the class's end, not to the end of its first member.
    private static func body(of name: String, in text: String) -> String? {
        guard let start = text.range(of: name) else { return nil }
        var depth = 0
        var opened = false
        var end = text.endIndex
        for i in text[start.lowerBound...].indices {
            let c = text[i]
            if c == "{" { depth += 1; opened = true }
            if c == "}" {
                depth -= 1
                if opened && depth == 0 { end = text.index(after: i); break }
            }
        }
        return String(text[start.lowerBound..<end])
    }

    func testNoPushReachesAHostWhileASheetHoldsHisWork() throws {
        // The gate: one place publishes a request, after asking about the sheets.
        let link = try source("Walnut/Core/OrgNodeLink.swift")
        let gateClass = try XCTUnwrap(Self.body(of: "final class OrgNodeLink {", in: link))
        let publishes = gateClass.components(separatedBy: "\n").filter {
            $0.contains("pending = ") && !$0.contains("pending = nil") && !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//")
        }
        XCTAssertEqual(publishes.count, 1, "OrgNodeLink publishes a request in one place: \(publishes)")
        let go = try XCTUnwrap(Self.body(of: "private func go(", in: gateClass), "the gate's one function")
        let ask = try XCTUnwrap(go.range(of: "lowerForNavigation("), "the gate asks what is presented")
        let keep = try XCTUnwrap(go.range(of: "== .keep"), "and whether a sheet holds his work")
        let held = try XCTUnwrap(go.range(of: "held = request"), "which holds the request")
        let publish = try XCTUnwrap(go.range(of: "pending = request"), "else publishes it")
        XCTAssertLessThan(ask.lowerBound, keep.lowerBound)
        XCTAssertLessThan(keep.lowerBound, held.lowerBound)
        XCTAssertLessThan(held.lowerBound, publish.lowerBound, "held first, published only past it")
        XCTAssertTrue(go[held.upperBound..<publish.lowerBound].contains("return"), "a held request is not published")
        XCTAssertTrue(gateClass.contains("PresentationLowering.current() != .keep"), "a held request goes once the sheet is done")

        // Every page request comes out of the gate: only ChatView posts them, from what it consumed.
        var posters: [String] = []
        for (path, code) in try appSources() where Self.count("OrgNodePageLink.shared.post(", in: code) > 0 {
            posters.append(path)
        }
        XCTAssertEqual(posters, ["Walnut/Views/Chat/ChatView.swift"], "a node page request posted outside the gate's consumer")
        let chat = try source("Walnut/Views/Chat/ChatView.swift")
        let linked = try XCTUnwrap(Self.body(of: "private func openLinkedOrgNode()", in: chat))
        XCTAssertTrue(linked.contains("orgLink.consume()"), "the chat opens only a request past the gate")
        // `OrgNodeLink.open` is the only way in (ThreadDeepLink's tap): nothing else assigns the
        // gate's request. Reads (`orgLink.pending == nil`) are not writes; the pattern matched them
        // as writes once the class body above was read whole and this check was reached.
        let write = try NSRegularExpression(pattern: #"(OrgNodeLink\.shared|orgLink)\.pending\s*=(?!=)"#)
        for (path, code) in try appSources() where path != "Walnut/Core/OrgNodeLink.swift" {
            let writes = code.reduce(0) { n, text in
                n + write.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text))
            }
            XCTAssertEqual(writes, 0, "\(path) writes the gate's request around it")
        }
    }

    func testThePushNavigationLowersFirstAndTheWorkCardReadsTheSameRule() throws {
        let app = try String(contentsOf: Self.iosRoot.appendingPathComponent("Walnut/App/WalnutApp.swift"), encoding: .utf8)
        let start = try XCTUnwrap(app.range(of: ".onChange(of: orgLink.pending)"), "the org link moves the tab")
        let body = app[start.upperBound...].prefix(300)
        XCTAssertTrue(body.contains("selection = .chat"), "a request past the gate brings Chat forward")
        XCTAssertFalse(body.contains("lowerForNavigation"), "the lowering is the gate's, before the request exists")

        let card = try String(contentsOf: Self.iosRoot.appendingPathComponent("Walnut/Views/Tasks/WorkCardSheet.swift"), encoding: .utf8)
        XCTAssertTrue(card.contains("PresentationLowering.plan(over:"), "the work card link reads the same rule")
        XCTAssertTrue(card.contains("PresentationLowering.root()"), "and the same window")
        XCTAssertFalse(card.contains("isKeyWindow"), "not the key window, which is the Talk panel's while it is up")

        // The Follow up composer closes for a push: it keeps his words in the draft store, never in
        // its own state, and never refuses to close.
        let threads = try String(contentsOf: Self.iosRoot.appendingPathComponent("Walnut/Views/Org/OrgThreadsView.swift"), encoding: .utf8)
        let sheet = try XCTUnwrap(threads.range(of: "struct OrgThreadFollowUpSheet: View {"))
        let sheetBody = threads[sheet.upperBound...].prefix(4000)
        XCTAssertTrue(sheetBody.contains("ComposerDrafts.shared"), "the Follow up's words live in the draft store")
        XCTAssertFalse(sheetBody.contains("@State private var text"), "not in the sheet's own state")
        XCTAssertFalse(sheetBody.contains("interactiveDismissDisabled") || sheetBody.contains("holdsNavigation"), "it closes for a push")
    }
}
