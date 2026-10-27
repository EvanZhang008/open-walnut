import XCTest
@testable import Walnut

/// Attaching files (a video, a PDF) to a session message: the name rule the
/// server checks, the message text the session receives and the phone reads
/// back, the chunked upload's resume rules, and the store's send of a bubble
/// with files (upload first, then the message naming the paths, retry resumes).
final class SessionFileUploadTests: XCTestCase {

    // MARK: - Names and text

    func testSafeNameKeepsNamesTheServerTakesAndFixesTheRest() {
        XCTAssertEqual(ComposerFile.safeName("IMG_0042.MOV"), "IMG_0042.MOV")
        XCTAssertEqual(ComposerFile.safeName("Q3 report (final).pdf"), "Q3 report (final).pdf")
        XCTAssertEqual(ComposerFile.safeName("../../etc/passwd"), "_.._etc_passwd")
        XCTAssertEqual(ComposerFile.safeName(".env"), "env")
        XCTAssertEqual(ComposerFile.safeName("  spaced.txt  "), "spaced.txt")
        XCTAssertEqual(ComposerFile.safeName("line\nbreak.txt"), "line_break.txt")
        XCTAssertEqual(ComposerFile.safeName("a\\b.txt"), "a_b.txt")
        XCTAssertEqual(ComposerFile.safeName("x.walnut-part"), "x.walnut-part_")
        XCTAssertEqual(ComposerFile.safeName(""), "file")
        XCTAssertEqual(ComposerFile.safeName("..."), "file")
        // A byte-order mark: JavaScript's trim (the server's check) removes it, so must we.
        XCTAssertEqual(ComposerFile.safeName("\u{FEFF}notes.txt"), "notes.txt")
        XCTAssertEqual(ComposerFile.safeName("notes.txt\u{FEFF}\u{3000}"), "notes.txt")
        // Non-ASCII test data, escaped: a CJK name stays as it is.
        XCTAssertEqual(ComposerFile.safeName("\u{4f1a}\u{8bae}.m4a"), "\u{4f1a}\u{8bae}.m4a")
        let long = String(repeating: "\u{89c6}", count: 120) + ".mov"
        let cut = ComposerFile.safeName(long)
        XCTAssertLessThanOrEqual(cut.utf8.count, 200)
        XCTAssertTrue(cut.hasSuffix(".mov"), "a long name keeps its extension")
    }

    func testKindFollowsTheType() {
        XCTAssertEqual(ComposerFile.kind(for: nil, name: "clip.mov"), .video)
        XCTAssertEqual(ComposerFile.kind(for: nil, name: "clip.mp4"), .video)
        XCTAssertEqual(ComposerFile.kind(for: nil, name: "r.pdf"), .pdf)
        XCTAssertEqual(ComposerFile.kind(for: nil, name: "a.png"), .image)
        XCTAssertEqual(ComposerFile.kind(for: nil, name: "notes.zip"), .other)
    }

    func testMessageTextIsTheServersFormatAndReadsBack() {
        let text = ComposerFile.messageText("what happens at 0:12?", paths: [
            "/home/u/tasks/t1/uploads/up-1/clip.mov", "/home/u/tasks/t1/uploads/up-2/My Report.pdf",
        ])
        XCTAssertEqual(text, "[Files attached \u{2014} open them from these paths]\n"
            + "- /home/u/tasks/t1/uploads/up-1/clip.mov\n- /home/u/tasks/t1/uploads/up-2/My Report.pdf\n\n"
            + "what happens at 0:12?")
        let parts = MessageRow.attachmentSendParts(text)
        XCTAssertEqual(parts?.filePaths, ["/home/u/tasks/t1/uploads/up-1/clip.mov", "/home/u/tasks/t1/uploads/up-2/My Report.pdf"])
        XCTAssertEqual(parts?.imagePaths, [])
        XCTAssertEqual(parts?.text, "what happens at 0:12?")
        XCTAssertEqual(ComposerFile.messageText("plain", paths: []), "plain")
    }

    func testPhotosAndFilesInOneMessageReadBackTogether() {
        // The server puts the photo header in front of the phone's files header.
        let text = "[Images attached \u{2014} use the Read tool to view them]\n- /tmp/open-walnut/images/1-a.jpg\n\n"
            + ComposerFile.messageText("both", paths: ["/h/up-1/clip.mov"])
        let parts = MessageRow.attachmentSendParts(text)
        XCTAssertEqual(parts?.imagePaths, ["/tmp/open-walnut/images/1-a.jpg"])
        XCTAssertEqual(parts?.filePaths, ["/h/up-1/clip.mov"])
        XCTAssertEqual(parts?.text, "both")
        // Files only, no words.
        XCTAssertEqual(MessageRow.attachmentSendParts(ComposerFile.messageText("", paths: ["/h/a.pdf"]))?.text, "")
        // Not the format: nothing parsed.
        XCTAssertNil(MessageRow.attachmentSendParts("[Files attached \u{2014} x]\nnot a path\n\nhi"))
        XCTAssertNil(MessageRow.attachmentSendParts("just words"))
    }

    func testTimelineDrawsSentFilesAsCardsAndPicturesAsImages() {
        let builder = TimelineRowBuilder()
        let message = ChatMessage(
            id: "u1", role: "user",
            text: ComposerFile.messageText("look", paths: ["/h/up-1/clip.mov", "/h/up-2/shot.png"]),
            createdAt: "2026-10-27T00:00:00Z", kind: nil)
        let rows = builder.rows(for: message, width: 390, expandedRowIDs: [])
        let kinds = rows.map(\.content.reuseKind)
        XCTAssertEqual(kinds, ["image", "fileAttachment", "bubble"])
        // The user's own picture sits on their side, like their bubble.
        guard case .image(_, _, _, let mine) = rows[0].content else { return XCTFail("no picture") }
        XCTAssertTrue(mine)
        guard case .fileAttachment(let chip) = rows[1].content else { return XCTFail("no file card") }
        XCTAssertEqual(chip.name, "clip.mov")
        XCTAssertEqual(chip.path, "/h/up-1/clip.mov")
        XCTAssertEqual(chip.detail, "Video")
    }

    // MARK: - The uploader

    /// A picked file the way the app keeps one: its own folder under the store's root.
    private func tempFile(_ bytes: Int, name: String = "clip.mov") throws -> ComposerFile {
        let id = "up-" + UUID().uuidString.lowercased()
        let dir = ComposerFileStore.root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent(name)
        var data = Data(count: bytes)
        for i in 0..<bytes { data[i] = UInt8(i % 251) }
        try data.write(to: url)
        return ComposerFile(id: id, name: name, size: Int64(bytes),
                            sha256: try ComposerFileStore.sha256(of: url), kind: .video, localURL: url)
    }

    func testUploadSendsChunksInOrderAndTheLastCarriesTheChecksum() async throws {
        let file = try tempFile(SessionFileUploader.chunkBytes * 2 + 1000)
        let host = FakeUploadHost()
        var progress: [Int64] = []
        let path = try await SessionFileUploader.upload(file, sessionID: "s1", transport: host, pauseBetweenTries: .zero) {
            progress.append($0)
        }
        XCTAssertEqual(path, "/host/uploads/\(file.id)/clip.mov")
        XCTAssertEqual(host.calls.map(\.offset), [0, Int64(SessionFileUploader.chunkBytes), Int64(SessionFileUploader.chunkBytes * 2)])
        XCTAssertEqual(host.calls.map { $0.sha256 != nil }, [false, false, true])
        XCTAssertEqual(host.calls.last?.sha256, file.sha256)
        XCTAssertEqual(host.stored, try Data(contentsOf: file.localURL))
        XCTAssertEqual(progress.last, file.size)
    }

    func testUploadResumesWhereTheHostIsAndRidesOutAShortOutage() async throws {
        let file = try tempFile(SessionFileUploader.chunkBytes * 3)
        let host = FakeUploadHost()
        // The host already holds the first chunk from an earlier run.
        host.stored = try Data(contentsOf: file.localURL).prefix(SessionFileUploader.chunkBytes)
        host.failNext = [APIError.network(underlying: URLError(.networkConnectionLost))]
        // Start claims 2 chunks: the host answers it holds 1, the upload goes from there.
        let path = try await SessionFileUploader.upload(
            file, sessionID: "s1", transport: host, from: Int64(SessionFileUploader.chunkBytes * 2), pauseBetweenTries: .zero
        ) { _ in }
        XCTAssertFalse(path.isEmpty)
        XCTAssertEqual(host.stored, try Data(contentsOf: file.localURL))
        XCTAssertEqual(host.calls.first?.offset, Int64(SessionFileUploader.chunkBytes * 2), "the first try is where the bubble left off")
        XCTAssertTrue(host.calls.dropFirst().contains { $0.offset == Int64(SessionFileUploader.chunkBytes) }, "then from what the host holds")
    }

    func testAChecksumMismatchStartsOverOnceThenGivesUp() async throws {
        let file = try tempFile(1000, name: "r.pdf")
        let once = FakeUploadHost()
        once.restartsLeft = 1
        _ = try await SessionFileUploader.upload(file, sessionID: "s1", transport: once, pauseBetweenTries: .zero) { _ in }
        XCTAssertEqual(once.calls.map(\.offset), [0, 0])

        let always = FakeUploadHost()
        always.restartsLeft = 5
        do {
            _ = try await SessionFileUploader.upload(file, sessionID: "s1", transport: always, pauseBetweenTries: .zero) { _ in }
            XCTFail("a second mismatch must stop")
        } catch SessionFileUploader.UploadError.checksumMismatch {}
    }

    func testAnEmptyFileIsOneEmptyChunk() async throws {
        let file = try tempFile(0, name: "empty.txt")
        let host = FakeUploadHost()
        let path = try await SessionFileUploader.upload(file, sessionID: "s1", transport: host, pauseBetweenTries: .zero) { _ in }
        XCTAssertEqual(host.calls.count, 1)
        XCTAssertEqual(host.calls.first?.length, 0)
        XCTAssertNotNil(host.calls.first?.sha256)
        XCTAssertTrue(path.hasSuffix("/empty.txt"))
    }

    func testAPermanentRefusalIsThrownAtOnce() async throws {
        let file = try tempFile(10, name: "a.bin")
        let host = FakeUploadHost()
        host.failNext = Array(repeating: APIError.server(status: 400, code: "files_need_daemon_upgrade", message: "old",
                                                         serverHash: nil, serverContent: nil), count: 5)
        do {
            _ = try await SessionFileUploader.upload(file, sessionID: "s1", transport: host, pauseBetweenTries: .zero) { _ in }
            XCTFail("expected the refusal")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "files_need_daemon_upgrade")
        }
        XCTAssertEqual(host.calls.count, 1, "a refusal is not retried")
    }

    func testAnOlderServerWithoutTheRouteSaysSoAtOnce() async throws {
        let file = try tempFile(10, name: "a.pdf")
        let host = FakeUploadHost()
        // An older server's own 404: `{"error":"Not found: PUT ..."}`, read as http_error.
        host.failNext = [APIError.server(status: 404, code: "http_error", message: "Not found", serverHash: nil, serverContent: nil)]
        do {
            _ = try await SessionFileUploader.upload(file, sessionID: "s1", transport: host, pauseBetweenTries: .zero) { _ in }
            XCTFail("expected the refusal")
        } catch SessionFileUploader.UploadError.serverTooOld {}
        XCTAssertEqual(host.calls.count, 1)
        // The route's own 404 (the session is gone) is not "too old".
        XCTAssertFalse(SessionFileUploader.isMissingRoute(
            APIError.server(status: 404, code: "not_found", message: "Session not found: s1", serverHash: nil, serverContent: nil)))
    }

    func testResumeOffsetReadsOnlyTheOffsetMismatchBody() {
        let body = Data(#"{"error":{"code":"upload_offset_mismatch","message":"x","received":4096}}"#.utf8)
        XCTAssertEqual(WalnutAPI.resumeOffset(body), 4096)
        XCTAssertNil(WalnutAPI.resumeOffset(Data(#"{"error":{"code":"stop_pending","message":"x"}}"#.utf8)))
    }

    // MARK: - The store

    @MainActor
    func testASendWithFilesUploadsThemThenNamesThePathsInTheMessage() async throws {
        let file = try tempFile(5000)
        let transport = MockSessionSendTransport()
        let host = FakeUploadHost()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "files-send"), transport: transport, uploads: host)
        await store.open()
        let kept = await store.sendFromComposer("what is in this clip?", files: [file])
        XCTAssertTrue(kept)
        XCTAssertEqual(transport.sendCalls.count, 1)
        XCTAssertEqual(transport.sendCalls.first?.text,
                       ComposerFile.messageText("what is in this clip?", paths: ["/host/uploads/\(file.id)/clip.mov"]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.localURL.path),
                       "an accepted message's local copy is removed")
        store.close()
    }

    @MainActor
    func testAFailedUploadLeavesARetryableBubbleThatResumes() async throws {
        let file = try tempFile(SessionFileUploader.chunkBytes + 10)
        let transport = MockSessionSendTransport()
        let host = FakeUploadHost()
        // The second chunk is refused for a reason no ladder fixes.
        host.failAtOffset[Int64(SessionFileUploader.chunkBytes)] = APIError.server(
            status: 507, code: "host_disk_full", message: "The session's host does not have room for this file.",
            serverHash: nil, serverContent: nil)
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "files-retry"), transport: transport, uploads: host)
        await store.open()
        _ = await store.sendFromComposer("", files: [file])
        XCTAssertEqual(transport.sendCalls.count, 0, "no message before its files are on the host")
        guard let failed = store.messages.last(where: { $0.failed == true }) else { return XCTFail("no failed bubble") }
        XCTAssertEqual(failed.localFiles?.first?.id, file.id)
        XCTAssertEqual(failed.uploadHeld?[file.id], Int64(SessionFileUploader.chunkBytes), "the bubble knows how far it got")
        XCTAssertEqual(store.errorMessage, "The session's host does not have room for this file.")

        host.failAtOffset = [:]
        let firstChunkCalls = host.calls.filter { $0.offset == 0 }.count
        await store.retry(failed)
        XCTAssertEqual(host.calls.filter { $0.offset == 0 }.count, firstChunkCalls, "a retry never re-sends what the host holds")
        XCTAssertEqual(transport.sendCalls.count, 1)
        XCTAssertTrue(transport.sendCalls[0].text.hasPrefix(ComposerFile.headerLine))
        store.close()
    }

    @MainActor
    func testASendTheAppWasEndedInIsPutBackAndSentWhenThePageOpensAgain() async throws {
        let session = "files-killed-" + UUID().uuidString.lowercased()
        let file = try tempFile(SessionFileUploader.chunkBytes + 10)
        addTeardownBlock { for e in PendingFileSends.entries(session: session) { PendingFileSends.remove(session: session, bubble: e.bubbleID) } }
        // First run: the host stops answering after the first chunk, and the app is
        // then ended (the store simply goes away without a word).
        let first = FakeUploadHost()
        first.failAtOffset[Int64(SessionFileUploader.chunkBytes)] = APIError.server(
            status: 507, code: "host_disk_full", message: "full", serverHash: nil, serverContent: nil)
        let transport1 = MockSessionSendTransport()
        let store1 = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport1, uploads: first)
        await store1.open()
        _ = await store1.sendFromComposer("the clip", files: [file])
        XCTAssertEqual(transport1.sendCalls.count, 0)
        let kept = PendingFileSends.entries(session: session)
        XCTAssertEqual(kept.count, 1, "the send is on disk while its files upload")
        XCTAssertEqual(kept.first?.files.map(\.id), [file.id])
        store1.close()

        // Next run: the page opens, the send is back on screen and goes, resuming.
        let second = FakeUploadHost()
        second.stored = first.stored
        let transport2 = MockSessionSendTransport()
        let store2 = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport2, uploads: second)
        await store2.open()
        for _ in 0..<100 where transport2.sendCalls.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(transport2.sendCalls.count, 1)
        XCTAssertEqual(transport2.sendCalls.first?.text,
                       ComposerFile.messageText("the clip", paths: ["/host/uploads/\(file.id)/clip.mov"]))
        XCTAssertEqual(transport2.sendCalls.first?.messageId, kept.first?.messageID, "the same message id, so the server takes it once")
        XCTAssertFalse(second.calls.contains { $0.offset == 0 }, "the upload resumed instead of starting over")
        // The POST's answer is handled after the mock records the call.
        await waitUntil { store2.messages.allSatisfy { $0.pending != true } }
        XCTAssertTrue(PendingFileSends.entries(session: session).isEmpty, "an accepted send is no longer kept")
        store2.close()
    }

    private func keep(_ file: ComposerFile, session: String, text: String) -> PendingFileSends.Entry {
        let entry = PendingFileSends.Entry(
            bubbleID: "pending-kept-" + UUID().uuidString.lowercased(), messageID: SendRetryPolicy.newMessageId(),
            sessionID: session, text: text, createdAt: "2026-10-27T08:00:00Z", voice: false,
            files: [PendingFileSends.ref(file)], held: [:], imageCount: 0, savedAt: Date())
        PendingFileSends.save(entry, images: [])
        addTeardownBlock { PendingFileSends.remove(session: session, bubble: entry.bubbleID) }
        return entry
    }

    private func transcript(_ texts: [String]) -> SessionTranscript {
        SessionTranscript(sessionId: "kept", exportedAt: "2026-10-27T08:10:00Z", truncated: false,
                          messages: texts.enumerated().map { i, text in
                              SessionTranscript.Message(role: "user", text: text,
                                                        timestamp: String(format: "2026-10-27T08:%02d:00Z", i), kind: nil)
                          })
    }

    @MainActor
    private func waitUntil(_ timeout: Double = 3, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, !condition() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    /// Leaving the page mid-upload and opening it again builds a second store
    /// while the first still sends: the files go up once and the message once.
    @MainActor
    func testLeavingAndOpeningThePageMidUploadSendsOnce() async throws {
        let session = "files-reenter-" + UUID().uuidString.lowercased()
        let file = try tempFile(SessionFileUploader.chunkBytes + 10)
        addTeardownBlock { for e in PendingFileSends.entries(session: session) { PendingFileSends.remove(session: session, bubble: e.bubbleID) } }
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
        XCTAssertEqual(store2.messages.filter { $0.pending == true }.count, 1, "the send is on the new page, still going")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(host.calls.filter { $0.offset == 0 }.count, 1, "the new page did not start the upload again")
        gate.open()
        _ = await sending.value
        await waitUntil { store2.messages.allSatisfy { $0.pending != true } }
        XCTAssertEqual(transport.sendCalls.count, 1, "one message")
        XCTAssertEqual(host.calls.filter { $0.offset == 0 }.count, 1, "one upload")
        XCTAssertTrue(store2.messages.allSatisfy { $0.pending != true && $0.failed != true })
        XCTAssertTrue(PendingFileSends.entries(session: session).isEmpty)
        store2.close()
    }

    /// The server took the message before the app ended: its row is in the
    /// transcript, so the kept copy is not sent again.
    @MainActor
    func testAKeptSendTheServerAlreadyHasIsNotSentAgain() async throws {
        let session = "files-taken-" + UUID().uuidString.lowercased()
        let file = try tempFile(100)
        _ = keep(file, session: session, text: "the clip")
        let transport = MockSessionSendTransport()
        transport.transcript = transcript([ComposerFile.messageText("the clip", paths: ["/host/uploads/\(file.id)/clip.mov"])])
        let host = FakeUploadHost()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await store.open()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(transport.sendCalls.count, 0)
        XCTAssertTrue(host.calls.isEmpty)
        XCTAssertTrue(PendingFileSends.entries(session: session).isEmpty, "the kept copy is let go")
        XCTAssertFalse(store.messages.contains { $0.pending == true || $0.failed == true })
        store.close()
    }

    /// The look-up read fails every time: the put-back send is not sent on a
    /// guess; it is shown as not sent for the person to decide.
    @MainActor
    func testAKeptSendThatCannotBeCheckedIsLeftForThePerson() async throws {
        let session = "files-unchecked-" + UUID().uuidString.lowercased()
        let file = try tempFile(100)
        _ = keep(file, session: session, text: "the clip")
        let pause = SessionConversationStore.restoredCheckPause
        SessionConversationStore.restoredCheckPause = 0
        defer { SessionConversationStore.restoredCheckPause = pause }
        let transport = MockSessionSendTransport()
        transport.pageError = APIError.server(status: 503, code: "page_unavailable", message: "x", serverHash: nil, serverContent: nil)
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: FakeUploadHost())
        await store.open()
        XCTAssertEqual(transport.sendCalls.count, 0)
        XCTAssertEqual(store.messages.filter { $0.failed == true }.count, 1, "shown as not sent")
        XCTAssertEqual(PendingFileSends.entries(session: session).count, 1, "still kept")
        store.close()
    }

    /// The look-up reaches back to before the send's own time, and an answer
    /// that does not reach that far proves nothing.
    @MainActor
    func testTheLookUpReachesBackToTheSendAndAShortAnswerProvesNothing() async throws {
        let session = "files-short-" + UUID().uuidString.lowercased()
        let file = try tempFile(100)
        let entry = keep(file, session: session, text: "the clip")
        let transport = MockSessionSendTransport()
        // A tail that starts after the send: the send's row could be above it.
        transport.transcript = SessionTranscript(
            sessionId: "kept", exportedAt: "2026-10-27T09:00:00Z", truncated: true,
            messages: [SessionTranscript.Message(role: "user", text: "later", timestamp: "2026-10-27T08:59:00Z", kind: nil)])
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: FakeUploadHost())
        await store.open()
        let created = ISO8601DateFormatter().date(from: entry.createdAt)!
        XCTAssertTrue(transport.pageReads.contains { read in
            read.since.flatMap { ISO8601DateFormatter().date(from: $0) }.map { $0 <= created } ?? false
        }, "asked for the rows since before the send")
        XCTAssertEqual(transport.sendCalls.count, 0)
        XCTAssertEqual(store.messages.filter { $0.failed == true }.count, 1)
        store.close()
    }

    /// The page left behind is opened again after the new page's send of the
    /// same message was taken: its waiting copy is delivered, not "file gone".
    @MainActor
    func testThePageLeftBehindSeesTheSendTheOtherPageDelivered() async throws {
        let session = "files-back-" + UUID().uuidString.lowercased()
        let file = try tempFile(SessionFileUploader.chunkBytes + 10)
        addTeardownBlock { for e in PendingFileSends.entries(session: session) { PendingFileSends.remove(session: session, bubble: e.bubbleID) } }
        let host = FakeUploadHost()
        host.failAtOffset[Int64(SessionFileUploader.chunkBytes)] = APIError.server(
            status: 507, code: "host_disk_full", message: "full", serverHash: nil, serverContent: nil)
        let transport = MockSessionSendTransport()
        let store1 = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await store1.open()
        _ = await store1.sendFromComposer("the clip", files: [file])
        guard let failed = store1.messages.first(where: { $0.failed == true }) else { return XCTFail("no failed bubble") }
        store1.close()

        host.failAtOffset = [:]
        let store2 = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: host)
        await store2.open()
        await waitUntil { transport.sendCalls.count == 1 }
        store2.close()

        await store1.open()
        await store1.retry(failed)
        XCTAssertEqual(transport.sendCalls.count, 1, "not sent a second time")
        XCTAssertNil(store1.errorMessage)
        XCTAssertFalse(store1.messages.contains { $0.failed == true }, "the old page's copy is delivered, not failed")
        store1.close()
    }

    /// An older send of the same words with other files is another send: the
    /// kept one still goes.
    @MainActor
    func testAnOlderSendOfTheSameWordsDoesNotTakeAKeptOne() async throws {
        let session = "files-same-words-" + UUID().uuidString.lowercased()
        let file = try tempFile(100)
        _ = keep(file, session: session, text: "the clip")
        let transport = MockSessionSendTransport()
        transport.transcript = transcript([ComposerFile.messageText("the clip", paths: ["/host/uploads/up-older/clip.mov"])])
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: FakeUploadHost())
        await store.open()
        await waitUntil { transport.sendCalls.count == 1 }
        XCTAssertEqual(transport.sendCalls.first?.text,
                       ComposerFile.messageText("the clip", paths: ["/host/uploads/\(file.id)/clip.mov"]))
        store.close()
    }

    /// A kept send whose file copy is gone keeps its words on disk and on screen,
    /// and a retry says which file is missing instead of sending without it.
    @MainActor
    func testAKeptSendWhoseFileIsGoneKeepsItsWordsAndSaysSo() async throws {
        let session = "files-gone-" + UUID().uuidString.lowercased()
        let file = try tempFile(100, name: "notes.pdf")
        try FileManager.default.removeItem(at: file.localURL)
        _ = keep(file, session: session, text: "read this")
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: FakeUploadHost())
        await store.open()
        guard let failed = store.messages.first(where: { $0.failed == true }) else { return XCTFail("no failed bubble") }
        XCTAssertEqual(failed.text, "read this")
        XCTAssertEqual(failed.localFiles?.map(\.name), ["notes.pdf"], "the missing file is still shown")
        await store.retry(failed)
        XCTAssertEqual(transport.sendCalls.count, 0, "never sent without its file")
        XCTAssertEqual(store.errorMessage, "notes.pdf is no longer on this phone. Delete this message, then attach the file again.")
        XCTAssertEqual(PendingFileSends.entries(session: session).count, 1, "the words stay kept")
        store.close()
    }

    /// One damaged record costs only itself, and one from a build that wrote
    /// fewer fields still comes back.
    func testAKeptRecordThatDoesNotDecodeCostsOnlyItself() throws {
        let session = "files-lenient-" + UUID().uuidString.lowercased()
        let url = PendingFileSends.dir.appendingPathComponent(session + ".json")
        try FileManager.default.createDirectory(at: PendingFileSends.dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        let json = #"""
        [{"bubbleID":"b1","sessionID":"S","text":"hi","files":[{"id":"up-a","name":"a.pdf","size":3,"sha256":"x","kind":"pdf"}],"imageCount":999},
         {"bubbleID":"b2","text":"no session"}]
        """#.replacingOccurrences(of: "\"S\"", with: "\"\(session)\"")
        try Data(json.utf8).write(to: url)
        let list = PendingFileSends.entries(session: session)
        XCTAssertEqual(list.map(\.bubbleID), ["b1"])
        XCTAssertEqual(list.first?.imageCount, PendingFileSends.maxImages, "a count past any message's is clamped")
        XCTAssertEqual(list.first?.held, [:])
        XCTAssertNil(list.first?.messageID)
    }
}

/// A session host for the uploader: holds the bytes it was sent at the offsets
/// the real `upload.part` accepts, and answers like the route does.
final class FakeUploadHost: SessionUploadTransport, @unchecked Sendable {
    struct Call { let offset: Int64; let length: Int; let sha256: String? }
    private(set) var calls: [Call] = []
    var stored = Data()
    var failNext: [Error] = []
    var failAtOffset: [Int64: Error] = [:]
    var restartsLeft = 0
    /// Holds the chunk at this offset until the gate opens.
    var holdAt: (Int64, CheckedContinuationGate)?

    func uploadChunk(sessionID: String, uploadID: String, name: String, size: Int64,
                     offset: Int64, sha256: String?, data: Data) async throws -> UploadChunkOutcome {
        calls.append(Call(offset: offset, length: data.count, sha256: sha256))
        if let (at, gate) = holdAt, at == offset { await gate.wait() }
        if !failNext.isEmpty { throw failNext.removeFirst() }
        if let error = failAtOffset[offset] { throw error }
        if offset == 0 { stored = Data() }
        let have = Int64(stored.count)
        if offset > have { return .resumeAt(have) }
        if offset + Int64(data.count) > have {
            stored = stored.prefix(Int(offset)) + data
        }
        let held = Int64(stored.count)
        if held == size {
            if restartsLeft > 0 { restartsLeft -= 1; stored = Data(); return .restart }
            return .reply(UploadChunkReply(received: held, size: size, done: true, path: "/host/uploads/\(uploadID)/\(name)"))
        }
        return .reply(UploadChunkReply(received: held, size: size, done: false, path: nil))
    }
}
