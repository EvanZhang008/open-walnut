import Foundation
import XCTest
@testable import Walnut

/// "Answered on Cloud": a reply the cloud companion computed while the Mac was out
/// of reach says so under the reply, and says it the same way live and after a
/// reload. A reply the Mac computed says nothing.
///
/// Two server generations are covered because both are deployed: a CURRENT one
/// carries `answeredBy: "cloud"` on the SSE turn end and on the history row, and an
/// OLDER companion names its built-in engine (`walnut-agent-fallback`) on the turn
/// end only, so the phone has to remember what it watched (CloudAnswerMarks).
@MainActor
final class ChatCloudAnswerTests: XCTestCase {

    private let conv = "conv-cloud-answer"
    private let cloudText = "Your Mac is offline, so the cloud server answered this."
    private var defaults: UserDefaults!
    private var suiteName = ""

    override func setUp() async throws {
        suiteName = "ChatCloudAnswerTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        DiskCache.remove(key: "messages-\(conv)")
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
        DiskCache.remove(key: "messages-\(conv)")
    }

    private var nowStamp: String { ISO8601DateFormatter().string(from: Date()) }

    private func row(_ id: String, _ role: String, _ text: String, createdAt: String? = nil,
                     answeredBy: String? = nil) -> ChatMessage {
        ChatMessage(id: id, role: role, text: text, createdAt: createdAt ?? nowStamp, kind: nil,
                    answeredBy: answeredBy)
    }

    private func poll(_ label: String, until condition: @MainActor () -> Bool) async {
        for _ in 0..<400 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(label)")
    }

    private func turnEnd(_ store: ChatStore, fullText: String, extra: String) {
        let text = String(data: try! JSONEncoder().encode(fullText), encoding: .utf8)!
        store.handleForTesting(
            SSEEvent(id: nil, event: "message-end",
                     data: #"{"turnId":"t1","fullText":\#(text)\#(extra)}"#),
            conversationID: conv
        )
    }

    // MARK: - Wire

    func testHistoryRowsDecodeAnsweredByPresentAndAbsent() throws {
        let json = #"""
        [{"id":"m0","role":"user","text":"q","createdAt":"2026-09-26T06:00:00Z"},
         {"id":"m1","role":"assistant","text":"a","createdAt":"2026-09-26T06:00:01Z","answeredBy":"cloud"},
         {"id":"m2","role":"assistant","text":"b","createdAt":"2026-09-26T06:00:02Z"}]
        """#
        let rows = try JSONDecoder().decode([ChatMessage].self, from: Data(json.utf8))
        XCTAssertEqual(rows.map(\.answeredOnCloud), [false, true, false])
        XCTAssertFalse(row("u", "user", "x", answeredBy: "cloud").answeredOnCloud, "a user row is never captioned")
    }

    func testWhichTurnEndFramesSayCloud() {
        XCTAssertTrue(CloudAnswerMarks.frameSaysCloud(answeredBy: "cloud", engine: "claude-code"))
        XCTAssertTrue(CloudAnswerMarks.frameSaysCloud(answeredBy: nil, engine: "walnut-agent-fallback"))
        XCTAssertFalse(CloudAnswerMarks.frameSaysCloud(answeredBy: nil, engine: "claude-code"))
        XCTAssertFalse(CloudAnswerMarks.frameSaysCloud(answeredBy: nil, engine: nil))
    }

    // MARK: - Marks

    func testMarksMatchByConversationTextAndTime() {
        var marks = CloudAnswerMarks(defaults: defaults)
        let now = Date().timeIntervalSince1970 * 1000
        marks.remember(conversationID: conv, text: "  Done. <task-ref id=\"t1\" label=\"Taxes\"/>\n", atMs: now)
        let near = ISO8601DateFormatter().string(from: Date())
        let later = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
        let rows = marks.apply(to: [
            row("m1", "assistant", "Done. Taxes", createdAt: near),
            row("m2", "assistant", "Done. Taxes", createdAt: later),
            row("m3", "user", "Done. Taxes", createdAt: near),
            row("m4", "assistant", "Something else", createdAt: near),
        ], conversationID: conv)
        XCTAssertEqual(rows.map(\.answeredOnCloud), [true, false, false, false],
                       "only the same reply, near its time, in its conversation")
        let elsewhere = marks.apply(to: [row("m1", "assistant", "Done. Taxes", createdAt: near)],
                                    conversationID: "another")
        XCTAssertFalse(elsewhere[0].answeredOnCloud, "a mark leaked into another conversation")
    }

    func testMarksPersistAreBoundedAndNeverOverrideTheServer() {
        var marks = CloudAnswerMarks(defaults: defaults)
        let now = Date().timeIntervalSince1970 * 1000
        for i in 0..<(CloudAnswerMarks.limit + 10) {
            marks.remember(conversationID: conv, text: "reply \(i)", atMs: now)
        }
        let reloaded = CloudAnswerMarks(defaults: defaults)
        XCTAssertEqual(reloaded.marks.count, CloudAnswerMarks.limit)
        XCTAssertEqual(reloaded.marks.last, marks.marks.last)
        let newest = reloaded.apply(to: [row("m1", "assistant", "reply \(CloudAnswerMarks.limit + 9)")], conversationID: conv)
        XCTAssertTrue(newest[0].answeredOnCloud)
        let oldest = reloaded.apply(to: [row("m1", "assistant", "reply 0")], conversationID: conv)
        XCTAssertFalse(oldest[0].answeredOnCloud, "the bound kept the oldest instead of the newest")
        // A label the server already gave is left as it is.
        let labelled = reloaded.apply(to: [row("m1", "assistant", "reply 70", answeredBy: "primary")], conversationID: conv)
        XCTAssertEqual(labelled[0].answeredBy, "primary")
    }

    // MARK: - The store, end to end

    /// An OLDER companion: the turn end names its built-in engine and history says
    /// nothing. The caption shows at the turn end, survives the refetch that
    /// replaces the provisional row, and survives a relaunch.
    func testAnOlderCompanionsAnswerKeepsItsCaptionThroughRefetchAndRelaunch() async {
        let mock = MockChatMessagesTransport()
        mock.rows[conv] = [row("m0", "user", "hello"), row("m1", "assistant", cloudText)]
        let store = ChatStore(transport: mock, cloudMarksDefaults: defaults)
        store.activeID = conv

        turnEnd(store, fullText: cloudText, extra: #","engine":"walnut-agent-fallback""#)
        XCTAssertEqual(store.messages.last?.answeredOnCloud, true, "the live turn end did not caption the reply")
        await poll("the canonical rows") { store.messages.map(\.id) == ["m0", "m1"] }
        XCTAssertEqual(store.messages.last?.answeredOnCloud, true, "the refetch dropped the caption")
        store.closeStream()

        let relaunched = ChatStore(transport: mock, cloudMarksDefaults: defaults)
        relaunched.activeID = conv
        await relaunched.loadMessages(conv)
        XCTAssertEqual(relaunched.messages.map(\.answeredOnCloud), [false, true], "the relaunch dropped the caption")
        relaunched.closeStream()
    }

    /// A CURRENT companion says it on the frame and on the row.
    func testACurrentCompanionsAnswerIsCaptionedFromTheFrameAndTheRow() async {
        let mock = MockChatMessagesTransport()
        mock.rows[conv] = [row("m0", "user", "hello"), row("m1", "assistant", cloudText, answeredBy: "cloud")]
        let store = ChatStore(transport: mock, cloudMarksDefaults: CloudAnswerTestsEmptyDefaults.make())
        store.activeID = conv
        turnEnd(store, fullText: cloudText, extra: #","engine":"claude-code","answeredBy":"cloud""#)
        XCTAssertEqual(store.messages.last?.answeredOnCloud, true)
        await poll("the canonical rows") { store.messages.map(\.id) == ["m0", "m1"] }
        XCTAssertEqual(store.messages.map(\.answeredOnCloud), [false, true])
        store.closeStream()

        // Another phone that never saw the turn: the row alone carries the caption.
        let fresh = ChatStore(transport: mock, cloudMarksDefaults: CloudAnswerTestsEmptyDefaults.make())
        fresh.activeID = conv
        await fresh.loadMessages(conv)
        XCTAssertEqual(fresh.messages.map(\.answeredOnCloud), [false, true])
        fresh.closeStream()
    }

    /// The Mac answered: no caption, live or after the refetch, and nothing remembered.
    func testAMacAnswerIsNeverCaptioned() async {
        let mock = MockChatMessagesTransport()
        mock.rows[conv] = [row("m0", "user", "hello"), row("m1", "assistant", "From the Mac.")]
        let store = ChatStore(transport: mock, cloudMarksDefaults: defaults)
        store.activeID = conv
        turnEnd(store, fullText: "From the Mac.", extra: #","engine":"claude-code""#)
        XCTAssertEqual(store.messages.last?.answeredOnCloud, false)
        await poll("the canonical rows") { store.messages.map(\.id) == ["m0", "m1"] }
        XCTAssertFalse(store.messages.contains { $0.answeredOnCloud })
        XCTAssertTrue(CloudAnswerMarks(defaults: defaults).marks.isEmpty)
        store.closeStream()
    }

    // MARK: - Timeline

    func testTheCaptionRowSitsUnderTheReplyOnlyForACloudAnswer() {
        let builder = TimelineRowBuilder()
        let cloud = builder.rows(for: row("m1", "assistant", cloudText, answeredBy: "cloud"),
                                 width: 393, expandedRowIDs: [], scope: conv)
        guard case .chip(let icon, let text)? = cloud.last?.content else {
            return XCTFail("no caption row: \(cloud.map(\.id))")
        }
        XCTAssertEqual(icon, "cloud")
        XCTAssertEqual(text, "Answered on Cloud")
        XCTAssertTrue(cloud.last!.id.hasSuffix("#answeredBy"))
        XCTAssertEqual(Set(cloud.map(\.id)).count, cloud.count, "row ids collide")

        let mac = builder.rows(for: row("m1", "assistant", cloudText), width: 393, expandedRowIDs: [], scope: conv)
        XCTAssertEqual(mac.count, cloud.count - 1)
        XCTAssertFalse(mac.contains { $0.id.hasSuffix("#answeredBy") })
        XCTAssertEqual(mac.map(\.id), cloud.dropLast().map(\.id), "the caption moved the reply's own rows")
    }
}

/// A defaults suite nobody else writes, for the one test that must prove the
/// caption comes from the SERVER (no remembered marks to lean on).
private enum CloudAnswerTestsEmptyDefaults {
    static func make() -> UserDefaults {
        let name = "ChatCloudAnswerTests-empty-\(UUID().uuidString)"
        let suite = UserDefaults(suiteName: name)!
        suite.removePersistentDomain(forName: name)
        return suite
    }
}
