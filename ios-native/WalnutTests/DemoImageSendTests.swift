import UIKit
import XCTest
@testable import Walnut

/// A photo sent with no text. The App Store r6 gate attached one library photo in
/// the demo chat and tapped Send: the demo answered 400 "A message needs some text."
/// and the bubble read "Not sent. Tap to retry." That is the flow the review notes
/// describe. The real server takes an image-only turn on both message routes
/// (`api-v1.ts` and `session-send-v1.ts`: `images` allows an otherwise-empty text
/// turn; junk entries are dropped before that check), and the demo now does too.
@MainActor
final class DemoImageSendTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?
    private let api = WalnutAPI()

    override func setUp() async throws {
        // As in DemoModeTests: the host's own feeds stay down for the whole class.
        LifecycleHub.shared.teardownAll()
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.turnScale = 0
        DemoServer.shared.reset()
        DemoURLProtocol.resetLog()
    }

    override func tearDown() async throws {
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        DemoServer.shared.turnScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    nonisolated override class func tearDown() {
        MainActor.assumeIsolated { LifecycleHub.shared.resumeAll() }
        super.tearDown()
    }

    private func settleTurns() {
        let deadline = Date().addingTimeInterval(5)
        while DemoServer.shared.pendingStepCount > 0, Date() < deadline {
            usleep(5_000)
        }
        DemoServer.shared.turnQueue.sync {}
        DemoServer.shared.streams.drain()
        XCTAssertEqual(DemoServer.shared.pendingStepCount, 0, "scripted turns did not finish")
    }

    /// Real JPEG bytes, as the composer sends them.
    private func jpegData() -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        let image = renderer.image { context in
            UIColor.systemOrange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        return image.jpegData(compressionQuality: 0.8)!
    }

    private func photo() -> ImagePayload {
        ImagePayload(data: jpegData().base64EncodedString(), mediaType: "image/jpeg")
    }

    private func status(of error: Error) -> Int? {
        if case .server(let status, _, _, _, _) = error as? APIError { return status }
        return nil
    }

    // MARK: - Chat

    func testAPhotoWithoutTextIsAChatTurn() async throws {
        let id = try await api.createConversation(title: nil)
        let turn = try await api.sendMessage(conversationID: id, text: "", images: [photo()])
        XCTAssertFalse(turn.isEmpty)
        settleTurns()

        let messages = try await api.messages(conversationID: id)
        let user = try XCTUnwrap(messages.first)
        XCTAssertEqual(user.role, "user")
        XCTAssertEqual(user.text, "", "the row keeps the text as sent, so the app can put its photo back on it")
        let reply = try XCTUnwrap(messages.last { $0.role == "assistant" && $0.kind == nil })
        XCTAssertTrue(reply.text.contains("photo"), "the reply answers the photo: \(reply.text)")
        let conversations = try await api.conversations()
        let title = try XCTUnwrap(conversations.first { $0.id == id }?.title)
        XCTAssertFalse(title.isEmpty, "a chat started with a photo still gets a title")
        XCTAssertTrue(DemoServer.shared.unansweredRoutes.isEmpty)
        XCTAssertTrue(DemoURLProtocol.blockedByTheCodeUnderTest.isEmpty)
    }

    func testAPhotoWithTextKeepsTheTopicReply() async throws {
        let id = try await api.createConversation(title: nil)
        _ = try await api.sendMessage(conversationID: id, text: "Here is the counter sample.", images: [photo()])
        settleTurns()
        let messages = try await api.messages(conversationID: id)
        XCTAssertEqual(messages.first?.text, "Here is the counter sample.")
        let reply = try XCTUnwrap(messages.last { $0.role == "assistant" && $0.kind == nil })
        XCTAssertTrue(reply.text.contains("counter quotes"), "a photo does not change what the words ask: \(reply.text)")
    }

    func testNoTextAndNoPhotoIsStillRefused() async throws {
        let id = try await api.createConversation(title: nil)
        do {
            _ = try await api.sendMessage(conversationID: id, text: "   ")
            XCTFail("an empty message was taken")
        } catch {
            XCTAssertEqual(status(of: error), 400)
        }
        let messages = try await api.messages(conversationID: id)
        XCTAssertTrue(messages.isEmpty)
    }

    /// The server drops an entry it could not use (no data, a type that is not an
    /// image) before it decides whether the message is empty; so does the demo.
    func testAnImageTheServerWouldDropIsNoPhoto() async throws {
        let id = try await api.createConversation(title: nil)
        for junk in [
            ImagePayload(data: "", mediaType: "image/jpeg"),
            ImagePayload(data: jpegData().base64EncodedString(), mediaType: "application/pdf"),
        ] {
            do {
                _ = try await api.sendMessage(conversationID: id, text: "", images: [junk])
                XCTFail("an empty message with an unusable image was taken (\(junk.mediaType))")
            } catch {
                XCTAssertEqual(status(of: error), 400)
            }
        }
        let accepted = try await api.sendMessage(
            conversationID: id, text: "",
            images: [ImagePayload(data: "", mediaType: "image/png"), photo()]
        )
        XCTAssertFalse(accepted.isEmpty, "one usable image among junk is a photo message")
        settleTurns()
    }

    /// The gate's own path: the chat store, a new chat, one photo and no words.
    func testTheChatStoreSendsAPhotoWithoutText() async throws {
        let chat = ChatStore()
        let image = try XCTUnwrap(SelectedImage(jpegData: jpegData()))
        let accepted = await chat.send("", images: [image])
        XCTAssertTrue(accepted, "the photo was refused: \(chat.errorMessage ?? "no error")")
        XCTAssertNil(chat.errorMessage)
        XCTAssertFalse(chat.messages.contains { $0.failed == true }, "the bubble reads Not sent")
        settleTurns()
        let id = try XCTUnwrap(chat.activeID)
        await chat.loadMessages(id)
        let user = try XCTUnwrap(chat.messages.first { $0.role == "user" })
        XCTAssertEqual(user.localImages?.count, 1, "the photo stays on its bubble")
        XCTAssertTrue(chat.messages.contains { $0.role == "assistant" && $0.kind == nil })
    }

    // MARK: - Sessions

    func testAPhotoWithoutTextIsASessionTurn() async throws {
        let before = try await api.sessionTranscript(id: "s-crash").messages.count
        let receipt = try await api.sendSessionMessage(id: "s-crash", text: "", images: [photo()])
        XCTAssertFalse(receipt.messageId.isEmpty)
        settleTurns()
        let after = try await api.sessionTranscript(id: "s-crash").messages
        XCTAssertGreaterThan(after.count, before)
        let reply = try XCTUnwrap(after.last { $0.role == "assistant" && $0.kind == nil })
        XCTAssertTrue(reply.text.contains("photo"), "the session answers the photo: \(reply.text)")
        XCTAssertTrue(DemoServer.shared.unansweredRoutes.isEmpty)
    }

    /// The session's page after a photo with no words: the transcript names the saved
    /// photo the way the real server does, the demo serves it back, and the page
    /// shows it once (the sent bubble gives way to the transcript's row).
    func testASessionPhotoShowsOnceAfterTheTurn() async throws {
        let listed = try await api.sessions().sessions
        let session = try XCTUnwrap(listed.first { $0.id == "s-crash" })
        let store = SessionConversationStore(session: session, resumeIDs: SessionStreamResumeIDs(defaults: nil))
        await store.open()
        defer { store.close() }
        let sent = jpegData()
        let image = try XCTUnwrap(SelectedImage(jpegData: sent))
        let accepted = await store.send("", images: [image])
        XCTAssertTrue(accepted)
        settleTurns()
        store.reconcile(try await api.sessionTranscript(id: "s-crash"))

        let photoRows = store.messages.filter { $0.role == "user" && MessageRow.imageSendParts($0.text) != nil }
        XCTAssertEqual(photoRows.count, 1)
        let parts = try XCTUnwrap(MessageRow.imageSendParts(photoRows[0].text))
        XCTAssertEqual(parts.paths.count, 1)
        XCTAssertEqual(parts.text, "")
        XCTAssertFalse(store.messages.contains { $0.localImages != nil }, "the sent bubble stayed beside the row that shows its photo")
        XCTAssertTrue(store.messages.contains { $0.role == "assistant" && $0.kind == nil && $0.text.contains("photo") })

        // The page loads the photo from the media route: the bytes that were sent.
        let url = try XCTUnwrap(WalnutAPI.mediaURL(absolutePath: parts.paths[0], sessionID: "s-crash"))
        var request = URLRequest(url: url)
        request.setValue("Bearer \(DemoMode.token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession(configuration: DemoMode.configured(.ephemeral)).data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertNotEqual(data, DemoImage.png, "the media route serves the photo that was sent, not the sample picture")
        XCTAssertNotNil(UIImage(data: data))
        XCTAssertTrue(DemoServer.shared.unansweredRoutes.isEmpty)
    }

    func testNoTextAndNoPhotoIsStillRefusedInASession() async throws {
        do {
            _ = try await api.sendSessionMessage(id: "s-crash", text: "")
            XCTFail("an empty session message was taken")
        } catch {
            XCTAssertEqual(status(of: error), 400)
        }
        do {
            _ = try await api.sendSessionMessage(
                id: "s-crash", text: " ", images: [ImagePayload(data: "x", mediaType: "text/plain")]
            )
            XCTFail("an empty session message with an unusable image was taken")
        } catch {
            XCTAssertEqual(status(of: error), 400)
        }
    }
}
