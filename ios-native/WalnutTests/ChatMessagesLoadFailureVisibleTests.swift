import Foundation
import XCTest
@testable import Walnut

/// A messages transport that fails on demand, with a chosen error.
///
/// Its own type rather than the switch tests' mock: what matters here is WHICH error
/// the store was handed, because the answer differs per error (a transport failure is
/// the offline banner's business, everything else is the chat's).
private final class FailingMessagesTransport: ChatMessagesTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _error: Error?
    private var _calls = 0

    init(error: Error?) { _error = error }

    var error: Error? {
        get { lock.lock(); defer { lock.unlock() }; return _error }
        set { lock.lock(); _error = newValue; lock.unlock() }
    }

    var calls: Int { lock.lock(); defer { lock.unlock() }; return _calls }

    func messages(
        conversationID: String, agentID: String, limit: Int, before: String?
    ) async throws -> [ChatMessage] {
        lock.lock(); _calls += 1; let failure = _error; lock.unlock()
        if let failure { throw failure }
        return [ChatMessage(id: "m1", role: "assistant", text: "landed",
                            createdAt: "2026-09-12T06:00:00Z", kind: nil)]
    }
}

/// A FAILED CONVERSATION READ IS NEVER SILENT.
///
/// The store's `catch` reached only `reportIfNetwork`, which reacts to
/// `APIError.network` and nothing else — so a body the phone could not decode (a lone
/// surrogate escape makes `JSONDecoder` throw away the whole page) left the transcript
/// on "Your Personal AI is listening": no banner, no retry, nothing in the log. An
/// empty conversation and a failed read looked identical, and only one of them was
/// true (2026-09-12 gate).
@MainActor
final class ChatMessagesLoadFailureVisibleTests: XCTestCase {
    private let conversation = "conv-load-failure"
    private static let activeConversationKey = "walnut.activeConversation.general"
    private var saved: String?

    override func setUp() async throws {
        saved = UserDefaults.standard.string(forKey: Self.activeConversationKey)
        DiskCache.remove(key: "messages-\(conversation)")
    }

    override func tearDown() async throws {
        if let saved {
            UserDefaults.standard.set(saved, forKey: Self.activeConversationKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.activeConversationKey)
        }
        DiskCache.remove(key: "messages-\(conversation)")
    }

    private func poll(_ label: String, until condition: @MainActor () -> Bool) async {
        for _ in 0..<400 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(label)")
    }

    /// An undecodable body raises the banner the chat already uses for its errors, and
    /// the sentence names the retry the transcript really offers (pull to refresh).
    ///
    /// RED PROOF (`catch { reportIfNetwork(error) }`, what shipped):
    ///   timed out waiting for the failure to be stated - the read failed and the
    ///   transcript said nothing
    func testAnUndecodableBodyRaisesTheChatErrorBanner() async {
        let transport = FailingMessagesTransport(error: APIError.badResponse)
        let store = ChatStore(transport: transport)

        store.select(conversation)
        await poll("the failure to be stated") { store.errorMessage != nil }

        let banner = store.errorMessage ?? ""
        XCTAssertTrue(banner.hasPrefix(ChatStore.messagesLoadFailurePrefix),
                      "the banner read '\(banner)'")
        XCTAssertTrue(banner.contains("Unexpected server response"),
                      "…and it carries the cause a reporter can quote: '\(banner)'")
        XCTAssertTrue(banner.contains("Pull down"),
                      "…and the retry that exists: '\(banner)'")
        XCTAssertTrue(store.messages.isEmpty,
                      "a failed read invents no rows either")
    }

    /// A TRANSPORT failure stays with the offline banner and does NOT also raise this
    /// one: two sentences in two registers for one outage is worse than one.
    ///
    /// RED PROOF (dropping the `case .network` guard in `noteMessagesLoadFailure`):
    ///   XCTAssertNil failed: "Couldn't load this conversation: The Internet connection
    ///   appears to be offline.. Pull down to try again."
    func testATransportFailureIsLeftToTheOfflineBanner() async {
        let offline = APIError.network(underlying: URLError(.notConnectedToInternet))
        let transport = FailingMessagesTransport(error: offline)
        let store = ChatStore(transport: transport)

        store.select(conversation)
        await poll("the read to be attempted") { transport.calls > 0 }
        // Give the catch path a beat to run past the throw.
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertNil(store.errorMessage,
                     "offline is the OfflineBanner's sentence, not the chat's")
    }

    /// A CANCELLATION is the app's own doing (switching conversations tears the previous
    /// fetch down) and must never be reported as a failure to the reader.
    func testACancelledReadSaysNothing() async {
        let transport = FailingMessagesTransport(error: APIError.cancelled)
        let store = ChatStore(transport: transport)

        store.select(conversation)
        await poll("the read to be attempted") { transport.calls > 0 }
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertNil(store.errorMessage)
    }

    /// …and a read that finally lands RETRACTS the banner, so pull-to-refresh visibly
    /// resolves rather than leaving a stale complaint over a correct transcript.
    func testASuccessfulRetryRetractsTheBanner() async {
        let transport = FailingMessagesTransport(error: APIError.badResponse)
        let store = ChatStore(transport: transport)

        store.select(conversation)
        await poll("the failure to be stated") { store.errorMessage != nil }

        transport.error = nil
        await store.loadMessages(conversation)
        XCTAssertNil(store.errorMessage, "the banner belongs to the failed read only")
        XCTAssertEqual(store.messages.map(\.id), ["m1"])
    }

    /// The banner is only retracted when it IS this banner. A send/turn error belongs to
    /// the reader's last action and a background poll must not wipe it.
    ///
    /// RED PROOF (`errorMessage = nil` unconditionally in the success path):
    ///   XCTAssertEqual failed: ("nil") is not equal to ("Still replying — retry when
    ///   the turn finishes.")
    func testASuccessfulReadLeavesASendErrorAlone() async {
        let transport = FailingMessagesTransport(error: nil)
        let store = ChatStore(transport: transport)
        store.select(conversation)
        await poll("the first page") { !store.messages.isEmpty }

        let sendError = "Still replying — retry when the turn finishes."
        store.errorMessage = sendError
        await store.loadMessages(conversation)
        XCTAssertEqual(store.errorMessage, sendError,
                       "a poll-driven read may only retract its own sentence")
    }
}
