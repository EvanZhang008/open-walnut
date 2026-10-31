import XCTest
@testable import Walnut

/// A title written beside a task mention is dropped, so the link (which shows the
/// title) names the task once (`TaskTitleAbsorb`). The cases are the web console's
/// and the Board's too: `tests/fixtures/task-title-absorb.json`, read from the repo.
@MainActor
final class TaskTitleAbsorbTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            let name: String
            let input: String
            let output: String
            enum CodingKeys: String, CodingKey {
                case name
                case input = "in"
                case output = "out"
            }
        }
        let tasks: [String: String]
        let cases: [Case]
    }

    private let resolver = TaskMentionResolver.shared

    private func fixture() throws -> Fixture {
        // WalnutTests/ -> ios-native/ -> the repo root.
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("tests/fixtures/task-title-absorb.json"))
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        resolver.resetForTesting()
    }

    override func tearDown() {
        resolver.resetForTesting()
        MarkdownParser.resetCacheForTesting()
        super.tearDown()
    }

    func testTheSharedCases() throws {
        let f = try fixture()
        XCTAssertGreaterThan(f.cases.count, 10)
        resolver.update(f.tasks)
        for c in f.cases {
            XCTAssertEqual(TaskTitleAbsorb.absorbWrittenTitles(c.input, resolver: resolver), c.output, c.name)
        }
    }

    func testTheRenderedReplyNamesTheTaskOnce() throws {
        let f = try fixture()
        resolver.update(f.tasks)
        let reply = try XCTUnwrap(f.cases.first)
        let shown = String(MarkdownParser.inline(reply.input).characters)
        XCTAssertEqual(shown, String(MarkdownParser.inline(reply.output).characters))
        let title = "Home task panel: Flat layout and status sections"
        XCTAssertEqual(shown.components(separatedBy: title).count - 1, 1, shown)
    }

    func testALeadShownAsItsVPStillAbsorbsTheStoredTitle() {
        resolver.update(["mvm0n3bu-6910": "Walnut VP"])
        XCTAssertEqual(TaskTitleAbsorb.absorbWrittenTitles(#"Ask "Walnut lead" (mvm0n3bu) first"#, resolver: resolver),
                       "Ask mvm0n3bu first")
    }

    func testAnUnknownIdKeepsItsWrittenTitle() {
        resolver.update(["mpwidref-7c2e": "Quarterly invoice reconciliation"])
        let text = "Quarterly invoice reconciliation (mzzzzzzz-0000)"
        XCTAssertEqual(TaskTitleAbsorb.absorbWrittenTitles(text, resolver: resolver), text)
    }
}
