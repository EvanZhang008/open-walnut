import UIKit
import XCTest
@testable import Walnut

/// The queue tray lists only what the person sent and still waits, says how far each
/// line got, and never prints an attachment header; a sent bubble gives way to its own
/// transcript row even when a Walnut notice sits in front of its words (2026-11-06, the
/// user's phone: a row stuck on "Delivering…", other tasks' rows in his tray, a photo
/// shown as "[Images attached …]", one message drawn twice).
@MainActor
final class SessionQueueTrayTests: XCTestCase {
    private static let imageHeader = "[Images attached \u{2014} use the Read tool to view them]"
    private static let notice = "<walnut-message kind=\"notification\" from=\"Walnut\" outcome=\"task-routing-policy\">\n"
        + "Walnut changed your default instructions.\n</walnut-message>\n\n"
    private static let trigger = "<walnut-message kind=\"trigger\" from=\"Trigger: Daily check\">\n"
        + "Routine ran on schedule\n</walnut-message>\n\n"

    private func row(_ id: String, _ text: String = "words", status: String = "pending",
                     stage: String? = nil, delivered: Bool? = nil, sentBy: String? = nil) -> SessionQueuedMessage {
        var row = SessionQueuedMessage(id: id, message: text, status: status, enqueuedAt: "2026-11-06T00:00:00Z")
        row.stage = stage
        row.delivered = delivered
        row.sentBy = sentBy
        return row
    }

    // MARK: - Stages

    /// Ratchet: the stages this build knows. A new server stage is a new case here, with
    /// its words in `statusNote` and its place in the tray decided below.
    func testTheStagesThisBuildKnowsAreListed() {
        XCTAssertEqual(QueueStage.allCases.map(\.rawValue), ["waiting", "written", "taken"],
                       "a stage was added or renamed: give it its words in statusNote and its row in this test")
    }

    /// Every stage (and none, and one this build does not know) under every status has
    /// its words and its place in the tray.
    func testEveryStageMapsToItsWordsAndItsPlaceInTheTray() {
        struct Case { let stage: String?; let processing: String?; let pending: String?; let listed: Bool }
        let cases: [Case] = [
            // A processing row was handed to the session whatever its stage says (the web's
            // rule): never listed, never "Delivering" while the session already has it.
            Case(stage: nil, processing: "Delivering\u{2026}", pending: nil, listed: false),
            Case(stage: "waiting", processing: "Going out now", pending: nil, listed: false),
            Case(stage: "written", processing: "Reaches it after its current step",
                 pending: "Reaches it after its current step", listed: false),
            Case(stage: "taken", processing: nil, pending: nil, listed: false),
            Case(stage: "teleported", processing: "Delivering\u{2026}", pending: nil, listed: false),
        ]
        XCTAssertEqual(Set(cases.compactMap(\.stage)).intersection(QueueStage.allCases.map(\.rawValue)).count,
                       QueueStage.allCases.count, "a known stage has no case in this table")
        for c in cases {
            let processing = row("p", status: "processing", stage: c.stage)
            let pending = row("q", status: "pending", stage: c.stage)
            XCTAssertEqual(processing.statusNote, c.processing, "processing, stage \(c.stage ?? "nil")")
            XCTAssertEqual(pending.statusNote, c.pending, "pending, stage \(c.stage ?? "nil")")
            XCTAssertEqual(row("parked", status: "parked", stage: c.stage).statusNote, "Not sent")
            XCTAssertEqual(row("held", status: "held", stage: c.stage).statusNote, "Waiting for your Mac")
            XCTAssertEqual(SessionQueueModel.shownRows([processing]).count, c.listed ? 1 : 0,
                           "stage \(c.stage ?? "nil") listed")
            XCTAssertFalse(SessionTimelineBody.queueHolds(processing),
                           "stage \(c.stage ?? "nil"): a message is its own bubble, never held off the page")
            XCTAssertFalse(SessionTimelineBody.queueHolds(pending), "a waiting message is its own bubble, marked Queued")
        }
    }

    func testARowMarkedDeliveredLeavesTheTrayWhateverItsStageSays() {
        let delivered = row("d", status: "processing", stage: nil, delivered: true)
        XCTAssertTrue(delivered.isDelivered)
        XCTAssertTrue(SessionQueueModel.shownRows([delivered]).isEmpty)
        XCTAssertFalse(SessionTimelineBody.queueHolds(delivered))
        XCTAssertFalse(SessionTimelineBody.queueHolds(nil))
    }

    func testTheHeadlineSaysAWrittenLineReachesItAfterItsStep() {
        XCTAssertEqual([row("a", status: "processing", stage: "written")].headline(turnRunning: true),
                       "After its current step")
        XCTAssertEqual([row("a", status: "processing", stage: "waiting")].headline(turnRunning: true),
                       "Going out now")
        XCTAssertEqual([row("a", status: "pending", stage: "waiting")].headline(turnRunning: true),
                       "Sends after this turn")
        XCTAssertEqual([row("a", status: "processing")].headline(turnRunning: true), "Going out now")
    }

    // MARK: - Decoding

    func testTheNewFieldsDecodeAndAnUnknownStageOrAMalformedPictureDoesNotFailTheRow() throws {
        let json = """
        {"messages":[
          {"id":"qm-1","message":"Look at this","status":"processing","enqueuedAt":"2026-11-06T00:00:00Z",
           "rawMessage":"[Images attached]\\n- /tmp/a.jpg\\n\\nLook at this","sentBy":"person",
           "images":[{"path":"/tmp/a.jpg","url":"/api/v1/media?path=%2Ftmp%2Fa.jpg"},{"url":7}],
           "files":[{"path":"/up/up-1/report.pdf","name":"report.pdf"}],
           "stage":"teleported","delivered":false},
          {"id":"qm-2","message":"old","status":"pending"}
        ]}
        """
        let decoded = try JSONDecoder().decode(SessionQueueResponse.self, from: Data(json.utf8))
        let first = decoded.messages[0]
        XCTAssertEqual(first.sentBy, "person")
        XCTAssertEqual(first.images?.first, .init(path: "/tmp/a.jpg", url: "/api/v1/media?path=%2Ftmp%2Fa.jpg"))
        XCTAssertEqual(first.files?.first?.shownName, "report.pdf")
        XCTAssertEqual(first.stage, "teleported")
        XCTAssertNil(first.queueStage)
        XCTAssertTrue(first.isDelivered, "processing: the session has it")
        XCTAssertEqual(first.shownImagePaths, ["/tmp/a.jpg"])
        XCTAssertEqual(first.shownFileNames, ["report.pdf"])
        XCTAssertEqual(first.shownText, "Look at this")
        let old = decoded.messages[1]
        XCTAssertNil(old.sentBy)
        XCTAssertNil(old.stage)
        XCTAssertNil(old.images)
    }

    // MARK: - Whose rows

    func testOnlyThePersonsRowsAreListed() {
        let rows = [
            row("mine", sentBy: "person"),
            row("peer", Self.notice + "From another task", sentBy: "agent"),
            row("older-server", sentBy: nil),
            row("trigger", Self.trigger, sentBy: "agent"),
        ]
        XCTAssertEqual(SessionQueueModel.shownRows(rows).map(\.id), ["mine", "older-server"])
    }

    func testTheTrayReadsOnlyThePersonsWaitingRows() async {
        let transport = SessionQueueModelTests.Transport()
        transport.rows = [
            row("mine", sentBy: "person"),
            row("peer", sentBy: "agent"),
            row("taken", status: "processing", stage: "taken", sentBy: "person"),
            row("written", status: "processing", stage: "written", sentBy: "person"),
        ]
        let queue = SessionQueueModel(sessionId: "tray-1", api: transport)
        await queue.refresh()
        // A row the session holds (processing, at any stage) is delivered, the web's rule: only
        // the person's own waiting row is the page's (2026-11-09: "Delivering" stuck on a written row).
        XCTAssertEqual(queue.rows.map(\.id), ["mine"])
    }

    // MARK: - Attachment headers from an older server

    func testAnOlderServersHeaderNeverShowsInTheTray() {
        let photo = row("p", Self.imageHeader + "\n- /tmp/walnut-images/a.jpg\n\nLook at this")
        XCTAssertEqual(photo.shownText, "Look at this")
        XCTAssertEqual(photo.shownImagePaths, ["/tmp/walnut-images/a.jpg"])

        let alone = row("q", Self.imageHeader + "\n- /tmp/walnut-images/a.jpg\n- /tmp/walnut-images/b.png\n\n")
        XCTAssertEqual(alone.shownText, "2 photos")
        XCTAssertEqual(alone.shownImagePaths.count, 2)

        let behindNotice = row("r", Self.notice + Self.imageHeader + "\n- /tmp/walnut-images/c.jpg\n\n")
        XCTAssertEqual(behindNotice.shownText, "Photo")

        let file = row("f", ComposerFile.messageText("", paths: ["/up/up-1/report.pdf"]))
        XCTAssertEqual(file.shownText, "report.pdf")
        XCTAssertTrue(file.shownImagePaths.isEmpty)

        for r in [photo, alone, behindNotice, file] {
            XCTAssertFalse(r.shownText.contains("attached"), "\(r.id): \(r.shownText)")
            XCTAssertFalse(r.shownText.contains("/tmp/"), "\(r.id): \(r.shownText)")
        }
        // A current server's row: the words alone, the picture beside them.
        var current = row("n", "Look at this")
        current.images = [.init(path: "/tmp/walnut-images/d.jpg", url: "/api/v1/media?path=x")]
        XCTAssertEqual(current.shownText, "Look at this")
        XCTAssertEqual(current.shownImagePaths, ["/tmp/walnut-images/d.jpg"])
    }

    // MARK: - Words for the tray, the stored text for Undo

    private static func photoText(_ words: String) -> String {
        imageHeader + "\n- /tmp/walnut-images/a.jpg\n\n" + words
    }

    func testTheTrayShowsTheTypedWordsAndKeepsTheStoredTextWhole() {
        var current = row("w", Self.photoText("Look at this"))
        current.words = "Look at this"
        current.images = [.init(path: "/tmp/walnut-images/a.jpg", url: "/api/v1/media?path=x")]
        XCTAssertEqual(current.shownText, "Look at this")
        XCTAssertEqual(current.shownImagePaths, ["/tmp/walnut-images/a.jpg"])
        XCTAssertTrue(current.message.hasPrefix(Self.imageHeader), "the stored text lost its header")

        var photoOnly = row("p", Self.photoText(""))
        photoOnly.words = ""
        XCTAssertEqual(photoOnly.shownText, "Photo", "a picture with no words reads as one, from the header")
        XCTAssertEqual(photoOnly.shownImagePaths, ["/tmp/walnut-images/a.jpg"])
    }

    func testUndoOfAPhotoRowSendsItsStoredTextWithTheHeader() async {
        let transport = SessionQueueModelTests.Transport()
        var photo = row("qm-photo", Self.photoText("Look at this"), sentBy: "person")
        photo.words = "Look at this"
        transport.rows = [photo]
        let queue = SessionQueueModel(sessionId: "tray-undo", api: transport)
        await queue.refresh()
        await queue.withdraw(queue.rows[0])
        let gone = queue.withdrawn
        XCTAssertNotNil(gone, "no Undo offered")
        XCTAssertEqual(gone?.text, Self.photoText("Look at this"))
        let plan = gone?.restorePlan(rows: queue.rows)
        XCTAssertEqual(plan?.steps.map(\.text), [Self.photoText("Look at this")],
                       "Undo would resend the words without the picture")
    }

    func testUndoOfAPhotoOnlyRowIsNeverAnEmptySend() async {
        let transport = SessionQueueModelTests.Transport()
        var photo = row("qm-photo-only", Self.photoText(""), sentBy: "person")
        photo.words = ""
        transport.rows = [photo]
        let queue = SessionQueueModel(sessionId: "tray-undo-photo", api: transport)
        await queue.refresh()
        await queue.withdraw(queue.rows[0])
        let plan = queue.withdrawn?.restorePlan(rows: queue.rows)
        XCTAssertEqual(plan?.steps.count, 1)
        let text = plan?.steps.first?.text ?? ""
        XCTAssertFalse(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "Undo would send nothing")
        XCTAssertTrue(text.hasPrefix(Self.imageHeader))

        // A set-aside photo goes back to the message box with its header, not as nothing.
        var parked = row("qm-parked", Self.photoText(""), status: "parked", sentBy: "person")
        parked.words = ""
        transport.rows = [parked]
        await queue.refresh()
        await queue.withdraw(queue.rows[0])
        XCTAssertEqual(queue.withdrawn?.restorePlan(rows: queue.rows).draftText?.hasPrefix(Self.imageHeader), true)
    }

    // MARK: - Editing

    func testAnEditShowsTheNewWordsAtOnce() async {
        let transport = SessionQueueModelTests.Transport()
        var photo = row("qm-edit", Self.photoText("old words"), sentBy: "person")
        photo.words = "old words"
        photo.images = [.init(path: "/tmp/walnut-images/a.jpg", url: "/api/v1/media?path=x")]
        transport.rows = [photo]
        let queue = SessionQueueModel(sessionId: "tray-edit", api: transport)
        await queue.refresh()
        XCTAssertEqual(queue.rows.first?.shownText, "old words")
        let saved = await queue.edit(queue.rows[0], to: "new words")
        XCTAssertTrue(saved)
        XCTAssertEqual(queue.rows.first?.shownText, "new words", "the tray kept the old words after the save")
        XCTAssertNil(queue.rows.first?.words)
        XCTAssertEqual(queue.rows.first?.images?.map(\.path), ["/tmp/walnut-images/a.jpg"], "the edit dropped the row's thumbnail")
    }

    func testOnACurrentServerTheEditBoxOpensWithTheTypedWordsAndSendsOnlyThem() async {
        let transport = SessionQueueModelTests.Transport()
        var photo = row("qm-words", Self.photoText("Look at this"), sentBy: "person")
        photo.words = "Look at this"
        transport.rows = [photo]
        let queue = SessionQueueModel(sessionId: "tray-edit-words", api: transport)
        await queue.refresh()
        let current = queue.rows[0]
        XCTAssertEqual(current.editableText, "Look at this", "the edit box opened with the attachment header")
        XCTAssertFalse(current.isChanged(by: "Look at this"))
        XCTAssertTrue(current.isChanged(by: "Look at this again"))
        _ = await queue.edit(current, to: current.editableText + " again")
        XCTAssertEqual(transport.edited.map(\.1), ["Look at this again"])

        // An older server sends no words: the box holds the stored text whole, header and all.
        let older = row("qm-old", Self.photoText("Look at this"))
        XCTAssertEqual(older.editableText, Self.photoText("Look at this"))
        XCTAssertFalse(older.isChanged(by: Self.photoText("Look at this")))
    }

    func testWordsWithANoteInFrontShowOnlyThePersonsWords() {
        var launch = row("qm-launch", Self.notice + "Fix the flaky test")
        launch.words = "<walnut-message kind=\"peer-note\" from=\"Lead\">\nhi\n</walnut-message>\n\nFix the flaky test"
        XCTAssertEqual(launch.shownText, "Fix the flaky test")
    }

    // MARK: - Stop counts every waiting row

    func testStopAsksAboutAnotherTasksWaitingRowsTheTrayDoesNotList() async {
        let transport = SessionQueueModelTests.Transport()
        transport.rows = [
            row("peer", Self.notice + "From another task", sentBy: "agent"),
            row("peer-delivering", status: "processing", stage: "written", sentBy: "agent"),
        ]
        let queue = SessionQueueModel(sessionId: "tray-stop", api: transport)
        await queue.refresh()
        XCTAssertTrue(queue.rows.isEmpty, "another task's row is in the person's tray")
        XCTAssertEqual(queue.waitingToGoIn, 1, "a Stop would set the other task's row aside without asking")
        transport.rows.append(row("mine", sentBy: "person"))
        await queue.refresh()
        XCTAssertEqual(queue.waitingToGoIn, 2)
        let question = SessionQueueModel.stopQuestion(waiting: queue.waitingToGoIn, othersWaiting: queue.othersWaiting)
        XCTAssertTrue(question.contains("1 message from another task"), question)
        XCTAssertEqual(SessionQueueModel.stopQuestion(waiting: 1, othersWaiting: 0),
                       "Your waiting message will stay here, not sent. You can send it afterwards.")
    }

    // MARK: - The bubble gives way to its own row

    private static let fileId = "up-7f3a"
    private static let filePath = "/home/u/.walnut-uploads/\(fileId)/report.pdf"
    private static let imagePath = "/tmp/walnut-images/abc.jpg"

    private func bubble(_ words: String, images: Bool, files: Bool, id: String = "qm-mobile-1") -> ChatMessage {
        var b = ChatMessage(id: "pending-\(id)", role: "user", text: words, createdAt: "2026-11-06T00:00:00Z", kind: nil)
        b.clientMessageId = id
        if images { b.localImages = [Data([0xFF, 0xD8])] }
        if files {
            b.localFiles = [ComposerFile(id: Self.fileId, name: "report.pdf", size: 10, sha256: "x", kind: .pdf,
                                         localURL: URL(fileURLWithPath: "/tmp/report.pdf"))]
        }
        return b
    }

    private func historyRow(_ text: String, id: String, walnutMessageId: String? = nil) -> ChatMessage {
        var r = ChatMessage(id: id, role: "user", text: text, createdAt: "2026-11-06T00:01:00Z", kind: nil)
        r.walnutMessageId = walnutMessageId
        return r
    }

    /// Envelopes in front (none, one, two) × what was attached (nothing, a photo, a file,
    /// both): the transcript's row takes the bubble's place, so the message shows once.
    func testTheRowTakesTheBubblesPlaceWithAnyNoticeInFrontAndAnyAttachment() {
        let envelopes = ["", Self.notice, Self.notice + Self.trigger]
        let words = "Look at this"
        for (n, lead) in envelopes.enumerated() {
            for (images, files) in [(false, false), (true, false), (false, true), (true, true)] {
                var text = words
                if files { text = ComposerFile.messageText(text, paths: [Self.filePath]) }
                if images { text = Self.imageHeader + "\n- \(Self.imagePath)\n\n" + text }
                let label = "\(n) envelope(s), images \(images), files \(files)"
                let b = bubble(words, images: images, files: files)
                for withId in [false, true] {
                    let row = historyRow(lead + text, id: "row-1", walnutMessageId: withId ? "qm-mobile-1" : nil)
                    let gone = SessionConversationStore.bubblesAbsorbed([b], baselines: [:], rows: [row])
                    XCTAssertEqual(gone, [b.id], "\(label), id \(withId): the bubble stayed beside its row")
                }
            }
        }
    }

    func testTheMessageIdWinsOverDifferentText() {
        let b = bubble("hello", images: false, files: false)
        let row = historyRow("something else entirely", id: "row-1", walnutMessageId: "qm-mobile-1")
        XCTAssertEqual(SessionConversationStore.bubblesAbsorbed([b], baselines: [:], rows: [row]), [b.id])
        // Even a row that was on the page when the send went out (a resent line).
        XCTAssertEqual(SessionConversationStore.bubblesAbsorbed([b], baselines: [b.id: ["row-1"]], rows: [row]), [b.id])
    }

    func testEachBubbleTakesTheRowOfItsOwnIdNotTheFirstWithItsWords() {
        let first = bubble("hello", images: false, files: false, id: "qm-mobile-1")
        let second = bubble("hello", images: false, files: false, id: "qm-mobile-2")
        let rows = [
            historyRow("hello", id: "row-a", walnutMessageId: "qm-mobile-2"),
            historyRow("hello (edited)", id: "row-b", walnutMessageId: "qm-mobile-1"),
        ]
        XCTAssertEqual(SessionConversationStore.bubblesAbsorbed([first, second], baselines: [:], rows: rows),
                       [first.id, second.id])
    }

    func testARowAnotherBubbleWasSentAsIsNeverThisBubblesByItsWords() {
        let accepted = bubble("ok", images: false, files: false, id: "qm-mobile-1")
        var stillOut = bubble("ok", images: false, files: false, id: "qm-mobile-2")
        stillOut.pending = true
        let rows = [historyRow("ok", id: "row-a", walnutMessageId: "qm-mobile-2")]
        XCTAssertTrue(SessionConversationStore.bubblesAbsorbed([accepted, stillOut], baselines: [:], rows: rows).isEmpty)
    }

    func testOwnWordsTakesOffEveryNoteInFrontAndLeavesPlainTextAlone() {
        XCTAssertEqual(PeerMessagePresentation.ownWords("plain words"), "plain words")
        XCTAssertEqual(PeerMessagePresentation.ownWords(Self.notice + Self.trigger + "hi"), "hi")
        XCTAssertEqual(PeerMessagePresentation.ownWords("<system-reminder>\nWalnut (hint): x\n</system-reminder>\n\nhi"), "hi")
        let photo = Self.imageHeader + "\n- \(Self.imagePath)\n\nhi"
        XCTAssertNotNil(MessageRow.attachmentSendParts(PeerMessagePresentation.ownWords(Self.notice + photo)))
    }

    // MARK: - Through the store

    func testAPhotoSentWithANoticeInFrontShowsOnceWhenItsRowArrives() async throws {
        let transport = MockSessionSendTransport()
        transport.transcript = SessionTranscript(
            sessionId: "tray", exportedAt: "2026-11-06T00:00:00Z", truncated: false,
            messages: [.init(role: "user", text: "Run the tests", timestamp: "2026-11-06T00:00:00Z", kind: nil),
                       .init(role: "assistant", text: "All green.", timestamp: "2026-11-06T00:00:01Z", kind: nil)]
        )
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "tray-store"), transport: transport)
        await store.open()
        defer { store.close() }
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        let jpeg = renderer.image { $0.fill(CGRect(x: 0, y: 0, width: 8, height: 8)) }.jpegData(compressionQuality: 0.8)!
        let image = try XCTUnwrap(SelectedImage(jpegData: jpeg))
        let accepted = await store.send("Look at this", images: [image])
        XCTAssertTrue(accepted)
        let sentId = try XCTUnwrap(transport.messageIds.last ?? nil)

        var row = SessionTranscript.Message(
            role: "user", text: Self.notice + Self.imageHeader + "\n- \(Self.imagePath)\n\nLook at this",
            timestamp: "2026-11-06T00:00:02Z", kind: nil, sentBy: "person"
        )
        row.walnutMessageId = sentId
        transport.transcript = SessionTranscript(
            sessionId: "tray", exportedAt: "2026-11-06T00:00:03Z", truncated: false,
            messages: transport.transcript.messages + [row]
        )
        store.reconcile(transport.transcript)
        XCTAssertFalse(store.messages.contains { $0.localImages != nil }, "the sent photo stayed beside its own row")
        XCTAssertEqual(store.messages.filter { $0.isUser && $0.text.hasSuffix("Look at this") }.count, 1)
    }
}
