import XCTest
@testable import Walnut

/// Voice mode: what gets read aloud, when, and how a spoken send goes out.
///
/// The decision rules are the part that is easy to get wrong in ways a person
/// only notices with the phone at their ear: reading an old answer when voice
/// mode opens, reading the same answer twice (provisional row, then the
/// canonical one), reading mid-turn text, or reading the previous turn's answer
/// right after they spoke.
///
/// The Chinese test data is written as `\u{...}` escapes (repo rule: no Chinese
/// in code); it covers the zh-CN voice and the full-width punctuation rules.
final class VoiceModeTests: XCTestCase {

    private func row(_ id: String, _ role: String, _ text: String, kind: ChatMessage.Kind? = nil) -> ChatMessage {
        ChatMessage(id: id, role: role, text: text, createdAt: "2026-10-10T10:00:00Z", kind: kind)
    }

    private func decide(
        _ rows: [ChatMessage], streaming: Bool = false, baseline: Set<String> = [],
        spokenIDs: Set<String> = [], provisionalTexts: Set<String> = [],
        provisionalSince: (id: String, at: Date)? = nil, now: Date = Date()
    ) -> VoiceModeController.Decision {
        VoiceModeController.nextToSpeak(
            rows: rows, streaming: streaming, baseline: baseline,
            spokenIDs: spokenIDs, provisionalTexts: provisionalTexts,
            provisionalSince: provisionalSince, now: now, grace: 4
        )
    }

    // MARK: - The decision

    func testReadsTheNewestAnswerOnceTheTurnIsOver() {
        let answer = row("a2", "assistant", "Done. All tests pass.")
        let rows = [row("u1", "user", "run the tests"), row("t1", "assistant", "Bash", kind: .tool), answer]
        XCTAssertEqual(decide(rows), .speak(answer))
        XCTAssertEqual(decide(rows, streaming: true), .nothing, "mid-turn text is not the answer")
    }

    func testNeverReadsWhatWasOnThePageWhenVoiceModeOpened() {
        let rows = [row("u1", "user", "hi"), row("a1", "assistant", "Hello.")]
        XCTAssertEqual(decide(rows, baseline: ["a1"]), .nothing)
    }

    func testAnAnswerOlderThanThePersonsLatestWordsIsNotRead() {
        // They just spoke; the answer on screen belongs to the previous turn.
        let rows = [row("a1", "assistant", "Earlier answer."), row("pending-1", "user", "and now?")]
        XCTAssertEqual(decide(rows), .nothing)
    }

    func testToolAndReasoningRowsAreNotAnswers() {
        let rows = [row("u1", "user", "go"), row("t1", "assistant", "Read file", kind: .tool),
                    row("r1", "assistant", "thinking about it", kind: .thinking)]
        XCTAssertEqual(decide(rows), .nothing)
    }

    func testProvisionalRowWaitsForTheCanonicalOneThenFallsBack() {
        let provisional = row("provisional-42", "assistant", "Fixed it.")
        let start = Date()
        XCTAssertEqual(decide([provisional], now: start), .waitForCanonical("provisional-42"))
        XCTAssertEqual(
            decide([provisional], provisionalSince: ("provisional-42", start), now: start.addingTimeInterval(1)),
            .waitForCanonical("provisional-42")
        )
        XCTAssertEqual(
            decide([provisional], provisionalSince: ("provisional-42", start), now: start.addingTimeInterval(5)),
            .speak(provisional), "a refetch that never lands must not leave the answer unread"
        )
    }

    func testTheSameAnswerIsReadOnceAcrossTheProvisionalToCanonicalSwap() {
        let canonical = row("assistant|t|#0", "assistant", "Fixed it.")
        XCTAssertEqual(
            decide([canonical], provisionalTexts: [VoiceModeController.textKey("Fixed it.")]),
            .replacesReadProvisional(canonical)
        )
        XCTAssertEqual(decide([canonical], spokenIDs: [canonical.id]), .nothing)
    }

    func testAnAnswerWithTheSameWordsAsAnEarlierOneIsStillRead() {
        // Two turns that both end "Done.": the second is a new answer. Only a
        // provisional row's words stand in for its canonical replacement.
        let rows = [
            row("assistant|t1|#0", "assistant", "Done."),
            row("u2", "user", "and the other one"),
            row("assistant|t2|#0", "assistant", "Done."),
        ]
        XCTAssertEqual(decide(rows, spokenIDs: ["assistant|t1|#0"]), .speak(rows[2]))
    }

    func testANoticeTurnIsReadToo() {
        // The Walnut agent woken by a worker's reply: the notice is a user-role
        // row, and the agent's answer after it is a new answer to read.
        let rows = [
            row("a1", "assistant", "I asked the test task to run them."),
            row("n1", "user", "<walnut-message kind=\"notification\">done</walnut-message>"),
            row("a2", "assistant", "The tests finished: all green. Anything next?"),
        ]
        XCTAssertEqual(decide(rows, baseline: [], spokenIDs: ["a1"]), .speak(rows[2]))
    }

    func testAQuestionCardIsAnnouncedOncePerRequest() {
        XCTAssertEqual(VoiceModeController.newRequests(["rq-1"], announced: []), ["rq-1"])
        XCTAssertEqual(VoiceModeController.newRequests(["rq-1"], announced: ["rq-1"]), [],
                       "the same card, seen again by the next poll, is not said twice")
        XCTAssertEqual(VoiceModeController.newRequests(["rq-1", "rq-2"], announced: ["rq-1"]), ["rq-2"])
    }

    // MARK: - What is said

    func testReadsOnlyThePartBeforeTheRule() {
        let prepared = SpokenText.prepare("\u{6211}\u{628A}\u{6D4B}\u{8BD5}\u{8DD1}\u{5B8C}\u{4E86}\u{FF0C}\u{5168}\u{90E8}\u{901A}\u{8FC7}\u{3002}\u{4E0B}\u{4E00}\u{6B65}\u{8981}\u{5408}\u{5E76}\u{5417}\u{FF1F}\n\n---\n\n## Details\n- 42 tests\n- `npm test`")
        XCTAssertEqual(prepared?.language, "zh-CN")
        XCTAssertEqual(prepared?.truncated, true)
        XCTAssertTrue(prepared!.text.hasPrefix("\u{6211}\u{628A}\u{6D4B}\u{8BD5}\u{8DD1}\u{5B8C}\u{4E86}\u{FF0C}\u{5168}\u{90E8}\u{901A}\u{8FC7}\u{3002}\u{4E0B}\u{4E00}\u{6B65}\u{8981}\u{5408}\u{5E76}\u{5417}\u{FF1F}"))
        XCTAssertFalse(prepared!.text.contains("42 tests"))
        XCTAssertTrue(prepared!.text.hasSuffix("The rest is on screen."))
    }

    func testMarkdownCodeTablesAndPathsBecomePlainSentences() {
        let raw = """
        ## Summary
        - **Fixed** the crash in `/Users/me/repo/ios-native/Walnut/Core/SpokenText.swift`
        - See [the PR](https://example.com/pr/1)

        ```swift
        let x = 1
        ```

        | a | b |
        |---|---|
        | 1 | 2 |
        """
        let text = SpokenText.plain(raw)
        XCTAssertEqual(text, "Summary. Fixed the crash in SpokenText.swift. See the PR.")
    }

    func testAndOrIsNotAPath() {
        XCTAssertEqual(SpokenText.shortenPaths("tests and/or docs"), "tests and/or docs")
        XCTAssertEqual(SpokenText.shortenPaths("edit src/core/a.ts now"), "edit a.ts now")
    }

    func testOnlyCodeHasNothingToSay() {
        XCTAssertNil(SpokenText.prepare("```\nonly code\n```"))
    }

    func testLongAnswersStopAtTheBudget() {
        let sentence = "This sentence is here to make the answer long enough to need a cut. "
        let prepared = SpokenText.prepare(String(repeating: sentence, count: 30))!
        XCTAssertTrue(prepared.truncated)
        XCTAssertLessThanOrEqual(SpokenText.estimatedSeconds(prepared.text), SpokenText.budgetSeconds + 3)
        XCTAssertTrue(prepared.text.hasSuffix("The rest is on screen."))
    }

    func testMixedChineseAndEnglishUsesTheChineseVoice() {
        XCTAssertEqual(SpokenText.language(of: "PR \u{5DF2}\u{7ECF}\u{5408}\u{5E76}\u{4E86}\u{FF0C}CI \u{5168}\u{7EFF}\u{3002}"), "zh-CN")
        XCTAssertEqual(SpokenText.language(of: "The PR is merged and CI is green."), "en-US")
    }

    func testAReplyThatOpensWithARuleIsReadWhole() {
        let (head, cut) = SpokenText.spokenPart("---\nAll done.")
        XCTAssertEqual(head, "---\nAll done.")
        XCTAssertFalse(cut)
    }

    // MARK: - The wire

    @MainActor
    func testASpokenSendCarriesTheVoiceFlagOnEveryAttempt() async {
        let transport = MockSessionSendTransport()
        transport.failuresRemaining = 1
        // Not a retryable error: no backoff ladder races the manual retry below.
        transport.failureError = APIError.server(
            status: 400, code: "bad_request", message: "scripted", serverHash: nil, serverContent: nil
        )
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "voice-send"), transport: transport)
        await store.open()

        _ = await store.send("\u{628A}\u{6D4B}\u{8BD5}\u{8DD1}\u{4E00}\u{4E0B}", voice: true)
        guard let failed = store.messages.last(where: { $0.failed == true }) else {
            return XCTFail("the first attempt was scripted to fail")
        }
        await store.retry(failed)
        _ = await store.send("typed follow-up")

        XCTAssertEqual(transport.voiceFlags, [true, true, false],
                       "a retry of a spoken message is still spoken; a typed one is not")
        XCTAssertEqual(store.messages.first(where: { $0.role == "user" })?.text, "\u{628A}\u{6D4B}\u{8BD5}\u{8DD1}\u{4E00}\u{4E0B}",
                       "the bubble shows only what the person said")
    }

    func testTheAskLaunchBody() {
        XCTAssertEqual(
            WalnutAPI.voiceAskBody(agentID: "general", message: "what is open"),
            WalnutAPI.VoiceAskBody(walnutAgent: true, agentId: nil, message: "what is open", voice: true)
        )
        XCTAssertEqual(WalnutAPI.voiceAskBody(agentID: "mentor", message: "x").agentId, "mentor")
    }
}
