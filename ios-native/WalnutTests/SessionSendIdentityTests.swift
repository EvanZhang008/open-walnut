import UIKit
import XCTest
@testable import Walnut

/// A session's sent bubble gives way to the transcript row ITS OWN send made, never
/// to a row that merely has the same text (App Store r7 gate, findings 1 and 7).
///
/// r9 counted a photo row's words as seen text, so a photo sent with no words put
/// "" in the seen set; the next photo sent with no words was then absorbed while its
/// POST was still out, and when that POST failed the page showed no "Not sent" and
/// no retry. The older rule had the same hole for a photo whose words equal an
/// earlier text row. S0, S1, S1r and S1c are the gate's probes, adopted as shipped
/// tests; the rest pin the rule down for sends that were accepted.
@MainActor
final class SessionSendIdentityTests: XCTestCase {
    /// The server's photo row (`withImagePaths`, src/core/sessions/cloud-images.ts).
    private static func photoRow(_ name: String, words: String = "") -> String {
        "[Images attached \u{2014} use the Read tool to view them]\n- /tmp/walnut-images/\(name).jpg\n\n\(words)"
    }

    private func jpeg() -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        let image = renderer.image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        return image.jpegData(compressionQuality: 0.8)!
    }

    private func transcript(_ rows: [(String, String)]) -> SessionTranscript {
        SessionTranscript(
            sessionId: "identity", exportedAt: "2026-10-06T16:40:00Z", truncated: false,
            messages: rows.enumerated().map { i, row in
                SessionTranscript.Message(role: row.0, text: row.1,
                                          timestamp: String(format: "2026-10-06T16:%02d:00Z", i), kind: nil)
            }
        )
    }

    private func waitUntil(_ what: String, timeout: Double = 3, _ condition: () -> Bool,
                           line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("timed out waiting for \(what)", line: line)
    }

    private func openedStore(_ tag: String, _ rows: [(String, String)]) async -> (SessionConversationStore, MockSessionSendTransport) {
        let transport = MockSessionSendTransport()
        transport.transcript = transcript(rows)
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "identity-\(tag)"), transport: transport)
        await store.open()
        return (store, transport)
    }

    private static let serverError = APIError.server(status: 500, code: "internal", message: "boom",
                                                     serverHash: nil, serverContent: nil)
    private static let bridgeOffline = APIError.server(status: 503, code: "bridge_offline", message: "No live bridge",
                                                       serverHash: nil, serverContent: nil)

    // MARK: - The gate's probes: a photo whose POST is still out, then fails

    private func photoInFlightThenFails(earlier: String, bubble: String, error: Error, tag: String) async throws {
        let (store, transport) = await openedStore(tag, [("user", earlier), ("assistant", "Got it.")])
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        transport.permanentError = error
        let image = try XCTUnwrap(SelectedImage(jpegData: jpeg()))
        let send = Task { await store.send(bubble, images: [image]) }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        // A transcript read lands while the POST is in flight (a poll, a stream refetch).
        store.reconcile(transport.transcript)
        XCTAssertTrue(store.messages.contains { $0.localImages != nil },
                      "\(tag): the new photo's bubble vanished while its send was in flight")
        gate.open()
        _ = await send.value
        XCTAssertTrue(store.messages.contains { $0.failed == true && $0.localImages != nil },
                      "\(tag): the send failed and no Not sent bubble holds the photo")
    }

    /// S1: a second photo with no words, after an earlier photo with no words, and
    /// the send fails (a non-retryable answer).
    func testAPhotoAloneAfterAnEarlierPhotoAloneFailsVisibly() async throws {
        try await photoInFlightThenFails(earlier: Self.photoRow("a"), bubble: "",
                                         error: Self.serverError, tag: "S1")
    }

    /// S1r: the same with a retryable answer (bridge offline): the bubble stays and
    /// waits for its retry.
    func testAPhotoAloneAfterAnEarlierPhotoAloneWaitsForItsRetry() async throws {
        try await photoInFlightThenFails(earlier: Self.photoRow("a"), bubble: "",
                                         error: Self.bridgeOffline, tag: "S1r")
    }

    /// S1c: a photo whose words equal an earlier text row (the older rule's class).
    func testAPhotoWithWordsEqualToAnEarlierTextFailsVisibly() async throws {
        try await photoInFlightThenFails(earlier: "Look at this", bubble: "Look at this",
                                         error: Self.serverError, tag: "S1c")
    }

    /// S0 (control): the first photo with no words in a session that has none.
    func testTheFirstPhotoAloneFailsVisibly() async throws {
        try await photoInFlightThenFails(earlier: "Run the tests", bubble: "",
                                         error: Self.serverError, tag: "S0")
    }

    // MARK: - Accepted sends wait for their own row

    /// An accepted photo with no words stays on the page until ITS row arrives, then
    /// gives way to it (the photo shows once).
    func testAnAcceptedPhotoWaitsForItsOwnRowAfterAnEarlierPhoto() async throws {
        let (store, transport) = await openedStore("photo-wait", [("user", Self.photoRow("a")), ("assistant", "Got it.")])
        defer { store.close() }
        let image = try XCTUnwrap(SelectedImage(jpegData: jpeg()))
        let accepted = await store.send("", images: [image])
        XCTAssertTrue(accepted)
        // A read made before the new photo reached the CLI.
        store.reconcile(transport.transcript)
        XCTAssertEqual(store.messages.filter { $0.localImages != nil }.count, 1,
                       "the sent photo was taken for the earlier one and left the page before its own row arrived")

        transport.transcript = transcript([
            ("user", Self.photoRow("a")), ("assistant", "Got it."),
            ("user", Self.photoRow("b")), ("assistant", "I looked at the photo you attached."),
        ])
        store.reconcile(transport.transcript)
        XCTAssertFalse(store.messages.contains { $0.localImages != nil }, "the sent photo stayed beside its own row")
        XCTAssertEqual(store.messages.filter { MessageRow.imageSendParts($0.text) != nil }.count, 2)
    }

    /// An accepted photo with words equal to an earlier TEXT row is not that row: it
    /// waits for its own photo row.
    func testAnAcceptedPhotoWithWordsIsNotAnEarlierTextRow() async throws {
        let (store, transport) = await openedStore("photo-words", [("user", "Look at this"), ("assistant", "Where?")])
        defer { store.close() }
        let image = try XCTUnwrap(SelectedImage(jpegData: jpeg()))
        _ = await store.send("Look at this", images: [image])
        store.reconcile(transport.transcript)
        XCTAssertTrue(store.messages.contains { $0.localImages != nil },
                      "the sent photo was taken for the earlier text with the same words")

        transport.transcript = transcript([
            ("user", "Look at this"), ("assistant", "Where?"),
            ("user", Self.photoRow("c", words: "Look at this")),
        ])
        store.reconcile(transport.transcript)
        XCTAssertFalse(store.messages.contains { $0.localImages != nil }, "the sent photo stayed beside its own row")
    }

    /// The mirror case: an accepted TEXT is not a photo row with the same words (a
    /// photo sent from another device, or this phone's own photo send). The text
    /// waits for its own plain row (App Store gate r8, mutant n03).
    func testAnAcceptedTextIsNotAPhotoRowWithTheSameWords() async {
        let (store, transport) = await openedStore("text-photo", [("user", "Run the tests"), ("assistant", "All green.")])
        defer { store.close() }
        _ = await store.send("Look at this")
        transport.transcript = transcript([
            ("user", "Run the tests"), ("assistant", "All green."),
            ("user", Self.photoRow("d", words: "Look at this")),
        ])
        store.reconcile(transport.transcript)
        XCTAssertEqual(store.messages.filter { $0.text == "Look at this" }.count, 1,
                       "the sent text was taken for a photo row with the same words and left the page")

        transport.transcript = transcript([
            ("user", "Run the tests"), ("assistant", "All green."),
            ("user", Self.photoRow("d", words: "Look at this")), ("user", "Look at this"),
        ])
        store.reconcile(transport.transcript)
        XCTAssertEqual(store.messages.filter { $0.text == "Look at this" }.count, 1, "its own row took its place")
        XCTAssertFalse(store.messages.contains { $0.id.hasPrefix("pending-") })
    }

    /// The same text sent twice: the second bubble waits for the second row.
    func testASecondEqualTextWaitsForItsOwnRow() async {
        let (store, transport) = await openedStore("same-text", [("user", "ok"), ("assistant", "Done.")])
        defer { store.close() }
        _ = await store.send("ok")
        store.reconcile(transport.transcript)
        XCTAssertEqual(store.messages.filter { $0.text == "ok" }.count, 2,
                       "the new ok was taken for the earlier one and left the page before its own row arrived")

        transport.transcript = transcript([("user", "ok"), ("assistant", "Done."), ("user", "ok")])
        store.reconcile(transport.transcript)
        XCTAssertEqual(store.messages.filter { $0.text == "ok" }.count, 2)
        XCTAssertFalse(store.messages.contains { $0.id.hasPrefix("pending-") }, "the bubble stayed beside its own row")
    }

    /// Two equal texts accepted before either row lands: one row stands for one
    /// bubble, so the second waits for the second row.
    func testTwoEqualTextsAcceptedTogetherWaitForTwoRows() async {
        let (store, transport) = await openedStore("two-ok", [("user", "Run the tests"), ("assistant", "All green.")])
        defer { store.close() }
        _ = await store.send("ok")
        _ = await store.send("ok")
        transport.transcript = transcript([("user", "Run the tests"), ("assistant", "All green."), ("user", "ok")])
        store.reconcile(transport.transcript)
        XCTAssertEqual(store.messages.filter { $0.text == "ok" }.count, 2, "one row took both bubbles")
        XCTAssertEqual(store.messages.filter { $0.id.hasPrefix("pending-") }.count, 1)

        transport.transcript = transcript([
            ("user", "Run the tests"), ("assistant", "All green."), ("user", "ok"), ("user", "ok"),
        ])
        store.reconcile(transport.transcript)
        XCTAssertEqual(store.messages.filter { $0.text == "ok" }.count, 2)
        XCTAssertFalse(store.messages.contains { $0.id.hasPrefix("pending-") })
    }

    /// A server that could not save the photo sends the words alone: that new row is
    /// the send, and the bubble gives way to it rather than staying beside it.
    func testAPhotoTheServerCouldNotSaveGivesWayToItsWords() async throws {
        let (store, transport) = await openedStore("no-save", [("user", "Run the tests"), ("assistant", "All green.")])
        defer { store.close() }
        let image = try XCTUnwrap(SelectedImage(jpegData: jpeg()))
        _ = await store.send("Look at this", images: [image])
        transport.transcript = transcript([("user", "Run the tests"), ("assistant", "All green."), ("user", "Look at this")])
        store.reconcile(transport.transcript)
        XCTAssertFalse(store.messages.contains { $0.localImages != nil }, "the bubble stayed beside its own words")
        XCTAssertEqual(store.messages.filter { $0.text == "Look at this" }.count, 1)
    }

    /// A row that lands while the POST is still out: the bubble waits for the answer
    /// (its send is not known to have reached the server), then gives way at once.
    func testARowThatLandsDuringThePostTakesTheBubbleWhenItIsAccepted() async {
        let (store, transport) = await openedStore("in-flight", [("user", "Run the tests"), ("assistant", "All green.")])
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let send = Task { await store.send("Ship it") }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        transport.transcript = transcript([("user", "Run the tests"), ("assistant", "All green."), ("user", "Ship it")])
        store.reconcile(transport.transcript)
        XCTAssertTrue(store.messages.contains { $0.pending == true && $0.text == "Ship it" },
                      "a bubble whose send is still out was absorbed")
        gate.open()
        _ = await send.value
        XCTAssertEqual(store.messages.filter { $0.text == "Ship it" }.count, 1, "the accepted bubble stayed beside its row")
        XCTAssertFalse(store.messages.contains { $0.id.hasPrefix("pending-") })
    }

    /// A long text gives way to its row, which the transcript clips at 4 KB.
    func testALongTextGivesWayToItsClippedRow() async {
        let (store, transport) = await openedStore("long", [("user", "Run the tests"), ("assistant", "All green.")])
        defer { store.close() }
        let long = String(repeating: "word ", count: 1_000)
        _ = await store.send(long)
        transport.transcript = transcript([
            ("user", "Run the tests"), ("assistant", "All green."),
            ("user", String(long.prefix(4_000)) + "\u{2026}"),
        ])
        store.reconcile(transport.transcript)
        XCTAssertFalse(store.messages.contains { $0.id.hasPrefix("pending-") }, "the long bubble stayed beside its clipped row")
    }

    /// A new session's first message (painted at open) gives way to its row.
    func testTheFirstMessageOfANewSessionGivesWayToItsRow() async {
        SessionLaunchContext.stash(sessionId: "identity-launch", message: "Fix the flaky test")
        let (store, _) = await openedStore("launch", [("user", "Fix the flaky test"), ("assistant", "On it.")])
        defer { store.close() }
        XCTAssertEqual(store.messages.filter { $0.text == "Fix the flaky test" }.count, 1)
    }
}
