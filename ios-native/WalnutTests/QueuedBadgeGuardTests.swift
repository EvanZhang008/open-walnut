import XCTest
@testable import Walnut

/// A message the session took never keeps its Queued badge, whatever the phone missed
/// (2026-11-11, the owner, after dictating two messages into a remote session's running
/// turn and putting the phone away: "it just show queued in ios").
///
/// A bubble's Queued used to end in one way only: a read of the session's line
/// (GET /queue) that started after the send. Every way that read does not come left it
/// standing: the page away (its clock stopped), the server not answering (the clock
/// backs off to a minute), the clock asleep when the send went out (up to 15 s), the
/// Chat tab's follow ending on the wall clock, or cut by the app going away and never
/// started again. Now the transcript is a second word (a row naming the message,
/// `walnutMessageId`), a send wakes the clock, and the Chat tab's follow neither runs out
/// nor stays stopped. The source scan at the end fails on a new owner of a line follow
/// that does not say how its Queued ends without a read.
@MainActor
final class QueuedBadgeGuardTests: XCTestCase {
    typealias Transport = SessionQueueModelTests.Transport

    override func tearDown() async throws {
        SessionQueueModel.watchFastPace = 1.5
        SessionQueueModel.deliveredSpan = 2
    }

    private func row(_ id: String, status: String = "pending", stage: String? = nil,
                     delivered: Bool? = nil) -> SessionQueuedMessage {
        var r = SessionQueuedMessage(id: id, message: "words", status: status, enqueuedAt: "2026-11-11T17:08:00Z")
        r.stage = stage
        r.delivered = delivered
        return r
    }

    /// A line whose reads never answer: what the page sees while it is away or the server is not reachable.
    private func unreadableLine() -> Transport {
        let line = Transport()
        line.readError = APIError.network(underlying: NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
        return line
    }

    private func waitUntil(_ what: String, line: UInt = #line, _ condition: () -> Bool) async {
        for _ in 0..<1500 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("timed out waiting for \(what)", line: line)
    }

    // MARK: - Every word that the session took a send

    /// Each way the page can learn the session took a send ends its Queued: Delivered for a
    /// moment, then nothing. The two that are no such word keep it Queued.
    func testEveryWayTheSessionCanSayItTookASendEndsItsQueued() {
        let id = "qm-mobile-1"
        let took: [(String, @MainActor (SessionQueueModel) -> Void)] = [
            ("a read after the send no longer lists it", { $0.updateSendStates(fetched: [], read: 1) }),
            ("its row is being handed over", { $0.updateSendStates(fetched: [self.row(id, status: "processing")], read: 1) }),
            ("its row says the CLI took the line", { $0.updateSendStates(fetched: [self.row(id, stage: "taken")], read: 1) }),
            ("its row says delivered", { $0.updateSendStates(fetched: [self.row(id, delivered: true)], read: 1) }),
            ("the transcript holds it, with no read at all", { $0.noteInTranscript([id]) }),
            ("the transcript holds it while the last read still lists it waiting", {
                $0.updateSendStates(fetched: [self.row(id, stage: "written")], read: 1)
                $0.noteInTranscript([id, "qm-older"])
            }),
        ]
        for (how, step) in took {
            let queue = SessionQueueModel(sessionId: "badge-took", api: unreadableLine())
            queue.watch(id)
            XCTAssertEqual(queue.sendStates[id], .pending, "\(how): Queued until then")
            step(queue)
            XCTAssertEqual(queue.sendStates[id], .delivered, "\(how): the session has it")
            queue.updateSendStates(fetched: nil, read: nil, now: Date().addingTimeInterval(SessionQueueModel.deliveredSpan + 1))
            XCTAssertNil(queue.sendStates[id], "\(how): Delivered fades")
        }
        let notYet: [(String, @MainActor (SessionQueueModel) -> Void)] = [
            ("a read from before the send", { $0.updateSendStates(fetched: [], read: 0) }),
            ("its row still waits and the transcript has other messages", {
                $0.updateSendStates(fetched: [self.row(id)], read: 1)
                $0.noteInTranscript(["qm-older"])
            }),
        ]
        for (how, step) in notYet {
            let queue = SessionQueueModel(sessionId: "badge-not-yet", api: unreadableLine())
            queue.watch(id)
            step(queue)
            XCTAssertEqual(queue.sendStates[id], .pending, "\(how) is no word that the session took it")
        }
    }

    /// The transcript can name the message before the server's answer to its send arrives
    /// (the turn writes it first): the send is Delivered the moment it is followed.
    func testASendWhoseRowLandedBeforeItsAnswerIsDeliveredAtOnce() {
        let queue = SessionQueueModel(sessionId: "badge-early", api: unreadableLine())
        queue.noteInTranscript(["qm-early"])
        queue.watch("qm-early")
        XCTAssertEqual(queue.sendStates["qm-early"], .delivered)
    }

    /// The badge itself: a message the transcript holds is never Queued, whatever the last
    /// read of the line said, and a bubble with no row yet still is.
    func testABubbleTheTranscriptHoldsIsNeverQueuedByAnOldReadOfTheLine() {
        var taken = ChatMessage(id: "row-1", role: "user", text: "check the deploy", createdAt: "", kind: nil)
        taken.walnutMessageId = "qm-a"
        var waiting = ChatMessage(id: "pending-2", role: "user", text: "and the logs", createdAt: "", kind: nil)
        waiting.clientMessageId = "qm-b"
        var fading = ChatMessage(id: "row-3", role: "user", text: "thanks", createdAt: "", kind: nil)
        fading.walnutMessageId = "qm-c"
        let states = SessionQueueModel.bubbleStates(
            for: [taken, waiting, fading],
            sendStates: ["qm-a": .pending, "qm-c": .delivered],
            rows: ["qm-a": row("qm-a"), "qm-b": row("qm-b")]
        )
        XCTAssertEqual(states, ["pending-2": .pending, "row-3": .delivered])
        XCTAssertEqual(SessionQueueModel.bubbleStates(for: [taken], sendStates: [:], rows: ["qm-a": row("qm-a")]), [:],
                       "a waiting row of a message the transcript holds: no Queued")
    }

    /// The page as it is wired (`SessionConversationView.makeQueue`): a send into a busy
    /// session, the line unreadable (the phone away, the server not answering), then the
    /// transcript read that shows the message. Its bubble is no longer Queued.
    func testThePageEndsQueuedFromTheTranscriptWhenTheLineCannotBeRead() async throws {
        let sends = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "badge-page"), transport: sends)
        let queue = SessionConversationView.makeQueue(sessionId: "badge-page", store: store, api: unreadableLine())
        let sent = await store.send("check the deploy")
        XCTAssertTrue(sent)
        let id = try XCTUnwrap(sends.messageIds.compactMap { $0 }.first)
        XCTAssertEqual(queue.sendStates[id], .pending, "accepted: Queued")
        await queue.refresh()
        XCTAssertEqual(queue.sendStates[id], .pending, "a read that did not answer says nothing")
        var line = SessionTranscript.Message(role: "user", text: "check the deploy",
                                              timestamp: "2026-11-11T17:08:21Z", kind: nil)
        line.walnutMessageId = id
        store.reconcile(SessionTranscript(sessionId: "badge-page", exportedAt: "x", truncated: false, messages: [line]))
        XCTAssertEqual(queue.sendStates[id], .delivered, "the transcript holds it: Delivered")
        let badges = SessionQueueModel.bubbleStates(for: store.messages, sendStates: queue.sendStates, rows: [:])
        XCTAssertFalse(badges.values.contains(.pending), "no bubble of it reads Queued: \(badges)")
    }

    // MARK: - The read clock wakes for a send

    /// A send goes out while the clock sleeps its long lap (rows waiting, nothing running:
    /// 5 s; idle: 15 s): its line is read now and then at the fast pace, not after the lap.
    func testASendWakesTheReadClockFromItsLongSleep() async {
        SessionQueueModel.watchFastPace = 0.05
        let line = Transport()
        line.rows = [row("qm-earlier")]
        let queue = SessionQueueModel(sessionId: "badge-clock", api: line)
        queue.start { false }
        defer { queue.stop() }
        await waitUntil("the first read") { line.reads >= 1 }
        try? await Task.sleep(for: .milliseconds(30))
        let before = line.reads
        XCTAssertEqual(before, 1, "asleep for its 5 s lap")
        // The send waits in the line, so the fast pace holds while it is read.
        line.rows = [row("qm-earlier"), row("qm-now")]
        queue.watch("qm-now")
        await waitUntil("a read now and fast ones after it") { line.reads >= before + 3 }
        XCTAssertTrue(queue.isPolling)
    }

    // MARK: - Guard: every owner of a line follow says how its Queued ends without a read

    /// Files that make a `SessionQueueModel` (and so follow sends' Queued), each with the
    /// code that ends a Queued when no read of the line comes, and why it is enough.
    static let owners: [String: (markers: [String], why: String)] = [
        "Views/Sessions/SessionConversationView.swift": (
            ["onTranscriptShows", "noteInTranscript("],
            "The session page feeds the queue every transcript read: a message whose row is there is Delivered, read of the line or not."
        ),
        "Stores/ChatStore.swift": (
            ["resumeLaneFollow()", "laneFollowDelay("],
            "The Chat tab's follow of a lane never ends while a bubble reads Queued (it slows down), and starts again with a read when the screen is back."
        ),
    ]

    private static var appRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // WalnutTests
            .deletingLastPathComponent()  // ios-native
            .appendingPathComponent("Walnut", isDirectory: true)
            .resolvingSymlinksInPath()
    }

    /// Source with `//` comment lines dropped.
    private static func code(_ url: URL) -> String {
        let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        return text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// Every app file that makes a `SessionQueueModel`, by path under `Walnut/`.
    static func ownerFiles() -> [String: String] {
        var found: [String: String] = [:]
        let root = appRoot
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return found }
        for case let url as URL in walker where url.pathExtension == "swift" {
            let source = code(url)
            guard source.contains("SessionQueueModel(") else { continue }
            let path = url.resolvingSymlinksInPath().path
            guard path.hasPrefix(root.path + "/") else { continue }
            found[String(path.dropFirst(root.path.count + 1))] = source
        }
        return found
    }

    func testEveryLineFollowSaysHowItsQueuedEndsWithoutARead() {
        let files = Self.ownerFiles()
        XCTAssertGreaterThanOrEqual(files.count, 2, "the scan found too few owners: \(files.keys.sorted())")
        var offenders: [String] = []
        for (file, source) in files {
            guard let owner = Self.owners[file] else {
                offenders.append("\(file): not listed")
                continue
            }
            let missing = owner.markers.filter { !source.contains($0) }
            if !missing.isEmpty { offenders.append("\(file): no \(missing.joined(separator: ", "))") }
            // A follow that stops on the wall clock leaves its last Queued standing.
            if source.range(of: #"while[^\n{]*Date\(\)\s*<"#, options: .regularExpression) != nil {
                offenders.append("\(file): a loop that ends on the wall clock")
            }
        }
        XCTAssertEqual(
            offenders, [],
            """
            A SessionQueueModel follows sends' Queued with no way to end it when the line is \
            not read (the page away, the server not answering, a follow that ran out). Feed it \
            the transcript (noteInTranscript), keep following until no Queued is left, and \
            list the file in QueuedBadgeGuardTests.owners with why.
            """
        )
        for (file, owner) in Self.owners {
            XCTAssertNotNil(files[file], "\(file) makes no SessionQueueModel any more: drop it from owners")
            XCTAssertGreaterThanOrEqual(owner.why.count, 40, "\(file): say why, in a sentence")
        }
    }
}
