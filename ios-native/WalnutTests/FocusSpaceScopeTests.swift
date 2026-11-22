import XCTest
@testable import Walnut

/// The focus space's pure parts: the scope rule (a port of server `taskInScope`,
/// src/core/focus-spaces/scope.ts), decoding `GET /focus-spaces`, the Inbox badge in a focus,
/// the events feed's `focus-changed` frame and the banner's words.
final class FocusSpaceScopeTests: XCTestCase {

    // MARK: - Fixtures

    private typealias Node = FocusSpaceScope.Node

    private func inScope(_ scope: FocusSpaceScope, _ id: String?, _ nodes: [String: Node]) -> Bool {
        FocusSpaceScope.taskInScope(scope, taskId: id, lookup: { nodes[$0] })
    }

    private func node(_ project: String = "", parent: String? = nil) -> Node {
        Node(project: project, parentTaskId: parent)
    }

    private func task(_ id: String, project: String = "", parent: String? = nil) -> WalnutTask {
        WalnutTask(
            id: id, title: id, status: "todo", phase: "TODO", priority: "none",
            project: project, dueDate: nil, createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: nil, tags: nil, summary: nil, parentTaskId: parent
        )
    }

    // MARK: - The scope rule

    func testANamedTaskIsInside() {
        let scope = FocusSpaceScope(tasks: ["t1"])
        XCTAssertTrue(inScope(scope, "t1", ["t1": node("Elsewhere")]))
        XCTAssertFalse(inScope(scope, "t2", ["t2": node("Elsewhere")]))
    }

    func testAProjectMatchesWhateverItsCase() {
        let scope = FocusSpaceScope(projects: ["Walnut"])
        XCTAssertTrue(inScope(scope, "a", ["a": node("walnut")]))
        XCTAssertTrue(inScope(scope, "b", ["b": node(" WALNUT ")]))
        XCTAssertFalse(inScope(scope, "c", ["c": node("Walnuts")]))
    }

    func testTheInboxIsInboxOrTheEmptyName() {
        let nodes = ["old": node(""), "new": node("Inbox"), "other": node("Home")]
        for spelled in ["Inbox", "inbox", ""] {
            let scope = FocusSpaceScope(projects: [spelled])
            XCTAssertTrue(inScope(scope, "old", nodes), "scope \"\(spelled)\" holds the old '' Inbox")
            XCTAssertTrue(inScope(scope, "new", nodes), "scope \"\(spelled)\" holds the Inbox project")
            XCTAssertFalse(inScope(scope, "other", nodes))
        }
    }

    func testSubtasksOfANamedTaskAreInsideAtAnyDepth() {
        let nodes = [
            "root": node("Home"),
            "child": node("Home", parent: "root"),
            "grandchild": node("Home", parent: "child"),
            "great": node("Home", parent: "grandchild"),
            "sibling": node("Home"),
        ]
        let scope = FocusSpaceScope(tasks: ["root"])
        XCTAssertTrue(inScope(scope, "child", nodes))
        XCTAssertTrue(inScope(scope, "grandchild", nodes))
        XCTAssertTrue(inScope(scope, "great", nodes))
        XCTAssertFalse(inScope(scope, "sibling", nodes))
    }

    func testASubtaskOfATaskInANamedProjectIsInside() {
        // The subtask itself is filed elsewhere: its parent's project lets it through.
        let nodes = ["parent": node("Walnut"), "sub": node("Home", parent: "parent")]
        XCTAssertTrue(inScope(FocusSpaceScope(projects: ["walnut"]), "sub", nodes))
    }

    func testTheWalkStopsAfterTwelveHops() {
        // root ← n1 ← … ← n13: n12 is twelve hops from root, n13 thirteen.
        var nodes: [String: Node] = ["root": node("Home")]
        for depth in 1...13 {
            nodes["n\(depth)"] = node("Home", parent: depth == 1 ? "root" : "n\(depth - 1)")
        }
        let scope = FocusSpaceScope(tasks: ["root"])
        XCTAssertTrue(inScope(scope, "n12", nodes))
        XCTAssertFalse(inScope(scope, "n13", nodes), "past SCOPE_MAX_HOPS the walk ends as outside")
    }

    func testALoopEndsTheWalkAsOutside() {
        let nodes = ["a": node("Home", parent: "b"), "b": node("Home", parent: "a")]
        XCTAssertFalse(inScope(FocusSpaceScope(projects: ["Walnut"], tasks: ["c"]), "a", nodes))
        // The loop does not hide a named member of it.
        XCTAssertTrue(inScope(FocusSpaceScope(tasks: ["b"]), "a", nodes))
    }

    func testAnUnknownIdIsInsideOnlyWhenNamed() {
        let scope = FocusSpaceScope(projects: ["Walnut"], tasks: ["ghost"])
        XCTAssertTrue(inScope(scope, "ghost", [:]))
        XCTAssertFalse(inScope(scope, "stranger", [:]))
        XCTAssertFalse(inScope(scope, nil, [:]))
        XCTAssertFalse(inScope(scope, "", [:]))
        // A held task whose parent the store does not hold: outside, unless that parent is named.
        let orphan = ["orphan": node("Home", parent: "ghost"), "lost": node("Home", parent: "gone")]
        XCTAssertTrue(inScope(scope, "orphan", orphan))
        XCTAssertFalse(inScope(scope, "lost", orphan))
    }

    func testAnEmptyScopeLetsNothingThrough() {
        XCTAssertFalse(inScope(FocusSpaceScope(), "a", ["a": node("")]))
    }

    func testInsideIdsAppliesTheRuleToTheWholeList() {
        let rows = [
            task("w1", project: "Walnut"),
            task("w1-sub", project: "Home", parent: "w1"),
            task("h1", project: "Home"),
            task("named", project: "Home"),
            task("inbox", project: ""),
        ]
        let scope = FocusSpaceScope(projects: ["walnut", "Inbox"], tasks: ["named"])
        XCTAssertEqual(FocusSpaceScope.insideIds(of: rows, scope: scope), ["w1", "w1-sub", "named", "inbox"])
    }

    // MARK: - Decoding GET /focus-spaces

    func testTheListingDecodesTolerantly() throws {
        let json = """
        {"spaces":[
          {"id":"fs-1","name":"Deep work","projects":["Walnut"],"tasks":["t1"],"apps":{"p":"off"},
           "createdAt":"2026-11-21T10:00:00Z","updatedAt":"2026-11-21T11:00:00Z","color":"red"},
          {"id":5,"name":"bad id"},
          {"name":"no id"},
          {"id":"fs-2","name":"Inbox only","projects":["Inbox",3,""],"tasks":null}
        ],
        "active":{"spaceId":"fs-1","name":"Deep work","scope":{"projects":["Walnut"],"tasks":["t1"]},
          "since":1763719200000,"until":1763722800000,"by":"person","future":{"x":1}},
        "apps":[{"pluginId":"p","name":"P"}],
        "somethingNew":true}
        """
        let listing = try JSONDecoder().decode(FocusSpacesListing.self, from: Data(json.utf8))
        XCTAssertEqual(listing.spaces.map(\.id), ["fs-1", "fs-2"], "a bad row is dropped, never the list")
        XCTAssertEqual(listing.spaces[0].projects, ["Walnut"])
        XCTAssertEqual(listing.spaces[0].tasks, ["t1"])
        XCTAssertEqual(listing.spaces[1].projects, ["Inbox", ""], "a non-string element is skipped")
        XCTAssertEqual(listing.spaces[1].tasks, [])
        let active = try XCTUnwrap(listing.active)
        XCTAssertEqual(active.spaceId, "fs-1")
        XCTAssertEqual(active.scope, FocusSpaceScope(projects: ["Walnut"], tasks: ["t1"]))
        XCTAssertEqual(active.untilDate, Date(timeIntervalSince1970: 1_763_722_800))
        XCTAssertEqual(active.by, "person")
    }

    func testNoFocusAndAnOddActiveReadAsNone() throws {
        let none = try JSONDecoder().decode(FocusSpacesListing.self, from: Data(#"{"spaces":[],"active":null}"#.utf8))
        XCTAssertNil(none.active)
        let odd = try JSONDecoder().decode(FocusSpacesListing.self, from: Data(#"{"active":"yes"}"#.utf8))
        XCTAssertNil(odd.active)
        XCTAssertEqual(odd.spaces, [])
    }

    func testAnActiveWithoutAnEndLastsUntilLeft() throws {
        let json = #"{"active":{"name":"Quick","scope":{"tasks":["t9"]},"since":1,"by":"quick-bar"}}"#
        let active = try XCTUnwrap(try JSONDecoder().decode(FocusSpacesListing.self, from: Data(json.utf8)).active)
        XCTAssertNil(active.spaceId)
        XCTAssertNil(active.untilDate)
        XCTAssertFalse(active.hasEnded(at: .distantFuture))
        XCTAssertEqual(active.scope.projects, [])
    }

    // MARK: - The Inbox badge in a focus

    func testInAFocusOnlyUnreadLettersAboutATaskInsideCount() throws {
        let json = """
        [
          {"id":"in","subject":"a","type":"info","read":false,"sender":{"taskId":"t-in"}},
          {"id":"out","subject":"b","type":"info","read":false,"sender":{"taskId":"t-out"}},
          {"id":"none","subject":"c","type":"info","read":false},
          {"id":"read","subject":"d","type":"info","read":true,"sender":{"taskId":"t-in"}},
          {"id":"archived","subject":"e","type":"info","read":false,"archived":true,"sender":{"taskId":"t-in"}}
        ]
        """
        let letters = try JSONDecoder().decode([Letter].self, from: Data(json.utf8))
        XCTAssertEqual(InboxListing.unreadCount(letters), 3, "out of a focus every unread letter counts")
        XCTAssertEqual(InboxListing.unreadCount(letters, inFocus: { $0 == "t-in" }), 1,
                       "a letter about a task outside, or about no task, waits")
    }

    // MARK: - The events feed

    func testTheFocusChangedFrameMapsToARead() {
        XCTAssertEqual(EventsFeedClient.mutation(event: "focus-changed", data: "{}"), .focusChanged)
        XCTAssertEqual(EventsFeedClient.mutation(event: "focus-changed", data: "not json"), .focusChanged)
        XCTAssertEqual(EventsFeedClient.mutation(event: "task-delete", data: #"{"id":"x"}"#), .taskDelete(id: "x"))
        XCTAssertNil(EventsFeedClient.mutation(event: "some-new-frame", data: "{}"), "unknown frames are dropped")
        XCTAssertNil(EventsFeedClient.mutation(event: "snapshot", data: "{}"), "a snapshot that does not decode")
    }

    // MARK: - The banner's words

    func testTheBannerLine() {
        let until = Calendar.current.date(bySettingHour: 15, minute: 40, second: 0, of: Date())!
        let line = FocusSpaceBanner.line(name: "Deep work", until: until, outside: 12)
        XCTAssertTrue(line.hasPrefix("Deep work · until "))
        XCTAssertTrue(line.hasSuffix(" · 12 waiting outside"))
        XCTAssertEqual(FocusSpaceBanner.line(name: "Deep work", until: nil, outside: 0),
                       "Deep work · nothing waiting outside")
        // Narrow or large text: a short detail, then the count alone; the count is never dropped.
        XCTAssertTrue(FocusSpaceBanner.shortDetail(until: until, outside: 12).hasPrefix("12 outside · until "))
        XCTAssertEqual(FocusSpaceBanner.shortDetail(until: nil, outside: 0), "none outside")
        XCTAssertEqual(FocusSpaceBanner.countOnly(outside: 209), "209 outside")
    }

    func testTheLengthsTheMenuOffers() {
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(FocusSpaceLength.allCases.map(\.title), ["1 hour", "2 hours", "Until I leave"])
        XCTAssertEqual(FocusSpaceLength.oneHour.until(from: now), Date(timeIntervalSince1970: 4_600))
        XCTAssertEqual(FocusSpaceLength.twoHours.until(from: now), Date(timeIntervalSince1970: 8_200))
        XCTAssertNil(FocusSpaceLength.untilLeft.until(from: now))
    }
}
