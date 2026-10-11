import UIKit
import XCTest
@testable import Walnut

/// A session message whose send is accepted while its page is not on screen (the
/// app went to the background, or the user switched tab or pushed a screen) shows
/// once when the page is back (App Store gate r8, finding 1).
///
/// The server's acceptance used to be written only while the page was active, so a
/// bubble accepted while it was away stayed `pending` for good. The absorb rule
/// never takes a pending bubble (its POST may still fail), so its own row and a grey
/// "sending" copy both stayed on the page, and the copy could not be retried. Q1,
/// Q1c and Q1p are the gate's probes, adopted as shipped tests; Q1k is their
/// control (the same send with the page active).
@MainActor
final class SessionSendAwayTests: XCTestCase {
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
            sessionId: "away", exportedAt: "2026-10-06T16:40:00Z", truncated: false,
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

    private func openedStore(_ tag: String) async -> (SessionConversationStore, MockSessionSendTransport) {
        let transport = MockSessionSendTransport()
        transport.transcript = transcript(Self.before)
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "away-\(tag)"), transport: transport)
        await store.open()
        return (store, transport)
    }

    private func settle() async {
        for _ in 0..<50 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(100))
    }

    private static let before = [("user", "Run the tests"), ("assistant", "All green.")]
    private static let after = before + [("user", "Ship it"), ("assistant", "Shipped.")]

    // MARK: - Accepted while the page is away

    /// Q1: a text whose POST succeeds while the app is in the background; back in the
    /// foreground its row is on the page. It shows once.
    func testATextAcceptedWhileInTheBackgroundShowsOnce() async {
        let (store, transport) = await openedStore("q1")
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let send = Task { await store.send("Ship it") }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        store.suspend()
        gate.open()
        let accepted = await send.value
        XCTAssertTrue(accepted, "the send was accepted")
        transport.gate = nil
        transport.transcript = transcript(Self.after)
        store.resume()
        await waitUntil("the resume's read put the row on the page") {
            store.historyMessages.contains { $0.text == "Ship it" }
        }
        store.reconcile(transport.transcript)
        await settle()
        XCTAssertEqual(store.messages.filter { $0.text == "Ship it" }.count, 1,
                       "Q1: the message shows twice (its row and a bubble that never leaves)")
        XCTAssertFalse(store.messages.contains { $0.pending == true },
                       "Q1: a bubble stays pending for ever after its send was accepted")
    }

    /// Q1c: the same when the page was closed (another tab, a pushed screen) and
    /// opened again.
    func testATextAcceptedWhileThePageWasClosedShowsOnceWhenItOpensAgain() async {
        let (store, transport) = await openedStore("q1c")
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let send = Task { await store.send("Ship it") }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        store.close()
        gate.open()
        _ = await send.value
        transport.gate = nil
        transport.transcript = transcript(Self.after)
        await store.open()
        store.reconcile(transport.transcript)
        await settle()
        XCTAssertEqual(store.messages.filter { $0.text == "Ship it" }.count, 1,
                       "Q1c: the message shows twice after the page came back")
        XCTAssertFalse(store.messages.contains { $0.pending == true },
                       "Q1c: a bubble stays pending for ever after its send was accepted")
    }

    /// Q1p: a photo with no words (it uploads for seconds, so leaving the page during
    /// its POST is the likely case), accepted while the app is in the background.
    func testAPhotoAcceptedWhileInTheBackgroundShowsOnce() async throws {
        let (store, transport) = await openedStore("q1p")
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let image = try XCTUnwrap(SelectedImage(jpegData: jpeg()))
        let send = Task { await store.send("", images: [image]) }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        store.suspend()
        gate.open()
        _ = await send.value
        transport.gate = nil
        transport.transcript = transcript(Self.before + [("user", Self.photoRow("b")),
                                                         ("assistant", "I looked at the photo.")])
        store.resume()
        await waitUntil("the resume's read put the row on the page") {
            store.historyMessages.contains { MessageRow.imageSendParts($0.text) != nil }
        }
        store.reconcile(transport.transcript)
        await settle()
        XCTAssertFalse(store.messages.contains { $0.localImages != nil },
                       "Q1p: the photo shows twice (its row and a bubble that never leaves)")
        XCTAssertFalse(store.messages.contains { $0.pending == true })
    }

    /// Voice mode sends through the same path (`voice: true`): a spoken message
    /// accepted while the app is in the background shows once too.
    func testASpokenMessageAcceptedWhileInTheBackgroundShowsOnce() async {
        let (store, transport) = await openedStore("q1v")
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let send = Task { await store.send("Ship it", voice: true) }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        store.suspend()
        gate.open()
        _ = await send.value
        transport.gate = nil
        XCTAssertEqual(transport.voiceFlags, [true], "the spoken send went out as one")
        transport.transcript = transcript(Self.after)
        store.resume()
        await waitUntil("the resume's read put the row on the page") {
            store.historyMessages.contains { $0.text == "Ship it" }
        }
        store.reconcile(transport.transcript)
        await settle()
        XCTAssertEqual(store.messages.filter { $0.text == "Ship it" }.count, 1)
        XCTAssertFalse(store.messages.contains { $0.pending == true })
    }

    /// Accepted while away, and its row is not in the transcript yet when the page is
    /// back (a turn still writing it): the bubble waits, as an accepted bubble, not as
    /// "sending", and gives way when the row lands.
    func testAnAcceptedBubbleWhoseRowIsNotThereYetWaitsAsAccepted() async {
        let (store, transport) = await openedStore("late")
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let send = Task { await store.send("Ship it") }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        store.suspend()
        gate.open()
        _ = await send.value
        transport.gate = nil
        store.resume()
        store.reconcile(transport.transcript)
        await settle()
        let bubble = store.messages.filter { $0.text == "Ship it" }
        XCTAssertEqual(bubble.count, 1, "the bubble is still on the page")
        XCTAssertNotEqual(bubble.first?.pending, true, "and it no longer says it is sending")
        XCTAssertNotEqual(bubble.first?.failed, true)
        transport.transcript = transcript(Self.after)
        store.reconcile(transport.transcript)
        await settle()
        XCTAssertEqual(store.messages.filter { $0.text == "Ship it" }.count, 1, "its row took its place")
    }

    /// A send that FAILS while the page is away stays a failed bubble the user can
    /// retry (the other exit of the same path): nothing is lost, nothing is pending.
    func testASendThatFailsWhileAwayCanBeRetriedWhenThePageIsBack() async {
        let (store, transport) = await openedStore("fail")
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        transport.permanentError = APIError.server(status: 500, code: "internal", message: "boom",
                                                   serverHash: nil, serverContent: nil)
        let send = Task { await store.send("Ship it") }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        store.suspend()
        gate.open()
        let accepted = await send.value
        XCTAssertFalse(accepted)
        transport.gate = nil
        transport.permanentError = nil
        store.resume()
        await settle()
        let failed = store.messages.filter { $0.text == "Ship it" && $0.failed == true }
        XCTAssertEqual(failed.count, 1, "the failed bubble is on the page, to retry")
        XCTAssertFalse(store.messages.contains { $0.pending == true })
        await store.retry(failed[0])
        XCTAssertEqual(transport.sendCallCount, 2, "the retry went out")
        XCTAssertEqual(Set(transport.messageIds.compactMap { $0 }).count, 1, "under the same id")
    }

    /// A manual retry goes through the same delivery: a failed bubble retried, and the
    /// retry accepted while the app is in the background, shows once when the app is
    /// back.
    func testARetryAcceptedWhileInTheBackgroundShowsOnce() async {
        let (store, transport) = await openedStore("retry")
        defer { store.close() }
        transport.permanentError = APIError.server(status: 500, code: "internal", message: "boom",
                                                   serverHash: nil, serverContent: nil)
        let first = await store.send("Ship it")
        XCTAssertFalse(first)
        transport.permanentError = nil
        let failed = store.messages.filter { $0.text == "Ship it" && $0.failed == true }
        XCTAssertEqual(failed.count, 1, "the first attempt left a failed bubble")
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let retry = Task { await store.retry(failed[0]) }
        await waitUntil("the retry's POST is in flight") { transport.sendCallCount == 2 }
        store.suspend()
        gate.open()
        await retry.value
        transport.gate = nil
        transport.transcript = transcript(Self.after)
        store.resume()
        await waitUntil("the resume's read put the row on the page") {
            store.historyMessages.contains { $0.text == "Ship it" }
        }
        store.reconcile(transport.transcript)
        await settle()
        XCTAssertEqual(store.messages.filter { $0.text == "Ship it" }.count, 1,
                       "the retried message shows twice (its row and a bubble that never leaves)")
        XCTAssertFalse(store.messages.contains { $0.pending == true || $0.failed == true })
    }

    /// The acceptance proves the host's bridge is up, also while the app is in the
    /// background: the page that comes back carries no outage left over from the
    /// attempt before it.
    func testAnAcceptanceWhileAwayEndsTheOutageTheFirstAttemptRaised() async {
        let (store, transport) = await openedStore("bridge")
        defer { store.close() }
        transport.failuresRemaining = 1 // 503 bridge_offline
        let first = await store.send("Ship it")
        XCTAssertFalse(first)
        XCTAssertTrue(store.bridgeDown, "the first attempt met the outage")
        let waiting = store.messages.filter { $0.text == "Ship it" && $0.failed == true }
        XCTAssertEqual(waiting.count, 1, "waiting for its retry")
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let retry = Task { await store.retry(waiting[0]) }
        await waitUntil("the retry's POST is in flight") { transport.sendCallCount == 2 }
        store.suspend()
        gate.open()
        await retry.value
        transport.gate = nil
        XCTAssertFalse(store.bridgeDown, "an acceptance while away left the outage standing")
        transport.transcript = transcript(Self.after)
        store.resume()
        await waitUntil("the resume's read put the row on the page") {
            store.historyMessages.contains { $0.text == "Ship it" }
        }
        store.reconcile(transport.transcript)
        await settle()
        XCTAssertEqual(store.connectionNotice, .none)
        XCTAssertEqual(store.messages.filter { $0.text == "Ship it" }.count, 1)
        XCTAssertFalse(store.messages.contains { $0.pending == true || $0.failed == true })
    }

    /// An attempt whose task is cancelled while the page stays on screen (a manual
    /// retry superseding an automatic one, the composer's task ending), and which the
    /// server accepts: its row, already on the page, takes the bubble's place at once.
    func testAnAcceptedAttemptWhoseTaskWasCancelledGivesWayToItsRow() async {
        let (store, transport) = await openedStore("cancel")
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        let send = Task { await store.send("Ship it") }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        // The turn wrote the row before the answer to the POST came back.
        transport.transcript = transcript(Self.after)
        store.reconcile(transport.transcript)
        send.cancel()
        gate.open()
        let accepted = await send.value
        XCTAssertTrue(accepted, "the server took it")
        await settle()
        XCTAssertEqual(store.messages.filter { $0.text == "Ship it" }.count, 1,
                       "the message shows twice (its row and an accepted bubble beside it)")
        XCTAssertFalse(store.messages.contains { $0.pending == true })
    }

    /// Q1k (control): the same send, accepted while the page is active.
    func testATextAcceptedWhileThePageIsActiveShowsOnce() async {
        let (store, transport) = await openedStore("q1k")
        defer { store.close() }
        _ = await store.send("Ship it")
        transport.transcript = transcript(Self.after)
        store.reconcile(transport.transcript)
        XCTAssertEqual(store.messages.filter { $0.text == "Ship it" }.count, 1)
        XCTAssertFalse(store.messages.contains { $0.pending == true })
    }
}
