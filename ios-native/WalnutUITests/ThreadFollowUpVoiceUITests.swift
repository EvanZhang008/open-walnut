import XCTest

/// The actual Threads entry, Follow up sheet and Send. No microphone, audio
/// session or playback: the DEBUG simulator hook runs the real recorder state.
final class ThreadFollowUpVoiceUITests: ThreadPushUITestCase {
    override var shotPrefix: String { "VOICE" }
    private let spoken = "Please keep the compact inbox layout and add voice input"
    private let lock = NSLock()
    private var bodies: [[String: Any]] = []

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        bodies = []
        fixture?.extraRoutes = { [weak self] method, path, data in
            guard let self else { return nil }
            if method == "PATCH", path == "/api/v1/sessions/\(OrgThreadsFixture.vpSessionID)" { return (200, ["ok": true]) }
            guard method == "POST", path == "/api/v1/sessions/\(OrgThreadsFixture.vpSessionID)/messages" else { return nil }
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            self.lock.lock()
            self.bodies.append(body)
            self.lock.unlock()
            return (202, ["ok": true, "messageId": "voice-follow-up-fixture"])
        }
    }

    private var sent: [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return bodies
    }

    private func openFollowUp(_ index: Int = 0) {
        let follow = card(ids[index]).buttons["org.thread.followUp"]
        XCTAssertTrue(follow.waitForExistence(timeout: 15))
        bringIntoView(follow)
        touch(follow)
        XCTAssertTrue(el("org.thread.followUp.input").waitForExistence(timeout: 15))
        let mic = el("voice-mic.thread-follow-up")
        XCTAssertTrue(mic.waitForExistence(timeout: 5))
        XCTAssertTrue(mic.isHittable)
        XCTAssertGreaterThanOrEqual(mic.frame.width, 44)
        XCTAssertGreaterThanOrEqual(mic.frame.height, 44)
    }

    private func start(_ extra: [String] = []) throws {
        app = try launchPaired([
            "-walnut.debugThreadPush", "\(vp) \(ids[0])",
            "-walnut.debug.dictationText", spoken,
            "-walnut.debug.dictationDelay", "3",
            "-walnut.debug.showTouches", "YES"
        ] + extra)
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 60))
        openFollowUp()
    }

    private func record() {
        el("voice-mic.thread-follow-up").tap()
        XCTAssertTrue(el("voice.thread-follow-up.voiceStop").waitForExistence(timeout: 10))
        XCTAssertTrue(el("voice.thread-follow-up.voiceStop").isHittable)
    }

    func testFollowUpDictationAppendsAndSendsOnce() throws {
        try start()
        let input = el("org.thread.followUp.input")
        input.tap()
        input.typeText("Typed first.")
        shot("before-mic")
        record()
        shot("recording")
        el("voice.thread-follow-up.voiceStop").tap()
        XCTAssertTrue(poll(20) { (input.value as? String) == "Typed first. " + self.spoken })
        XCTAssertEqual(sent.count, 0, "Stop only inserts words, never sends")
        shot("words-in-follow-up")
        el("org.thread.followUp.send").tap()
        XCTAssertTrue(poll(20) { self.sent.count == 1 })
        XCTAssertTrue(input.waitForNonExistence(timeout: 15))
        XCTAssertTrue((sent[0]["text"] as? String ?? "").contains("Typed first. " + spoken))
        XCTAssertEqual(sent[0]["threadId"] as? String, ids[0], "the send stays filed under the selected thread")
        XCTAssertEqual(sent.count, 1)
        shot("sent")
        openFollowUp()
        XCTAssertEqual(el("org.thread.followUp.input").value as? String, "", "accepted words are not offered for a second Send")
    }

    func testSendStopsRecordingAndWaitsForItsWords() throws {
        try start()
        record()
        let send = el("org.thread.followUp.send")
        XCTAssertTrue(send.isEnabled, "Send must be pressable with an empty box while recording")
        send.tap()
        XCTAssertTrue(poll(5) { send.label == "Waiting for your words, tap to cancel" })
        shot("send-waits")
        XCTAssertTrue(poll(20) { self.sent.count == 1 })
        XCTAssertTrue((sent[0]["text"] as? String ?? "").contains(spoken))
        XCTAssertTrue(el("org.thread.followUp.input").waitForNonExistence(timeout: 15))
    }

    func testCancelWaitKeepsSpokenWordsUnsent() throws {
        try start(["-walnut.debug.dictationDelay", "8"])
        record()
        let send = el("org.thread.followUp.send")
        send.tap()
        XCTAssertTrue(poll(5) { send.label == "Waiting for your words, tap to cancel" })
        send.tap()
        let input = el("org.thread.followUp.input")
        XCTAssertTrue(poll(20) { input.value as? String == self.spoken })
        XCTAssertEqual(sent.count, 0)
        app.navigationBars["Follow up"].buttons["Cancel"].tap()
        openFollowUp()
        XCTAssertEqual(input.value as? String, spoken, "closing and reopening preserves the dictated draft")
    }

    func testFailedTranscriptionKeepsTypedDraftAndRetryRecovers() throws {
        try start(["-walnut.debug.dictationFailOnce", "YES"])
        let input = el("org.thread.followUp.input")
        input.tap()
        input.typeText("Keep this")
        record()
        el("org.thread.followUp.send").tap()
        let retry = el("voice.thread-follow-up.voiceRetry")
        XCTAssertTrue(retry.waitForExistence(timeout: 20), "failed take must offer Retry")
        XCTAssertEqual(input.value as? String, "Keep this")
        XCTAssertEqual(sent.count, 0)
        retry.tap()
        XCTAssertTrue(poll(20) { input.value as? String == "Keep this " + self.spoken })
        XCTAssertEqual(sent.count, 0, "recovered words need review before Send")
    }

    func testLateWordsStayWithTheThreadTheyWereSpokenInto() throws {
        try start(["-walnut.debug.dictationDelay", "8"])
        let input = el("org.thread.followUp.input")
        input.tap()
        input.typeText("First thread")
        record()
        el("voice.thread-follow-up.voiceStop").tap()
        app.navigationBars["Follow up"].buttons["Cancel"].tap()
        openFollowUp(1)
        input.tap()
        input.typeText("Other thread")
        // The first recorder is retained by its transcription task; its binding
        // names the first thread, not whichever sheet is now in front.
        XCTAssertTrue(poll(20) { self.el("voice-mic.thread-follow-up").isHittable })
        RunLoop.current.run(until: Date().addingTimeInterval(10))
        XCTAssertEqual(input.value as? String, "Other thread")
        XCTAssertEqual(sent.count, 0)
        app.navigationBars["Follow up"].buttons["Cancel"].tap()
        openFollowUp()
        XCTAssertTrue(poll(10) { input.value as? String == "First thread " + self.spoken })
        XCTAssertEqual(sent.count, 0)
    }

    func testTypingDuringTranscriptionKeepsTheLatestDraft() throws {
        try start(["-walnut.debug.dictationDelay", "8"])
        let input = el("org.thread.followUp.input")
        input.tap()
        input.typeText("Original")
        record()
        el("voice.thread-follow-up.voiceStop").tap()
        input.tap()
        input.typeText(" and newer words")
        XCTAssertTrue(poll(20) { input.value as? String == "Original and newer words " + self.spoken })
        XCTAssertEqual(sent.count, 0)
    }

    func testLargestTextKeepsMicAndStopAboveTheKeyboard() throws {
        try start(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let input = el("org.thread.followUp.input")
        input.tap()
        input.typeText("A long existing follow up that stays editable while voice input is running.")
        let mic = el("voice-mic.thread-follow-up")
        XCTAssertTrue(mic.isHittable)
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists { XCTAssertLessThanOrEqual(mic.frame.maxY, keyboard.frame.minY + 1) }
        record()
        let stop = el("voice.thread-follow-up.voiceStop")
        XCTAssertTrue(stop.isHittable)
        if keyboard.exists { XCTAssertLessThanOrEqual(stop.frame.maxY, keyboard.frame.minY + 1) }
        shot("largest-type-recording")
        stop.tap()
        XCTAssertTrue(poll(20) { (input.value as? String ?? "").hasSuffix(self.spoken) })
        XCTAssertEqual(sent.count, 0)
    }

    func testNativeTaskSearchKeepsItsSharedMicAboveTheKeyboard() throws {
        app = try launchPaired([
            "-walnut.debug.dictationText", "Growth",
            "-walnut.debug.dictationDelay", "1"
        ])
        let tasks = app.tabBars.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 60))
        tasks.tap()
        let search = app.searchFields["Search tasks & sessions"]
        if !search.waitForExistence(timeout: 5) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 10))
            menu.tap()
        }
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        search.tap()
        let mic = el("voice-mic.tasks-search")
        XCTAssertTrue(mic.waitForExistence(timeout: 10))
        XCTAssertTrue(mic.isHittable)
        XCTAssertGreaterThanOrEqual(mic.frame.width, 44)
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists { XCTAssertLessThanOrEqual(mic.frame.maxY, keyboard.frame.minY + 1) }
        mic.tap()
        let stop = el("voice.tasks-search.voiceStop")
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        XCTAssertTrue(stop.isHittable)
        stop.tap()
        XCTAssertTrue(poll(15) { search.value as? String == "Growth" })
        XCTAssertEqual(sent.count, 0)
        shot("native-task-search-voice")
    }

    func testRenamePromptUsesTheSameMicAndConfirmsSpokenWords() throws {
        app = try launchPaired([
            "-walnut.debugThreadPush", "\(vp) \(ids[0])",
            "-walnut.debug.dictationText", spoken,
            "-walnut.debug.dictationDelay", "1",
            "-walnut.debug.showTouches", "YES"
        ])
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 60))
        back()
        sessionMenu("Rename")
        let input = el("session.rename.field")
        XCTAssertTrue(input.waitForExistence(timeout: 15))
        input.tap()
        clear(input)
        let mic = el("voice-mic.session-rename")
        XCTAssertTrue(mic.isHittable)
        mic.tap()
        let stop = el("voice.session-rename.voiceStop")
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        stop.tap()
        XCTAssertTrue(poll(15) { input.value as? String == self.spoken })
        shot("rename-spoken")
        el("session.rename.confirm").tap()
        XCTAssertTrue(input.waitForNonExistence(timeout: 15))
        XCTAssertEqual(sent.count, 0, "renaming never sends a chat message")
    }

    func testDeniedMicrophoneKeepsEditingAvailable() throws {
        try start(["-walnut.debug.dictationDenied", "YES"])
        el("voice-mic.thread-follow-up").tap()
        XCTAssertTrue(el("voice.thread-follow-up.voiceError").waitForExistence(timeout: 10))
        let input = el("org.thread.followUp.input")
        input.tap()
        input.typeText("Typed without voice")
        XCTAssertEqual(input.value as? String, "Typed without voice")
        XCTAssertEqual(sent.count, 0)
    }
}
