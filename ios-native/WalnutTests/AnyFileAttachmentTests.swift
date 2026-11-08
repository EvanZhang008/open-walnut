import XCTest
import UIKit
import ImageIO
import UniformTypeIdentifiers
@testable import Walnut

/// Any file on any composer: a HEIC from Files goes as a JPEG, the uploads route
/// with no session (the main chat, a session that does not exist yet), the main
/// chat's send of a message with files (upload first, then the paths), one failed
/// file removed from a send that has not gone, and the limits the `+` states.
final class AnyFileAttachmentTests: XCTestCase {

    /// A file the way the app keeps one: its own folder under the store's root.
    private func tempFile(_ bytes: Int, name: String) throws -> ComposerFile {
        let id = "up-" + UUID().uuidString.lowercased()
        let dir = ComposerFileStore.root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent(name)
        var data = Data(count: bytes)
        for i in 0..<bytes { data[i] = UInt8(i % 251) }
        try data.write(to: url)
        return ComposerFile(id: id, name: name, size: Int64(bytes),
                            sha256: try ComposerFileStore.sha256(of: url),
                            kind: ComposerFile.kind(for: nil, name: name), localURL: url)
    }

    private func scratchDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("any-file-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    // MARK: - HEIC

    /// A 40 x 20 picture saved as HEIC with orientation 6 (to be turned a quarter
    /// clockwise), the way an iPhone records a portrait shot. nil when this
    /// simulator cannot encode HEIC.
    private func makeHEIC(at url: URL, width: Int = 40, height: Int = 20, orientation: Int = 6) -> Bool {
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
        context.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.3, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = context.makeImage(),
              let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.heic.identifier as CFString, 1, nil)
        else { return false }
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        return CGImageDestinationFinalize(destination)
    }

    func testAHEICFromFilesBecomesAFullSizeJPEGTurnedUpright() async throws {
        let source = try scratchDir().appendingPathComponent("IMG_0042.HEIC")
        guard makeHEIC(at: source) else {
            throw XCTSkip("This simulator's ImageIO cannot encode HEIC, so no HEIC can be made to import.")
        }
        let file = try await ComposerFileStore.importCopy(of: source, scoped: false)
        addTeardownBlock { ComposerFileStore.remove(file) }
        XCTAssertEqual(file.name, "IMG_0042.jpg")
        XCTAssertEqual(file.kind, .image)
        XCTAssertEqual(file.localURL.lastPathComponent, "IMG_0042.jpg")
        let bytes = try Data(contentsOf: file.localURL)
        XCTAssertEqual(Array(bytes.prefix(3)), [0xFF, 0xD8, 0xFF], "the copy is a JPEG")
        XCTAssertEqual(file.size, Int64(bytes.count), "the size is the JPEG's")
        XCTAssertEqual(file.sha256, try ComposerFileStore.sha256(of: file.localURL), "the checksum is the JPEG's")
        // Full size, with the recorded orientation applied to the pixels.
        let decoded = try XCTUnwrap(CGImageSourceCreateWithURL(file.localURL as CFURL, nil))
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(decoded, 0, nil) as? [CFString: Any])
        XCTAssertEqual((props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue, 20)
        XCTAssertEqual((props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue, 40)
    }

    func testABigHEICIsScaledDownAsItDecodes() async throws {
        let source = try scratchDir().appendingPathComponent("IMG_0043.HEIC")
        guard makeHEIC(at: source, width: ComposerFileStore.maxHEICPixels + 200, height: 16, orientation: 1) else {
            throw XCTSkip("This simulator's ImageIO cannot encode HEIC, so no HEIC can be made to import.")
        }
        let file = try await ComposerFileStore.importCopy(of: source, scoped: false)
        addTeardownBlock { ComposerFileStore.remove(file) }
        let decoded = try XCTUnwrap(CGImageSourceCreateWithURL(file.localURL as CFURL, nil))
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(decoded, 0, nil) as? [CFString: Any])
        XCTAssertEqual((props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue, ComposerFileStore.maxHEICPixels)
    }

    func testAHEICThatDoesNotDecodeIsKeptAsItIs() async throws {
        let source = try scratchDir().appendingPathComponent("broken.heic")
        let junk = Data("not a picture at all".utf8)
        try junk.write(to: source)
        let file = try await ComposerFileStore.importCopy(of: source, scoped: false)
        addTeardownBlock { ComposerFileStore.remove(file) }
        XCTAssertEqual(file.name, "broken.heic")
        XCTAssertEqual(try Data(contentsOf: file.localURL), junk)
    }

    func testOtherFilesAreCopiedUnchanged() async throws {
        let source = try scratchDir().appendingPathComponent("server.log")
        let text = Data("line 1\nline 2\n".utf8)
        try text.write(to: source)
        let file = try await ComposerFileStore.importCopy(of: source, scoped: false)
        addTeardownBlock { ComposerFileStore.remove(file) }
        XCTAssertEqual(file.name, "server.log")
        XCTAssertEqual(try Data(contentsOf: file.localURL), text)
        XCTAssertFalse(ComposerFileStore.isHEIC(type: nil, name: "server.log"))
        XCTAssertTrue(ComposerFileStore.isHEIC(type: nil, name: "a.HEIF"))
        XCTAssertTrue(ComposerFileStore.isHEIC(type: .heic, name: "no-extension"))
    }

    // MARK: - The routes

    func testTheUploadRoutesNameTheSessionOrNone() throws {
        XCTAssertEqual(UploadTarget.session("s1").path(uploadID: "up-a1"), "/api/v1/sessions/s1/uploads/up-a1")
        XCTAssertEqual(UploadTarget.session("a b").path(uploadID: "up-a1"), "/api/v1/sessions/a%20b/uploads/up-a1")
        XCTAssertEqual(UploadTarget.unbound.path(uploadID: "up-a1"), "/api/v1/uploads/up-a1")
        let base = try XCTUnwrap(URL(string: "https://walnut.example:3456"))
        let url = try XCTUnwrap(UploadTarget.unbound.chunkURL(
            base: base, uploadID: "up-a1", name: "a+b log.txt", size: 10, offset: 4, sha256: "abc"))
        XCTAssertEqual(url.path, "/api/v1/uploads/up-a1")
        let query = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery)
        XCTAssertEqual(query, "offset=4&size=10&name=a%2Bb%20log.txt&sha256=abc")
        let first = try XCTUnwrap(UploadTarget.session("s1").chunkURL(
            base: base, uploadID: "up-a1", name: "x.pdf", size: 3, offset: 0, sha256: nil))
        XCTAssertFalse(first.absoluteString.contains("sha256"), "only the last chunk carries the checksum")
    }

    func testAnUnboundUploadGoesThroughTheSameUploader() async throws {
        let file = try tempFile(SessionFileUploader.chunkBytes + 7, name: "dump.zip")
        let host = FakeUploadHost()
        let path = try await SessionFileUploader.upload(file, target: .unbound, transport: host, pauseBetweenTries: .zero) { _ in }
        XCTAssertEqual(path, "/host/uploads/\(file.id)/dump.zip")
        XCTAssertEqual(host.calls.map(\.offset), [0, Int64(SessionFileUploader.chunkBytes)])
        XCTAssertTrue(host.calls.allSatisfy { $0.target == .unbound })
    }

    // MARK: - The card

    func testAFailedFilesCardOffersRetryAndRemoveUntilItIsOnTheHost() throws {
        let file = try tempFile(1000, name: "trace.log")
        let failed = TimelineFileChip.local(file, held: 400, pending: false, failed: true, failedHere: true)
        XCTAssertTrue(failed.offersActions)
        XCTAssertEqual(failed.fileID, file.id)
        XCTAssertEqual(failed.detail, "Upload failed at 40% · \(ComposerFile.sizeLabel(1000))")
        let notTried = TimelineFileChip.local(file, held: nil, pending: false, failed: true)
        XCTAssertTrue(notTried.offersActions)
        XCTAssertEqual(notTried.detail, "Not uploaded · \(ComposerFile.sizeLabel(1000))")
        let onHost = TimelineFileChip.local(file, held: 1000, pending: false, failed: true)
        XCTAssertFalse(onHost.offersActions, "a file on the host is not what failed")
        let uploading = TimelineFileChip.local(file, held: 400, pending: true, failed: false)
        XCTAssertFalse(uploading.offersActions)
        XCTAssertFalse(TimelineFileChip.sent(path: "/h/up-1/trace.log").offersActions)
    }

    // MARK: - The limits

    @MainActor
    func testThePlusMenuStatesTheRealLimits() {
        XCTAssertEqual(ComposerFile.maxBytesLabel, "4 GB")
        XCTAssertEqual(ComposerBar.attachmentLimitsLine(acceptsFiles: true),
                       "Up to \(ComposerFile.maxFiles) files, 4 GB each, and \(ComposerBar.maxImages) photos per message.")
        XCTAssertEqual(ComposerBar.attachmentLimitsLine(acceptsFiles: false),
                       "Up to \(ComposerBar.maxImages) photos per message.")
        XCTAssertEqual(ComposerFileStore.ImportError.tooLarge(5 * 1024 * 1024 * 1024).errorDescription?
            .hasSuffix("a file can be at most 4 GB."), true)
    }

    // MARK: - The main chat

    private let conv = "any-file-conv"

    /// The main chat's kept file sends of `conv` (`PendingFileSends.chatKey`).
    private var convOutboxKey: String { PendingFileSends.chatKey(conversationID: conv, agentID: ChatStore.mainAgentID) }

    @MainActor
    private func clearConvOutbox() {
        for entry in PendingFileSends.entries(session: convOutboxKey) {
            PendingFileSends.remove(session: convOutboxKey, bubble: entry.bubbleID)
        }
    }

    /// `kept`: a file send an earlier run of the app left on disk.
    @MainActor
    private func openedChat(uploads: SessionUploadTransport,
                            kept: PendingFileSends.Entry? = nil) async -> (ChatStore, MockChatSendTransport) {
        DiskCache.remove(key: "messages-\(conv)")
        // A send an earlier test left kept would be put back, and go, on `select`.
        clearConvOutbox()
        if let kept { PendingFileSends.save(kept, images: []) }
        let reads = MockChatMessagesTransport()
        reads.rows = [conv: []]
        let writes = MockChatSendTransport()
        let chat = ChatStore(transport: reads, sendTransport: writes, uploads: uploads)
        addTeardownBlock { @MainActor in
            chat.eraseLocalState()
            DiskCache.remove(key: "messages-\(self.conv)")
            self.clearConvOutbox()
        }
        chat.select(conv)
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, reads.answeredConversations.isEmpty { try? await Task.sleep(for: .milliseconds(5)) }
        for _ in 0..<20 { await Task.yield() }
        return (chat, writes)
    }

    @MainActor
    func testAMainChatSendWithFilesUploadsThemThenSendsTheirPaths() async throws {
        let log = try tempFile(SessionFileUploader.chunkBytes + 10, name: "server.log")
        let pdf = try tempFile(300, name: "spec.pdf")
        let host = FakeUploadHost()
        let (chat, writes) = await openedChat(uploads: host)
        let outcome = await chat.sendWithFiles("why does this fail?", files: [log, pdf])
        XCTAssertTrue(outcome.keptTheWords)
        XCTAssertEqual(writes.requestedTexts, [ComposerFile.messageText("why does this fail?", paths: [
            "/host/uploads/\(log.id)/server.log", "/host/uploads/\(pdf.id)/spec.pdf",
        ])])
        XCTAssertEqual(host.calls.map(\.uploadID), [log.id, log.id, pdf.id], "every chunk went before the message")
        XCTAssertTrue(host.calls.allSatisfy { $0.target == .unbound }, "the main chat's files have no session")
        XCTAssertFalse(chat.messages.contains { $0.localFiles != nil }, "the upload bubble gave way to the message")
        XCTAssertEqual(chat.messages.filter { $0.isUser }.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: log.localURL.path), "a sent file's copy goes")
    }

    @MainActor
    func testAFailedMainChatUploadKeepsTheBubbleAndARetryResumes() async throws {
        let file = try tempFile(SessionFileUploader.chunkBytes + 10, name: "core.dump")
        let host = FakeUploadHost()
        host.failAtOffset[Int64(SessionFileUploader.chunkBytes)] = APIError.server(
            status: 507, code: "host_disk_full", message: "The host does not have room for this file.",
            serverHash: nil, serverContent: nil)
        let (chat, writes) = await openedChat(uploads: host)
        let outcome = await chat.sendWithFiles("", files: [file])
        XCTAssertTrue(outcome.keptTheWords, "the failed bubble holds the send")
        XCTAssertTrue(writes.requests.isEmpty, "no message before its files are up")
        let failed = try XCTUnwrap(chat.messages.first { $0.failed == true })
        XCTAssertEqual(failed.localFiles?.map(\.id), [file.id])
        XCTAssertEqual(failed.uploadFailedID, file.id)
        XCTAssertEqual(failed.uploadHeld?[file.id], Int64(SessionFileUploader.chunkBytes))
        XCTAssertEqual(chat.errorMessage, "The host does not have room for this file.")

        host.failAtOffset = [:]
        await chat.retry(failed)
        XCTAssertEqual(host.calls.filter { $0.offset == 0 }.count, 1, "the retry resumed")
        XCTAssertEqual(writes.requestedTexts, [ComposerFile.messageText("", paths: ["/host/uploads/\(file.id)/core.dump"])])
        XCTAssertFalse(chat.messages.contains { $0.failed == true })
    }

    @MainActor
    func testRemovingTheFailedFileFromAMainChatSendSendsTheRest() async throws {
        let good = try tempFile(200, name: "notes.txt")
        let bad = try tempFile(200, name: "huge.mov")
        let host = FakeUploadHost()
        host.failUploads[bad.id] = APIError.server(status: 507, code: "host_disk_full", message: "full",
                                                   serverHash: nil, serverContent: nil)
        let (chat, writes) = await openedChat(uploads: host)
        _ = await chat.sendWithFiles("look", files: [good, bad])
        let failed = try XCTUnwrap(chat.messages.first { $0.failed == true })
        XCTAssertEqual(failed.uploadFailedID, bad.id)
        XCTAssertTrue(writes.requests.isEmpty)

        let goodCalls = host.calls.filter { $0.uploadID == good.id }.count
        await chat.removeFile(bad.id, from: failed)
        XCTAssertEqual(writes.requestedTexts, [ComposerFile.messageText("look", paths: ["/host/uploads/\(good.id)/notes.txt"])])
        XCTAssertEqual(host.calls.filter { $0.uploadID == good.id }.count, goodCalls, "the file already up was not sent again")
        XCTAssertFalse(FileManager.default.fileExists(atPath: bad.localURL.path), "the removed file's copy goes")
        XCTAssertFalse(chat.messages.contains { $0.failed == true })
    }

    @MainActor
    func testRemovingTheOnlyFileOfAWordlessSendDiscardsIt() async throws {
        let bad = try tempFile(50, name: "x.bin")
        let host = FakeUploadHost()
        host.failUploads[bad.id] = APIError.server(status: 507, code: "host_disk_full", message: "full",
                                                   serverHash: nil, serverContent: nil)
        let (chat, writes) = await openedChat(uploads: host)
        _ = await chat.sendWithFiles("", files: [bad])
        let failed = try XCTUnwrap(chat.messages.first { $0.failed == true })
        await chat.removeFile(bad.id, from: failed)
        XCTAssertTrue(writes.requests.isEmpty, "nothing was left to send")
        XCTAssertFalse(chat.messages.contains { $0.id == failed.id })
    }

    // MARK: - A session

    @MainActor
    func testRemovingTheFailedFileFromASessionSendSendsTheRest() async throws {
        let session = "any-file-remove-" + UUID().uuidString.lowercased()
        addTeardownBlock { @MainActor in
            for e in PendingFileSends.entries(session: session) { PendingFileSends.remove(session: session, bubble: e.bubbleID) }
        }
        let good = try tempFile(200, name: "notes.txt")
        let bad = try tempFile(200, name: "huge.mov")
        let host = FakeUploadHost()
        host.failUploads[bad.id] = APIError.server(status: 507, code: "host_disk_full", message: "full",
                                                   serverHash: nil, serverContent: nil)
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await store.open()
        _ = await store.sendFromComposer("look", files: [good, bad])
        let failed = try XCTUnwrap(store.messages.first { $0.failed == true })
        XCTAssertEqual(failed.uploadFailedID, bad.id)
        XCTAssertEqual(PendingFileSends.entries(session: session).first?.files.count, 2)

        await store.removeFile(bad.id, from: failed)
        XCTAssertEqual(transport.sendCalls.count, 1)
        XCTAssertEqual(transport.sendCalls.first?.text,
                       ComposerFile.messageText("look", paths: ["/host/uploads/\(good.id)/notes.txt"]))
        XCTAssertTrue(host.calls.allSatisfy { $0.target == .session(session) })
        XCTAssertFalse(FileManager.default.fileExists(atPath: bad.localURL.path))
        store.close()
    }

    /// A new session's first message names its files itself; its row, with the
    /// files where the server put them on the session's host, takes its place.
    @MainActor
    func testANewSessionsFirstMessageWithFilesShowsOnce() async throws {
        let session = "any-file-launch-" + UUID().uuidString.lowercased()
        let sent = ComposerFile.messageText("read the log", paths: ["/mac/uploads/up-1/server.log"])
        SessionLaunchContext.stash(sessionId: session, message: sent)
        let transport = MockSessionSendTransport()
        transport.transcript = SessionTranscript(
            sessionId: session, exportedAt: "2026-11-07T08:10:00Z", truncated: false,
            messages: [SessionTranscript.Message(
                role: "user", text: ComposerFile.messageText("read the log", paths: ["/remote/task/uploads/up-1/server.log"]),
                timestamp: "2026-11-07T08:09:00Z", kind: nil)])
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: FakeUploadHost())
        await store.open()
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline, store.messages.filter(\.isUser).count != 1 { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(store.messages.filter(\.isUser).count, 1, "the launch bubble gave way to its row")
        store.close()
    }

    // MARK: - The main chat keeps a file send (review: durability)

    private func diskFull() -> APIError {
        APIError.server(status: 507, code: "host_disk_full", message: "The host does not have room for this file.",
                        serverHash: nil, serverContent: nil)
    }

    @MainActor
    private func waitUntil(_ seconds: TimeInterval = 5, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, !condition() { try? await Task.sleep(for: .milliseconds(20)) }
    }

    @MainActor
    func testAFailedMainChatFileSendIsKeptUntilItsWordsGo() async throws {
        let file = try tempFile(300, name: "trace.log")
        let host = FakeUploadHost()
        host.failUploads[file.id] = diskFull()
        let (chat, writes) = await openedChat(uploads: host)
        _ = await chat.sendWithFiles("look", files: [file])
        let kept = PendingFileSends.entries(session: convOutboxKey)
        XCTAssertEqual(kept.map(\.text), ["look"], "the failed send is on disk")
        XCTAssertEqual(kept.first?.files.map(\.id), [file.id])
        XCTAssertEqual(kept.first?.failed, true, "a failure that does not clear comes back as not sent")

        host.failUploads = [:]
        let failed = try XCTUnwrap(chat.messages.first { $0.failed == true })
        await chat.retry(failed)
        XCTAssertEqual(writes.requestedTexts, [ComposerFile.messageText("look", paths: ["/host/uploads/\(file.id)/trace.log"])])
        XCTAssertTrue(PendingFileSends.entries(session: convOutboxKey).isEmpty, "the kept copy goes once the words do")
    }

    @MainActor
    func testAFailedMainChatFileSendComesBackAfterAChatSwitch() async throws {
        let file = try tempFile(300, name: "trace.log")
        let host = FakeUploadHost()
        host.failUploads[file.id] = diskFull()
        let (chat, writes) = await openedChat(uploads: host)
        _ = await chat.sendWithFiles("look", files: [file])
        let bubbleID = try XCTUnwrap(chat.messages.first { $0.failed == true }?.id)

        chat.select("any-file-other-conv")
        XCTAssertFalse(chat.messages.contains { $0.id == bubbleID }, "another chat does not show it")
        chat.select(conv)
        let back = try XCTUnwrap(chat.messages.first { $0.id == bubbleID }, "the failed send is back with its chat")
        XCTAssertEqual(back.failed, true)
        XCTAssertEqual(back.localFiles?.map(\.id), [file.id])
        XCTAssertTrue(writes.requests.isEmpty, "a send that failed for good does not go by itself")
        // It survives the history read that follows a switch.
        for _ in 0..<40 { await Task.yield() }
        XCTAssertTrue(chat.messages.contains { $0.id == bubbleID })

        host.failUploads = [:]
        await chat.retry(back)
        XCTAssertEqual(writes.requestedTexts.count, 1)
    }

    /// The app ended mid-upload: the next run's chat puts the send back and it
    /// goes by itself, resuming where the host's copy stood.
    @MainActor
    func testAKeptMainChatFileSendGoesOnInTheNextRun() async throws {
        let file = try tempFile(SessionFileUploader.chunkBytes + 20, name: "dump.zip")
        let kept = PendingFileSends.Entry(
            bubbleID: "local-files-kept-1", messageID: "qm-mobile-kept01", sessionID: convOutboxKey,
            text: "from before", createdAt: "2026-11-07T08:00:00Z", voice: false,
            files: [PendingFileSends.ref(file)], held: [:], imageCount: 0, savedAt: Date()
        )
        let host = FakeUploadHost()
        let (chat, writes) = await openedChat(uploads: host, kept: kept)
        await waitUntil { !writes.requests.isEmpty }
        XCTAssertEqual(writes.requestedTexts, [ComposerFile.messageText("from before", paths: ["/host/uploads/\(file.id)/dump.zip"])])
        XCTAssertTrue(host.calls.allSatisfy { $0.target == .unbound })
        XCTAssertFalse(chat.messages.contains { $0.id == "local-files-kept-1" })
        // The kept copy goes once the POST is answered, a moment after it is seen.
        await waitUntil { PendingFileSends.entries(session: self.convOutboxKey).isEmpty }
        XCTAssertTrue(PendingFileSends.entries(session: convOutboxKey).isEmpty)
    }

    /// The words go before the kept copy does, and while they go the copy says
    /// "not sent": an app ended then shows them, and never sends them twice.
    @MainActor
    func testTheKeptCopyStaysUntilTheWordsAreHeld() async throws {
        let file = try tempFile(300, name: "trace.log")
        let (chat, writes) = await openedChat(uploads: FakeUploadHost())
        let posting = CheckedContinuationGate()
        writes.sendGate = posting
        let send = Task { await chat.sendWithFiles("look", files: [file]) }
        await waitUntil { !writes.requests.isEmpty }
        let kept = PendingFileSends.entries(session: convOutboxKey)
        XCTAssertEqual(kept.map(\.text), ["look"], "kept while the words go")
        XCTAssertEqual(kept.first?.failed, true, "a later run would not send it again by itself")
        posting.open()
        _ = await send.value
        XCTAssertTrue(PendingFileSends.entries(session: convOutboxKey).isEmpty)
    }

    /// Unpairing: a kept send must never reach the next server. A new chat's
    /// key is the same on every server, so it would be put back and sent there.
    @MainActor
    func testUnpairingErasesEveryKeptFileSend() async throws {
        let newKey = PendingFileSends.chatKey(conversationID: nil, agentID: ChatStore.mainAgentID)
        let session = "any-file-erase-" + UUID().uuidString.lowercased()
        let file = try tempFile(300, name: "private.log")
        func entry(_ key: String) -> PendingFileSends.Entry {
            PendingFileSends.Entry(bubbleID: "local-files-erase-\(key.count)", messageID: "qm-mobile-erase1",
                                   sessionID: key, text: "old server's words", createdAt: "2026-11-07T08:00:00Z",
                                   voice: false, files: [PendingFileSends.ref(file)], held: [:], imageCount: 0,
                                   savedAt: Date())
        }
        PendingFileSends.save(entry(newKey), images: [Data("jpeg".utf8)])
        PendingFileSends.save(entry(session), images: [])
        XCTAssertEqual(PendingFileSends.entries(session: newKey).count, 1)

        let old = ChatStore(transport: MockChatMessagesTransport(), sendTransport: MockChatSendTransport(),
                            uploads: FakeUploadHost())
        old.eraseLocalState()
        XCTAssertTrue(PendingFileSends.entries(session: newKey).isEmpty)
        XCTAssertTrue(PendingFileSends.entries(session: session).isEmpty, "a session's too")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.localURL.path), "and the files' copies")

        // The next pairing's new chat has nothing to put back or send.
        let writes = MockChatSendTransport()
        let next = ChatStore(transport: MockChatMessagesTransport(), sendTransport: writes, uploads: FakeUploadHost())
        addTeardownBlock { @MainActor in next.eraseLocalState() }
        next.select(nil)
        for _ in 0..<40 { await Task.yield() }
        XCTAssertFalse(next.messages.contains { $0.localFiles != nil })
        XCTAssertTrue(writes.requests.isEmpty)
    }

    /// The Mac away for a moment (a 503 `needs_leader` on every try of a chunk):
    /// the send waits and goes again by itself, like a session page's.
    @MainActor
    func testATransientMainChatUploadFailureRetriesByItself() async throws {
        let file = try tempFile(300, name: "notes.txt")
        let host = FakeUploadHost()
        let away = APIError.server(status: 503, code: "needs_leader", message: "This needs your Mac.",
                                   serverHash: nil, serverContent: nil)
        host.failNext = Array(repeating: away, count: SessionFileUploader.triesPerChunk)
        let (chat, writes) = await openedChat(uploads: host)
        _ = await chat.sendWithFiles("look", files: [file])
        let waiting = try XCTUnwrap(chat.messages.first { $0.localFiles != nil })
        XCTAssertEqual(waiting.retryNotice, ChatStore.fileWaitingNotice, "it says it retries")
        XCTAssertTrue(chat.hasFileSendAheadHere, "still on its way: what is sent next waits")
        XCTAssertNil(chat.errorMessage)
        // It stops holding later messages back once its POST is answered.
        await waitUntil(15) { !writes.requests.isEmpty && !chat.hasFileSendAheadHere }
        XCTAssertEqual(writes.requestedTexts, [ComposerFile.messageText("look", paths: ["/host/uploads/\(file.id)/notes.txt"])])
        XCTAssertFalse(chat.hasFileSendAheadHere)
    }

    func testTheUploadRetriesAnAwayMacOnItsOwn() {
        func answer(_ status: Int, _ code: String) -> APIError {
            APIError.server(status: status, code: code, message: "", serverHash: nil, serverContent: nil)
        }
        XCTAssertTrue(SessionFileUploader.clearsOnItsOwn(answer(503, "needs_leader")))
        XCTAssertTrue(SessionFileUploader.clearsOnItsOwn(answer(503, "host_reconnecting")))
        XCTAssertTrue(SessionFileUploader.clearsOnItsOwn(answer(503, "bridge_offline")))
        XCTAssertFalse(SessionFileUploader.clearsOnItsOwn(answer(507, "host_disk_full")))
        XCTAssertFalse(SessionFileUploader.clearsOnItsOwn(answer(400, "needs_leader")))
    }

    // MARK: - The order messages go in (review: ordering)

    @MainActor
    func testAMainChatMessageSentWhileFilesGoUpGoesAfterThem() async throws {
        let file = try tempFile(300, name: "trace.log")
        let host = GatedUploadHost()
        let gate = CheckedContinuationGate()
        host.gates[file.id] = gate
        let (chat, writes) = await openedChat(uploads: host)
        let withFiles = Task { await chat.sendWithFiles("first", files: [file]) }
        await waitUntil { host.order.contains(file.id) }
        XCTAssertTrue(chat.hasFileSendAheadHere)
        let outcome = await chat.sendReportingOutcome("second")
        XCTAssertEqual(outcome, .queued, "banked behind the message whose files go up")
        XCTAssertTrue(writes.requests.isEmpty, "nothing went before the files' message")

        gate.open()
        _ = await withFiles.value
        XCTAssertEqual(writes.requestedTexts.first,
                       ComposerFile.messageText("first", paths: ["/host/uploads/\(file.id)/trace.log"]),
                       "the files' message went first")
        XCTAssertTrue(chat.queuedSends.contains { $0.text == "second" } || writes.requestedTexts.last == "second",
                      "the later words wait for its turn, or went after it")
    }

    @MainActor
    func testTwoMainChatFileSendsGoInTheOrderTheyWereSent() async throws {
        let big = try tempFile(300, name: "first.log")
        let small = try tempFile(10, name: "second.log")
        let host = GatedUploadHost()
        let gate = CheckedContinuationGate()
        host.gates[big.id] = gate
        let (chat, writes) = await openedChat(uploads: host)
        let first = Task { await chat.sendWithFiles("one", files: [big]) }
        await waitUntil { host.order.contains(big.id) }
        let second = Task { await chat.sendWithFiles("two", files: [small]) }
        await waitUntil { host.order.contains(small.id) }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(writes.requests.isEmpty, "the second's files are up, but it waits for the first")

        gate.open()
        _ = await first.value
        _ = await second.value
        XCTAssertEqual(writes.requestedTexts.first,
                       ComposerFile.messageText("one", paths: ["/host/uploads/\(big.id)/first.log"]))
        let secondText = ComposerFile.messageText("two", paths: ["/host/uploads/\(small.id)/second.log"])
        XCTAssertTrue(chat.queuedSends.contains { $0.text == secondText } || writes.requestedTexts.last == secondText)
        XCTAssertNotEqual(writes.requestedTexts.first, secondText)
    }

    /// Two file sends from a New chat: the first creates the conversation, and
    /// the second, made meanwhile, moves to it and goes there after the first.
    @MainActor
    func testTwoFileSendsFromANewChatBothGoToTheConversationTheFirstMade() async throws {
        let newKey = PendingFileSends.chatKey(conversationID: nil, agentID: ChatStore.mainAgentID)
        let madeKey = PendingFileSends.chatKey(conversationID: "conv-created", agentID: ChatStore.mainAgentID)
        let clear = { @MainActor in
            for key in [newKey, madeKey] {
                for e in PendingFileSends.entries(session: key) { PendingFileSends.remove(session: key, bubble: e.bubbleID) }
            }
            DiskCache.remove(key: "messages-conv-created")
        }
        clear()
        let a = try tempFile(200, name: "one.log")
        let b = try tempFile(100, name: "two.log")
        let reads = MockChatMessagesTransport()
        reads.rows = ["conv-created": []]
        let writes = MockChatSendTransport()
        let creating = CheckedContinuationGate()
        writes.createGate = creating
        let chat = ChatStore(transport: reads, sendTransport: writes, uploads: FakeUploadHost())
        addTeardownBlock { @MainActor in
            chat.eraseLocalState()
            clear()
        }
        chat.select(nil)
        let first = Task { await chat.sendWithFiles("one", files: [a]) }
        await waitUntil { writes.createCount == 1 }
        let second = Task { await chat.sendWithFiles("two", files: [b]) }
        // The first is still kept under the new chat too: it moves once the
        // conversation is made.
        await waitUntil { PendingFileSends.entries(session: newKey).count == 2 }
        XCTAssertEqual(PendingFileSends.entries(session: newKey).map(\.text), ["one", "two"], "kept under the new chat for now")

        creating.open()
        _ = await first.value
        _ = await second.value
        XCTAssertEqual(chat.activeID, "conv-created")
        XCTAssertEqual(writes.requestedTexts.first, ComposerFile.messageText("one", paths: ["/host/uploads/\(a.id)/one.log"]))
        let secondText = ComposerFile.messageText("two", paths: ["/host/uploads/\(b.id)/two.log"])
        let posted = writes.requests.count == 2 && writes.requests[1].text == secondText
            && writes.requests[1].conversationID == "conv-created"
        let banked = chat.queuedSends.contains { $0.text == secondText && $0.conversationID == "conv-created" }
        XCTAssertTrue(posted || banked, "the second send went to the conversation the first made, after it")
        XCTAssertFalse(chat.messages.contains { $0.localFiles != nil }, "no send is left waiting for the new chat")
        XCTAssertTrue(PendingFileSends.entries(session: newKey).isEmpty)
        XCTAssertTrue(PendingFileSends.entries(session: madeKey).isEmpty, "its kept copy went once its words did")
    }

    @MainActor
    func testASessionMessageSentWhileFilesGoUpGoesAfterThem() async throws {
        let session = "any-file-order-" + UUID().uuidString.lowercased()
        addTeardownBlock { @MainActor in
            for e in PendingFileSends.entries(session: session) { PendingFileSends.remove(session: session, bubble: e.bubbleID) }
        }
        let file = try tempFile(300, name: "trace.log")
        let host = GatedUploadHost()
        let gate = CheckedContinuationGate()
        host.gates[file.id] = gate
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await store.open()
        let withFiles = Task { await store.sendFromComposer("first", files: [file]) }
        await waitUntil { host.order.contains(file.id) }
        // Distinct bubble ids: the store names a bubble by the clock.
        try await Task.sleep(for: .milliseconds(20))
        let plain = Task { await store.sendFromComposer("second") }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(transport.sendCalls.isEmpty, "the plain message waits for the one with files")

        gate.open()
        _ = await withFiles.value
        _ = await plain.value
        XCTAssertEqual(transport.sendCalls.map(\.text), [
            ComposerFile.messageText("first", paths: ["/host/uploads/\(file.id)/trace.log"]), "second",
        ])
        store.close()
    }

    /// A plain message waiting behind a file send is not lost when the page
    /// closes: the running upload goes on in the closed page, then the message.
    @MainActor
    func testAWaitingSessionMessageStillGoesWhenThePageCloses() async throws {
        let session = "any-file-close-" + UUID().uuidString.lowercased()
        addTeardownBlock { @MainActor in
            for e in PendingFileSends.entries(session: session) { PendingFileSends.remove(session: session, bubble: e.bubbleID) }
        }
        let file = try tempFile(300, name: "trace.log")
        let host = GatedUploadHost()
        let gate = CheckedContinuationGate()
        host.gates[file.id] = gate
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await store.open()
        let withFiles = Task { await store.sendFromComposer("first", files: [file]) }
        await waitUntil { host.order.contains(file.id) }
        try await Task.sleep(for: .milliseconds(20))
        let plain = Task { await store.sendFromComposer("second") }
        try await Task.sleep(for: .milliseconds(200))
        store.close()
        gate.open()
        _ = await withFiles.value
        _ = await plain.value
        XCTAssertEqual(transport.sendCalls.map(\.text), [
            ComposerFile.messageText("first", paths: ["/host/uploads/\(file.id)/trace.log"]), "second",
        ])
    }

    /// The same, when the file send stops for its retry in the closed page (which
    /// only a page opened again would run): the plain message goes rather than wait for nothing.
    @MainActor
    func testAWaitingSessionMessageGoesWhenTheFileSendBeforeItPausesInAClosedPage() async throws {
        let session = "any-file-pause-" + UUID().uuidString.lowercased()
        addTeardownBlock { @MainActor in
            for e in PendingFileSends.entries(session: session) { PendingFileSends.remove(session: session, bubble: e.bubbleID) }
        }
        let file = try tempFile(300, name: "trace.log")
        let host = GatedUploadHost()
        let gate = CheckedContinuationGate()
        host.gates[file.id] = gate
        host.failures[file.id] = APIError.server(status: 503, code: "needs_leader", message: "This needs your Mac.",
                                                 serverHash: nil, serverContent: nil)
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await store.open()
        let withFiles = Task { await store.sendFromComposer("first", files: [file]) }
        await waitUntil { host.order.contains(file.id) }
        try await Task.sleep(for: .milliseconds(20))
        let plain = Task { await store.sendFromComposer("second") }
        try await Task.sleep(for: .milliseconds(200))
        store.close()
        gate.open()
        _ = await withFiles.value
        _ = await plain.value
        XCTAssertEqual(transport.sendCalls.map(\.text), ["second"], "not lost behind a send that waits for the page")
        XCTAssertEqual(PendingFileSends.entries(session: session).count, 1, "the file send stays kept for the page")
    }

    // MARK: - Second review: switches, new chats, order, reset

    /// A chat switch away and back while a file send's words are being POSTed:
    /// its bubble gave way to the message's own, so the kept copy is not drawn
    /// again (it stayed pending for good beside the message's row).
    @MainActor
    func testSwitchingAwayAndBackWhileAFileSendsWordsGoDrawsNoSecondBubble() async throws {
        let file = try tempFile(300, name: "trace.log")
        let (chat, writes) = await openedChat(uploads: FakeUploadHost())
        let posting = CheckedContinuationGate()
        writes.sendGate = posting
        let send = Task { await chat.sendWithFiles("look", files: [file]) }
        await waitUntil { !writes.requests.isEmpty }
        chat.select("any-file-other-conv")
        chat.select(conv)
        XCTAssertFalse(chat.messages.contains { $0.localFiles != nil }, "the words are on their way: no second bubble")

        posting.open()
        _ = await send.value
        XCTAssertFalse(chat.messages.contains { $0.localFiles != nil }, "nothing is left sending for good")
        await waitUntil { PendingFileSends.entries(session: self.convOutboxKey).isEmpty }
        XCTAssertTrue(PendingFileSends.entries(session: convOutboxKey).isEmpty)
    }

    /// The same switch, and the POST then fails: the message's failed bubble left
    /// with the chat, so the kept copy stays, and the send is back as not sent
    /// with its file, instead of existing nowhere.
    @MainActor
    func testAFileSendWhoseWordsFailAfterAChatSwitchComesBackNotSent() async throws {
        let file = try tempFile(300, name: "trace.log")
        let (chat, writes) = await openedChat(uploads: FakeUploadHost())
        let posting = CheckedContinuationGate()
        writes.sendGate = posting
        writes.script(.failure(APIError.server(status: 400, code: "bad_request", message: "Refused.",
                                               serverHash: nil, serverContent: nil)))
        let send = Task { await chat.sendWithFiles("look", files: [file]) }
        await waitUntil { !writes.requests.isEmpty }
        chat.select("any-file-other-conv")
        chat.select(conv)

        posting.open()
        _ = await send.value
        let back = try XCTUnwrap(chat.messages.first { $0.localFiles != nil }, "the send is back on its chat")
        XCTAssertEqual(back.failed, true, "as not sent, to retry or delete")
        XCTAssertEqual(back.localFiles?.map(\.id), [file.id])
        XCTAssertEqual(PendingFileSends.entries(session: convOutboxKey).map(\.failed), [true], "still kept on disk")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.localURL.path), "and its file's copy")
    }

    @MainActor
    func testAFileSendsWordsAreLetGoOnlyWhereSomethingHoldsThem() {
        var failed = ChatMessage(id: "local-1", role: "user", text: "look", createdAt: "", kind: nil)
        failed.clientMessageId = "qm-mobile-held1"
        failed.failed = true
        func held(_ outcome: ChatStore.SendOutcome, _ messages: [ChatMessage]) -> Bool {
            ChatStore.wordsHeld(after: outcome, clientMessageId: "qm-mobile-held1", bubbleID: "local-files-1", in: messages)
        }
        XCTAssertTrue(held(.queued, []))
        XCTAssertTrue(held(.started(accepted: true), []))
        XCTAssertTrue(held(.started(accepted: false), [failed]), "its failed bubble retries under the same id")
        XCTAssertFalse(held(.started(accepted: false), []), "a failed bubble that left with its chat holds nothing")
        XCTAssertFalse(held(.refusedKeepingNothing, [failed]))
    }

    /// The words of a file send whose files are up go where its bubble was:
    /// above a message banked while the files went up, which goes after it.
    @MainActor
    func testAFileSendsWordsTakeItsPlaceAboveWhatWasBankedMeanwhile() async throws {
        let file = try tempFile(300, name: "trace.log")
        let host = GatedUploadHost()
        let gate = CheckedContinuationGate()
        host.gates[file.id] = gate
        let (chat, _) = await openedChat(uploads: host)
        let withFiles = Task { await chat.sendWithFiles("first", files: [file]) }
        await waitUntil { host.order.contains(file.id) }
        let outcome = await chat.sendReportingOutcome("second")
        XCTAssertEqual(outcome, .queued)

        gate.open()
        _ = await withFiles.value
        let fileText = ComposerFile.messageText("first", paths: ["/host/uploads/\(file.id)/trace.log"])
        XCTAssertEqual(chat.messages.filter(\.isUser).map(\.text), [fileText, "second"], "drawn in the order they were sent")
    }

    /// A message typed in a New chat while its first message's files go up has no
    /// conversation to be banked against: it goes, makes the conversation, and the
    /// file send moves there (it was refused "not sent" every time).
    @MainActor
    func testAMessageSentWhileANewChatsFilesGoUpIsNotRefused() async throws {
        let newKey = PendingFileSends.chatKey(conversationID: nil, agentID: ChatStore.mainAgentID)
        let madeKey = PendingFileSends.chatKey(conversationID: "conv-created", agentID: ChatStore.mainAgentID)
        let clear = { @MainActor in
            for key in [newKey, madeKey] {
                for e in PendingFileSends.entries(session: key) { PendingFileSends.remove(session: key, bubble: e.bubbleID) }
            }
            DiskCache.remove(key: "messages-conv-created")
        }
        clear()
        let file = try tempFile(200, name: "one.log")
        let host = GatedUploadHost()
        let gate = CheckedContinuationGate()
        host.gates[file.id] = gate
        let reads = MockChatMessagesTransport()
        reads.rows = ["conv-created": []]
        let writes = MockChatSendTransport()
        let chat = ChatStore(transport: reads, sendTransport: writes, uploads: host)
        addTeardownBlock { @MainActor in
            chat.eraseLocalState()
            clear()
        }
        chat.select(nil)
        let withFiles = Task { await chat.sendWithFiles("one", files: [file]) }
        await waitUntil { host.order.contains(file.id) }
        XCTAssertTrue(chat.hasFileSendAheadHere)
        let outcome = await chat.sendReportingOutcome("two")
        XCTAssertEqual(outcome, .started(accepted: true), "the words go, and make the conversation")
        XCTAssertEqual(writes.requests.first?.conversationID, "conv-created")

        gate.open()
        _ = await withFiles.value
        let fileText = ComposerFile.messageText("one", paths: ["/host/uploads/\(file.id)/one.log"])
        let banked = chat.queuedSends.contains { $0.text == fileText && $0.conversationID == "conv-created" }
        let posted = writes.requests.contains { $0.text == fileText && $0.conversationID == "conv-created" }
        XCTAssertTrue(banked || posted, "the file send went to the conversation the words made")
        XCTAssertFalse(chat.messages.contains { $0.localFiles != nil }, "no send is left waiting for the new chat")
    }

    /// Another agent and back to this one's New chat: `select` is not asked for a
    /// new chat, and its file send still going up was out of sight until a relaunch.
    @MainActor
    func testBackOnAnAgentsNewChatItsFileSendIsThere() async throws {
        let other = "any-file-agent-" + UUID().uuidString.lowercased()
        let newKey = PendingFileSends.chatKey(conversationID: nil, agentID: ChatStore.mainAgentID)
        let madeKey = PendingFileSends.chatKey(conversationID: "conv-created", agentID: ChatStore.mainAgentID)
        let savedAgent = AppPrefs.defaults.string(forKey: ChatPlace.agentKey)
        let clear = { @MainActor in
            for key in [newKey, madeKey] {
                for e in PendingFileSends.entries(session: key) { PendingFileSends.remove(session: key, bubble: e.bubbleID) }
            }
            DiskCache.remove(key: "messages-conv-created")
            DiskCache.remove(key: "conversations-\(other)")
            DiskCache.remove(key: "asks-\(other)")
            AppPrefs.defaults.removeObject(forKey: ChatPlace.conversationKey(agentID: other))
            AppPrefs.defaults.removeObject(forKey: ChatPlace.newChatKey(agentID: other))
        }
        clear()
        let file = try tempFile(200, name: "one.log")
        let host = GatedUploadHost()
        let gate = CheckedContinuationGate()
        host.gates[file.id] = gate
        let writes = MockChatSendTransport()
        let chat = ChatStore(transport: MockChatMessagesTransport(), sendTransport: writes, uploads: host)
        addTeardownBlock { @MainActor in
            chat.eraseLocalState()
            clear()
            if let savedAgent {
                AppPrefs.defaults.set(savedAgent, forKey: ChatPlace.agentKey)
            } else {
                AppPrefs.defaults.removeObject(forKey: ChatPlace.agentKey)
            }
        }
        chat.select(nil)
        let withFiles = Task { await chat.sendWithFiles("one", files: [file]) }
        await waitUntil { host.order.contains(file.id) }
        let bubbleID = try XCTUnwrap(chat.messages.first { $0.localFiles != nil }?.id)

        chat.switchAgent(other)
        XCTAssertFalse(chat.messages.contains { $0.id == bubbleID }, "another agent does not show it")
        chat.switchAgent(ChatStore.mainAgentID)
        XCTAssertNil(chat.activeID, "back on the new chat")
        let back = try XCTUnwrap(chat.messages.first { $0.id == bubbleID }, "its new chat shows it again")
        XCTAssertEqual(back.pending, true, "still going up")

        gate.open()
        _ = await withFiles.value
        XCTAssertEqual(writes.requestedTexts.first,
                       ComposerFile.messageText("one", paths: ["/host/uploads/\(file.id)/one.log"]),
                       "it went from its new chat")
    }

    /// Two plain messages behind a session's file send: each waits on its own
    /// timer, and the later one could post first. Each POST here waits for its
    /// own gate, so a message that goes too early is seen.
    @MainActor
    func testMessagesBehindASessionFileSendGoInTheOrderTheyWereSent() async throws {
        let session = "any-file-order2-" + UUID().uuidString.lowercased()
        addTeardownBlock { @MainActor in
            for e in PendingFileSends.entries(session: session) { PendingFileSends.remove(session: session, bubble: e.bubbleID) }
        }
        let file = try tempFile(300, name: "trace.log")
        let host = GatedUploadHost()
        let gate = CheckedContinuationGate()
        host.gates[file.id] = gate
        let transport = MockSessionSendTransport()
        let firstPost = CheckedContinuationGate()
        transport.gate = firstPost
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await store.open()
        let withFiles = Task { await store.sendFromComposer("first", files: [file]) }
        await waitUntil { host.order.contains(file.id) }
        // Distinct bubble ids: the store names a bubble by the clock.
        try await Task.sleep(for: .milliseconds(20))
        let second = Task { await store.sendFromComposer("second") }
        try await Task.sleep(for: .milliseconds(20))
        let third = Task { await store.sendFromComposer("third") }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(transport.sendCallCount, 0)

        gate.open()
        await waitUntil { transport.sendCallCount == 1 }
        // The first POST has read its gate by now (it does so right after it is recorded).
        try await Task.sleep(for: .milliseconds(50))
        let secondPost = CheckedContinuationGate()
        transport.gate = secondPost
        firstPost.open()
        await waitUntil { transport.sendCallCount >= 2 }
        try await Task.sleep(for: .milliseconds(300))
        let fileText = ComposerFile.messageText("first", paths: ["/host/uploads/\(file.id)/trace.log"])
        XCTAssertEqual(transport.sendCalls.map(\.text), [fileText, "second"], "the third waits for the second")

        secondPost.open()
        _ = await withFiles.value
        _ = await second.value
        _ = await third.value
        XCTAssertEqual(transport.sendCalls.map(\.text), [fileText, "second", "third"])
        store.close()
    }

    /// Unpairing while a page waits on another page's attempt at the same send:
    /// the waiter gives up instead of starting the send again for the next server.
    @MainActor
    func testAPageWaitingOnAnotherPagesSendGivesUpWhenThePairingGoes() async throws {
        let session = "any-file-reset-" + UUID().uuidString.lowercased()
        addTeardownBlock { @MainActor in
            for e in PendingFileSends.entries(session: session) { PendingFileSends.remove(session: session, bubble: e.bubbleID) }
        }
        let file = try tempFile(SessionFileUploader.chunkBytes + 10, name: "clip.mov")
        let host = FakeUploadHost()
        let gate = CheckedContinuationGate()
        host.holdAt = (Int64(SessionFileUploader.chunkBytes), gate)
        let transport = MockSessionSendTransport()
        let store1 = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await store1.open()
        let sending = Task { await store1.sendFromComposer("the clip", files: [file]) }
        await waitUntil { host.calls.contains { $0.offset == Int64(SessionFileUploader.chunkBytes) } }
        store1.close()
        let store2 = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await store2.open()
        await waitUntil { store2.messages.contains { $0.pending == true } }
        // The new page's attempt now waits on the first page's.
        try await Task.sleep(for: .milliseconds(200))
        let callsBefore = host.calls.count

        FileSendFlights.forgetAll()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(host.calls.count, callsBefore, "the waiting page uploads nothing after the reset")
        XCTAssertTrue(transport.sendCalls.isEmpty, "and sends nothing")
        gate.open()
        _ = await sending.value
        store2.close()
    }

    /// The first message of a new session while its files go up lives in the
    /// page's state only: kept in the drafts store too, it comes back in the
    /// composer if iOS ended the app meanwhile, and is never in the box twice.
    @MainActor
    func testANewSessionLaunchsWordsSurviveTheAppBeingEnded() {
        let draftKey = "draft:any-file-launch-" + UUID().uuidString.lowercased()
        let launchKey = NewSessionLaunchWords.key(for: draftKey)
        let drafts = ComposerDrafts.shared
        addTeardownBlock { @MainActor in
            drafts.clear(draftKey)
            drafts.clear(launchKey)
        }
        NewSessionLaunchWords.keep("fix the flaky build", draftKey: draftKey)
        XCTAssertEqual(drafts.draft(launchKey), "fix the flaky build", "kept where the next run finds it")
        NewSessionLaunchWords.offerBack(draftKey: draftKey)
        XCTAssertEqual(drafts.draft(draftKey), "", "while this run's launch holds them, the box stays empty")
        NewSessionLaunchWords.release(draftKey: draftKey)
        XCTAssertEqual(drafts.draft(launchKey), "", "a launch that ended keeps nothing")

        // What a launch of an earlier run left: the app was ended mid-upload.
        drafts.setDraft("from before", key: launchKey)
        drafts.setDraft("typed since", key: draftKey)
        NewSessionLaunchWords.offerBack(draftKey: draftKey)
        XCTAssertEqual(drafts.draft(draftKey), "from before typed since", "back in the composer, first")
        XCTAssertEqual(drafts.draft(launchKey), "", "offered back once")
    }

    @MainActor
    func testSentFileSizesForgetTheOldServersFiles() async {
        let server = FakeFileStats()
        server.sizes = ["/h/up-1/a.log": 10]
        let sizes = SentFileSizes(transport: server)
        await sizes.request(["/h/up-1/a.log"], host: nil)
        XCTAssertEqual(sizes.size(of: "/h/up-1/a.log"), 10)
        sizes.removeAll()
        XCTAssertNil(sizes.size(of: "/h/up-1/a.log"))
        await sizes.request(["/h/up-1/a.log"], host: nil)
        XCTAssertEqual(server.asked.count, 2, "the next server is asked again")
    }

    // MARK: - The New Session composer (review: photos, per-file state)

    private func makeImage(_ color: UIColor = .systemTeal) -> SelectedImage {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        return SelectedImage(jpegData: image.jpegData(compressionQuality: 0.8)!)!
    }

    @MainActor
    func testANewSessionsPhotosGoAsPicturesAndItsFilesAsFiles() async throws {
        let file = try tempFile(300, name: "spec.pdf")
        let host = FakeUploadHost()
        let uploads = NewSessionUploads(transport: host)
        try await uploads.prepare(images: [makeImage()], files: [file])
        addTeardownBlock { @MainActor in uploads.finish() }
        let sent = try await uploads.upload()
        XCTAssertEqual(sent.imagePaths.count, 1)
        XCTAssertTrue(sent.imagePaths[0].hasSuffix(".jpg"))
        XCTAssertEqual(sent.filePaths, ["/host/uploads/\(file.id)/spec.pdf"])
        let text = ComposerFile.messageText("what is this?", imagePaths: sent.imagePaths, paths: sent.filePaths)
        XCTAssertTrue(text.hasPrefix(ComposerFile.imagesHeaderLine), "the picture lane's own header")
        let parts = try XCTUnwrap(MessageRow.attachmentSendParts(text))
        XCTAssertEqual(parts.imagePaths, sent.imagePaths, "drawn as a picture")
        XCTAssertEqual(parts.filePaths, sent.filePaths)
        XCTAssertEqual(parts.text, "what is this?")
        XCTAssertEqual(uploads.chips(failed: false).count, 1, "a card for the file only; the photo is a picture")
    }

    @MainActor
    func testANewSessionsPhotoKeepsItsUploadIDWhenSentAgain() async throws {
        let photo = makeImage(.systemOrange)
        let first = try await NewSessionUploads.photoCopy(photo.jpegData)
        let again = try await NewSessionUploads.photoCopy(photo.jpegData)
        addTeardownBlock { ComposerFileStore.remove(first) }
        XCTAssertEqual(first.id, again.id, "the host resumes or answers the same upload")
        XCTAssertNotEqual(first.name, "photo-1.jpg", "a name of its own on the host")
    }

    @MainActor
    func testANewSessionsFilesEachShowTheirOwnFailureAndARetryKeepsWhatIsUp() async throws {
        let good = try tempFile(200, name: "notes.txt")
        let bad = try tempFile(200, name: "huge.mov")
        let host = FakeUploadHost()
        host.failUploads[bad.id] = diskFull()
        let uploads = NewSessionUploads(transport: host)
        try await uploads.prepare(images: [], files: [good, bad])
        do {
            _ = try await uploads.upload()
            XCTFail("the second file's upload fails")
        } catch {}
        XCTAssertEqual(uploads.failedID, bad.id)
        let chips = uploads.chips(failed: true)
        XCTAssertEqual(chips.map(\.fileID), [good.id, bad.id])
        XCTAssertFalse(chips[0].offersActions, "the one on the host is not what failed")
        XCTAssertTrue(chips[0].detail.hasPrefix("Uploaded"))
        XCTAssertTrue(chips[1].offersActions, "Retry and Remove on the failed one")
        XCTAssertTrue(chips[1].detail.hasPrefix("Upload failed"))

        let goodCalls = host.calls.filter { $0.uploadID == good.id }.count
        uploads.remove(bad.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: bad.localURL.path))
        let sent = try await uploads.upload()
        XCTAssertEqual(sent.filePaths, ["/host/uploads/\(good.id)/notes.txt"])
        XCTAssertEqual(host.calls.filter { $0.uploadID == good.id }.count, goodCalls, "not sent twice")
        uploads.finish()
    }

    /// Leaving the page mid-upload: the upload stops, nothing more goes up, and
    /// the page's launch makes no session.
    @MainActor
    func testLeavingANewSessionMidUploadStopsIt() async throws {
        let first = try tempFile(200, name: "a.log")
        let second = try tempFile(200, name: "b.log")
        let host = GatedUploadHost()
        let gate = CheckedContinuationGate()
        host.gates[first.id] = gate
        let uploads = NewSessionUploads(transport: host)
        try await uploads.prepare(images: [], files: [first, second])
        let run = Task { try await uploads.upload() }
        await waitUntil { host.order.contains(first.id) }
        uploads.abandon()
        gate.open()
        do {
            _ = try await run.value
            XCTFail("an abandoned launch has no paths to send")
        } catch {}
        XCTAssertTrue(uploads.abandoned)
        XCTAssertNil(uploads.failedID, "left, not failed")
        XCTAssertFalse(host.order.contains(second.id), "nothing more went up")
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.localURL.path), "the copies stay for the draft")
    }

    @MainActor
    func testADraftOverTheFileLimitSaysSoInsteadOfSending() {
        XCTAssertNil(ComposerBar.overFileLimitNotice(ComposerFile.maxFiles))
        XCTAssertEqual(ComposerBar.overFileLimitNotice(ComposerFile.maxFiles + 2),
                       "A message can carry \(ComposerFile.maxFiles) files. Remove 2 to send it.")
    }

    // MARK: - Sent file cards (review: size, copy failure)

    @MainActor
    func testACopyFailureNoteIsTakenOffThePathAndKept() throws {
        let text = ComposerFile.headerLine + "\n- /mac/uploads/up-1/server (1).log (could not be copied to this host: "
            + "the host is offline)\n- /mac/uploads/up-2/spec.pdf\n\nread these"
        let parts = try XCTUnwrap(MessageRow.attachmentSendParts(text))
        XCTAssertEqual(parts.filePaths, ["/mac/uploads/up-1/server (1).log", "/mac/uploads/up-2/spec.pdf"])
        XCTAssertEqual(parts.copyFailures, ["/mac/uploads/up-1/server (1).log": "the host is offline"])
        XCTAssertEqual(parts.text, "read these")
        // A name with parentheses of its own and no note stays whole.
        XCTAssertEqual(ComposerFile.sentLine("/h/a (2).log").path, "/h/a (2).log")
        XCTAssertNil(ComposerFile.sentLine("/h/a (2).log").copyFailure)
    }

    @MainActor
    func testASentFilesCardShowsItsSizeOrWhyItIsNotThere() {
        let sent = TimelineFileChip.sent(path: "/h/up-1/spec.pdf")
        XCTAssertEqual(sent.shownDetail(size: nil), "PDF", "an unknown size stays hidden")
        XCTAssertEqual(sent.shownDetail(size: 1_200_000), "PDF · \(ComposerFile.sizeLabel(1_200_000))")
        let failed = TimelineFileChip.sent(path: "/h/up-1/spec.pdf", copyFailure: "the host is offline")
        XCTAssertEqual(failed.copyFailure, "the host is offline")
        XCTAssertEqual(failed.detail, "Not copied to the host: the host is offline")
        XCTAssertEqual(failed.shownDetail(size: 5), failed.detail, "a failed copy says why, not a size")
        XCTAssertEqual(failed.symbol, TimelineFileChip.failedSymbol)
        XCTAssertTrue(failed.spokenLabel.contains("not on the session's host"))
    }

    @MainActor
    func testSentFileSizesAreAskedForOnceAFewAtATime() async {
        let server = FakeFileStats()
        let paths = (1...10).map { "/h/up-\($0)/f\($0).log" }
        server.sizes = Dictionary(uniqueKeysWithValues: paths.dropLast().map { ($0, Int64(100)) })
        let sizes = SentFileSizes(transport: server)
        await sizes.request(paths, host: "devbox")
        XCTAssertEqual(server.asked.map(\.count), [SentFileSizes.perRequest, 2])
        XCTAssertEqual(server.hosts, ["devbox", "devbox"])
        XCTAssertEqual(sizes.size(of: paths[0]), 100)
        XCTAssertNil(sizes.size(of: paths[9]), "no size from the server: none shown")
        await sizes.request(paths, host: "devbox")
        XCTAssertEqual(server.asked.count, 2, "asked once per path")

        server.fails = true
        await sizes.request(["/h/up-x/x.log"], host: nil)
        server.fails = false
        await sizes.request(["/h/up-x/x.log"], host: nil)
        XCTAssertEqual(server.asked.last, ["/h/up-x/x.log"], "a request that failed is asked again")
    }

    @MainActor
    func testOnlyFilesThatReachedTheHostAreAskedForASize() {
        let sent = ChatMessage(id: "m1", role: "user", text: ComposerFile.messageText("hi", imagePaths: ["/h/p.jpg"], paths: [
            "/h/up-1/a.log", "/h/up-2/b.png", "/h/up-3/c.zip (could not be copied to this host: offline)",
        ]), createdAt: "", kind: nil)
        let reply = ChatMessage(id: "m2", role: "assistant", text: ComposerFile.messageText("", paths: ["/h/up-9/z.log"]),
                                createdAt: "", kind: nil)
        XCTAssertEqual(SentFileSizes.sentFilePaths(in: [sent, reply]), ["/h/up-1/a.log"])
    }

    // MARK: - Third review (the iOS UI gate)

    /// A card wraps a long name and a failure's whole reason instead of cutting them
    /// to one line, and its row is measured that tall.
    @MainActor
    func testALongNameAndAFailureReasonWrapAndTheRowGrows() {
        let short = TimelineFileChip.sent(path: "/h/up-1/a.log")
        let long = TimelineFileChip.sent(path: "/h/up-1/deployment-rollout-2026-11-07-us-west-2-canary-stage-6.log")
        let failed = TimelineFileChip.sent(path: "/h/up-1/a.log",
                                           copyFailure: "the host has no room left on its disk for this file, free some space and send it again")
        XCTAssertGreaterThan(long.height(rowWidth: 390), short.height(rowWidth: 390))
        XCTAssertGreaterThan(failed.height(rowWidth: 390), short.height(rowWidth: 390))
        let width = TimelineFileChip.textWidth(rowWidth: 390, actions: false)
        XCTAssertGreaterThan(TimelineFileChip.lines(failed.detail, font: TimelineTextStyler.captionFont,
                                                    width: width, max: TimelineFileChip.detailLines), 1)
        XCTAssertEqual(TimelineFileChip.lines("x", font: TimelineTextStyler.captionFont, width: width, max: 5), 1)
        XCTAssertGreaterThan(failed.detailLimit, short.detailLimit, "a failure's reason is never cut at five lines")
    }

    /// The not-sent line is one 24 pt line at the usual size, and a longer notice
    /// gets the rows it wraps to instead of being cut.
    @MainActor
    func testTheNotSentLineIsMeasuredToItsWords() {
        XCTAssertEqual(TimelineMetrics.failedNoticeRowHeight(nil, width: 390), TimelineMetrics.failedNoticeHeight)
        let long = String(repeating: "The session's host is not reachable right now, retrying. ", count: 4)
        XCTAssertGreaterThan(TimelineMetrics.failedNoticeRowHeight(long, width: 390), TimelineMetrics.failedNoticeHeight)
    }

    /// A file whose upload ended the attempt is drawn failed, not like the others.
    @MainActor
    func testTheFileWhoseUploadFailedIsDrawnFailed() throws {
        let file = try tempFile(1000, name: "trace.log")
        XCTAssertTrue(TimelineFileChip.local(file, held: 400, pending: false, failed: true, failedHere: true).isFailed)
        XCTAssertFalse(TimelineFileChip.local(file, held: nil, pending: false, failed: true).isFailed,
                       "a file of the send that did not fail itself is not drawn failed")
        XCTAssertFalse(TimelineFileChip.local(file, held: 400, pending: true, failed: false).isFailed)
        XCTAssertTrue(TimelineFileChip.sent(path: "/h/a.log", copyFailure: "offline").isFailed)
        XCTAssertGreaterThanOrEqual(TimelineFileChip.actionSide, 44, "Retry and Remove keep a 44 pt tap area")
    }

    /// Any other file is named by its extension; an odd one is a plain "File".
    @MainActor
    func testAnyOtherFileIsNamedByItsExtension() {
        XCTAssertEqual(TimelineFileChip.kindLabel(.other, name: "server.log"), "LOG")
        XCTAssertEqual(TimelineFileChip.kindLabel(.other, name: "bundle.zip"), "ZIP")
        XCTAssertEqual(TimelineFileChip.kindLabel(.other, name: "README"), "File")
        XCTAssertEqual(TimelineFileChip.kindLabel(.other, name: "x.verylongext"), "File")
        XCTAssertEqual(TimelineFileChip.kindLabel(.pdf, name: "a.pdf"), "PDF")
        XCTAssertEqual(TimelineFileChip.sent(path: "/h/up-1/run.har").detail, "HAR")
    }

    /// A session send that failed for good comes back after the page (or the app)
    /// opens again as not sent, waiting for Retry: it never goes out by itself.
    @MainActor
    func testAFailedSessionFileSendComesBackNotSentAndWaitsForRetry() async throws {
        let session = "any-file-failed-kept-" + UUID().uuidString.lowercased()
        addTeardownBlock { @MainActor in
            for e in PendingFileSends.entries(session: session) { PendingFileSends.remove(session: session, bubble: e.bubbleID) }
        }
        let bad = try tempFile(200, name: "huge.mov")
        let host = FakeUploadHost()
        host.failUploads[bad.id] = APIError.server(status: 507, code: "host_disk_full", message: "full",
                                                   serverHash: nil, serverContent: nil)
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await store.open()
        _ = await store.sendFromComposer("look", files: [bad])
        XCTAssertNotNil(store.messages.first { $0.failed == true })
        await waitUntil { PendingFileSends.entries(session: session).first?.failed == true }
        XCTAssertEqual(PendingFileSends.entries(session: session).first?.failed, true)
        store.close()

        let uploadsBefore = host.calls.count
        let again = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await again.open()
        try? await Task.sleep(for: .milliseconds(300))
        let back = try XCTUnwrap(again.messages.first { $0.text == "look" })
        XCTAssertEqual(back.failed, true, "it comes back not sent")
        XCTAssertEqual(back.uploadFailedID, bad.id, "the file that failed is drawn failed again")
        XCTAssertNotEqual(back.pending, true)
        XCTAssertEqual(host.calls.count, uploadsBefore, "no upload starts by itself")
        XCTAssertTrue(transport.sendCalls.isEmpty, "nothing is sent by itself")
        again.close()
    }
}

/// An uploads host that keeps each upload apart and can hold one until its
/// gate opens, so two uploads can be in flight at once.
final class GatedUploadHost: SessionUploadTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var held: [String: Int64] = [:]
    private var calls: [String] = []
    var gates: [String: CheckedContinuationGate] = [:]
    /// Every chunk of these uploads is answered with the error, after its gate.
    var failures: [String: Error] = [:]

    /// Upload ids, one per chunk asked for, in order.
    var order: [String] { lock.withLock { calls } }

    func uploadChunk(target: UploadTarget, uploadID: String, name: String, size: Int64,
                     offset: Int64, sha256: String?, data: Data) async throws -> UploadChunkOutcome {
        let gate = lock.withLock { () -> CheckedContinuationGate? in
            calls.append(uploadID)
            return gates[uploadID]
        }
        if let gate { await gate.wait() }
        try Task.checkCancellation()
        if let failure = lock.withLock({ failures[uploadID] }) { throw failure }
        let now = lock.withLock { () -> Int64 in
            let value = max(held[uploadID] ?? 0, offset + Int64(data.count))
            held[uploadID] = value
            return value
        }
        let done = now >= size
        return .reply(UploadChunkReply(received: now, size: size, done: done,
                                       path: done ? "/host/uploads/\(uploadID)/\(name)" : nil))
    }
}

/// `POST /api/files/exists` standing in: the sizes it knows, and what it was asked.
final class FakeFileStats: FileStatTransport, @unchecked Sendable {
    var sizes: [String: Int64] = [:]
    var fails = false
    private(set) var asked: [[String]] = []
    private(set) var hosts: [String?] = []

    func fileStats(paths: [String], host: String?) async throws -> FileStats {
        asked.append(paths)
        hosts.append(host)
        if fails { throw APIError.network(underlying: URLError(.timedOut)) }
        return FileStats(exists: nil, sizes: sizes.filter { paths.contains($0.key) })
    }
}
