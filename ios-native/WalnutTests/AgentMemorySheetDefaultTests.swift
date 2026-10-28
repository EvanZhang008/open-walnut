import XCTest
@testable import Walnut

/// The memory sheet's core instructions (`AgentMemorySheet`): Walnut's default for the role
/// shows in the box while the user has set none, and the default's own words are no words of
/// the user's (2026-10-27, the user: "inject the core instruction for each agent ... main, u
/// don't do task yourself").
final class AgentMemorySheetDefaultTests: XCTestCase {
    private let fallback = "Do not do task work yourself.\nHand it to a VP."

    func testAnEmptyBoxReadsAsTheDefault() {
        XCTAssertEqual(AgentMemorySheet.reads("", fallback: fallback), fallback)
        XCTAssertEqual(AgentMemorySheet.reads("  \n ", fallback: fallback), fallback)
        XCTAssertEqual(AgentMemorySheet.reads(" Own words. ", fallback: fallback), "Own words.")
        // A server older than the default: the box is the user's words alone.
        XCTAssertEqual(AgentMemorySheet.reads("", fallback: ""), "")
    }

    func testTheDefaultMatchesWhitespaceAside() {
        XCTAssertEqual(
            AgentMemorySheet.normalized("Do not do task work yourself.\n\n  Hand it to a VP. "),
            AgentMemorySheet.normalized(fallback)
        )
        XCTAssertNotEqual(AgentMemorySheet.normalized("Do it yourself."), AgentMemorySheet.normalized(fallback))
    }

    /// The header says where the box's words come from, the writer included (2026-10-27, the
    /// user: "all human action can be done by agent also", so the page names an agent).
    func testTheSourceNamesTheWriter() {
        let byCeo = OrgInstructions(text: "Ship weekly.", at: "2026-10-27T11:55:00Z", by: "task:t1", byName: "the CEO")
        let byUser = OrgInstructions(text: "Ship weekly.", at: "2026-10-27T11:55:00Z", by: "human")
        let older = OrgInstructions(text: "Ship weekly.", at: "2026-10-27T11:55:00Z")
        XCTAssertEqual(AgentMemorySheet.source(followsDefault: true, edited: false, stored: byCeo), "Walnut's default")
        // An agent's lines follow Walnut's default; written at the user's request they are the user's.
        XCTAssertEqual(AgentMemorySheet.source(followsDefault: false, edited: false, stored: byCeo), "Default and lines by the CEO")
        let forUser = OrgInstructions(text: "Ship weekly.", at: "2026-10-27T11:55:00Z", by: "task:t1", byName: "the CEO", forUser: true)
        XCTAssertEqual(AgentMemorySheet.source(followsDefault: false, edited: false, stored: forUser), "By the CEO for you")
        XCTAssertEqual(AgentMemorySheet.source(followsDefault: false, edited: true, stored: byCeo), "Yours")
        XCTAssertEqual(AgentMemorySheet.source(followsDefault: false, edited: false, stored: byUser), "Yours")
        XCTAssertEqual(AgentMemorySheet.source(followsDefault: false, edited: false, stored: older), "Yours")
        XCTAssertEqual(AgentMemorySheet.source(followsDefault: false, edited: false, stored: nil), "Yours")
        let unnamed = OrgInstructions(text: "x", at: nil, by: "agent", byName: "  ")
        XCTAssertEqual(unnamed.author, "an agent")
    }

    /// The box opens on what the agent reads: an agent's lines come after the default.
    func testTheBoxShowsWhatTheAgentReads() throws {
        XCTAssertEqual(AgentMemorySheet.shown(nil, fallback: fallback), fallback)
        XCTAssertEqual(AgentMemorySheet.shown(OrgInstructions(text: " ", at: nil, by: "human"), fallback: fallback), fallback)
        XCTAssertEqual(AgentMemorySheet.shown(OrgInstructions(text: "Own.", at: nil, by: "human"), fallback: fallback), "Own.")
        XCTAssertEqual(AgentMemorySheet.shown(OrgInstructions(text: "Own.", at: nil), fallback: fallback), "Own.")
        XCTAssertEqual(AgentMemorySheet.shown(OrgInstructions(text: "Ship.", at: nil, by: "task:t1"), fallback: fallback), "\(fallback)\n\nShip.")
        XCTAssertEqual(AgentMemorySheet.shown(OrgInstructions(text: "Ship.", at: nil, by: "task:t1", forUser: true), fallback: fallback), "Ship.")
        // A server older than the default: the words alone.
        XCTAssertEqual(AgentMemorySheet.shown(OrgInstructions(text: "Ship.", at: nil, by: "task:t1"), fallback: ""), "Ship.")
        // Unchanged, the shown words are no change to save.
        let shown = AgentMemorySheet.shown(OrgInstructions(text: "Ship.", at: nil, by: "task:t1"), fallback: fallback)
        XCTAssertFalse(AgentMemorySheet.dirty(text: shown, saved: shown, fallback: fallback))
        XCTAssertTrue(AgentMemorySheet.dirty(text: shown + " Now.", saved: shown, fallback: fallback))
        let row = try JSONDecoder().decode(OrgInstructions.self, from: Data(#"{"text":"t","at":"x","by":"task:a","by_name":"the CEO","for_user":true}"#.utf8))
        XCTAssertTrue(row.usersWords)
        XCTAssertFalse(row.byUser)
    }

    /// The limit counts UTF-16 units, as the server (JavaScript) does: a two-unit emoji at 3999
    /// is over. Words past it are never cut; only Save waits.
    func testTheLimitCountsAsTheServerDoes() {
        let nearly = String(repeating: "a", count: 3999)
        XCTAssertFalse(AgentMemorySheet.overLimit(nearly + "b"))
        XCTAssertTrue(AgentMemorySheet.overLimit(nearly + "\u{1F600}"))
        // A combining mark joins the character before it and still counts its own unit.
        XCTAssertTrue(AgentMemorySheet.overLimit(nearly + "\u{0E01}\u{0E35}"))
        XCTAssertFalse(AgentMemorySheet.overLimit(""))
        XCTAssertEqual(AgentMemorySheet.kChars(396), "396")
        XCTAssertEqual(AgentMemorySheet.kChars(12_000), "12k")
        XCTAssertEqual(AgentMemorySheet.kChars(7_900), "7.9k")
    }

    /// Save sends no words when the box follows the default, so the role keeps following it.
    func testSaveSendsNoWordsForTheDefault() {
        XCTAssertEqual(AgentMemorySheet.outgoing("", fallback: fallback), "")
        XCTAssertEqual(AgentMemorySheet.outgoing(" \n ", fallback: fallback), "")
        XCTAssertEqual(AgentMemorySheet.outgoing("Do not do task work yourself.  Hand it to a VP.\n", fallback: fallback), "")
        XCTAssertEqual(AgentMemorySheet.outgoing(" Own words. ", fallback: fallback), "Own words.")
        XCTAssertEqual(AgentMemorySheet.outgoing(fallback + "\n\nShip weekly.", fallback: fallback), fallback + "\n\nShip weekly.")
        // A server older than the default: the words alone.
        XCTAssertEqual(AgentMemorySheet.outgoing("", fallback: ""), "")
        XCTAssertEqual(AgentMemorySheet.outgoing("Ship.", fallback: ""), "Ship.")
    }

    /// The CEO reads Main's default, a VP the lead's; an older server has none.
    func testTheRolePicksItsDefault() {
        let defaults = OrgSettingsView.Defaults(main: "m", lead: "l")
        XCTAssertEqual(AgentMemorySheet.fallback(defaults, isMain: true), "m")
        XCTAssertEqual(AgentMemorySheet.fallback(defaults, isMain: false), "l")
        XCTAssertEqual(AgentMemorySheet.fallback(nil, isMain: true), "")
    }

    /// Save turns on only for a change the agent would read: a respaced copy of the default, or
    /// an emptied box, is no change while the role follows it.
    func testDirtyOnlyForAChangeTheAgentReads() {
        // Following the default: the box opens on it.
        XCTAssertFalse(AgentMemorySheet.dirty(text: fallback, saved: fallback, fallback: fallback))
        XCTAssertFalse(AgentMemorySheet.dirty(text: "", saved: fallback, fallback: fallback))
        XCTAssertFalse(AgentMemorySheet.dirty(text: "Do not do task work yourself.  Hand it to a VP.\n", saved: fallback, fallback: fallback))
        XCTAssertTrue(AgentMemorySheet.dirty(text: "Own words.", saved: fallback, fallback: fallback))
        // The user's own words: going back to the default is a change, and so is any edit.
        XCTAssertTrue(AgentMemorySheet.dirty(text: fallback, saved: "Own words.", fallback: fallback))
        XCTAssertTrue(AgentMemorySheet.dirty(text: "", saved: "Own words.", fallback: fallback))
        XCTAssertFalse(AgentMemorySheet.dirty(text: " Own words. ", saved: "Own words.", fallback: fallback))
        XCTAssertTrue(AgentMemorySheet.dirty(text: "Own words, edited.", saved: "Own words.", fallback: fallback))
        // A server older than the default: only the words themselves count.
        XCTAssertFalse(AgentMemorySheet.dirty(text: "", saved: "", fallback: ""))
        XCTAssertTrue(AgentMemorySheet.dirty(text: "New.", saved: "", fallback: ""))
    }

    /// Settings from a server older than the default decode with none.
    func testSettingsWithoutDefaultsDecode() throws {
        let old = try JSONDecoder().decode(OrgSettingsView.self, from: Data(#"{"name":"Org","founderTitle":"Founder"}"#.utf8))
        XCTAssertNil(old.defaultInstructions)
        let now = try JSONDecoder().decode(
            OrgSettingsView.self,
            from: Data(#"{"name":"Org","founderTitle":"Founder","defaultInstructions":{"main":"m","lead":"l"}}"#.utf8)
        )
        XCTAssertEqual(now.defaultInstructions?.main, "m")
        XCTAssertEqual(now.defaultInstructions?.lead, "l")
    }
}
