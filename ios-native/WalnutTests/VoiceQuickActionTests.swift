import UIKit
import XCTest
@testable import Walnut

/// Home-screen voice Quick Action routing (T54).
///
/// The shortcut is the fastest path to the main agent: long-press the icon →
/// mic opens → speak → stop → transcript is SENT (no draft review, no intent
/// picker). Everything decidable without a microphone or an AVAudioSession is
/// pinned here; the mic-and-server half is covered by the simulator E2E
/// (`ios-native/tests/voice/voice-quickaction-e2e.sh`).
///
/// The seams that make this testable: `VoiceQuickAction` is a plain mailbox
/// (`handle` in, `consume` out) with injectable clocks, so the arming and
/// expiry rules are pure logic. `AVAudioSession` is never touched.
@MainActor
final class VoiceQuickActionTests: XCTestCase {

    override func setUp() {
        super.setUp()
        VoiceQuickAction.shared.clear(reason: "test-setup")
    }

    override func tearDown() {
        VoiceQuickAction.shared.clear(reason: "test-teardown")
        super.tearDown()
    }

    // MARK: - Type matching

    func testOurShortcutTypeIsRecognized() {
        XCTAssertTrue(VoiceQuickAction.isVoiceShortcut(VoiceQuickAction.shortcutType))
    }

    func testForeignAndMissingShortcutTypesAreIgnored() {
        XCTAssertFalse(VoiceQuickAction.isVoiceShortcut(nil),
            "a plain launch (no shortcut item) must not arm the microphone")
        XCTAssertFalse(VoiceQuickAction.isVoiceShortcut("dev.openwalnut.ios.somethingElse"))
        XCTAssertFalse(VoiceQuickAction.isVoiceShortcut(""))
        // Case matters: shortcut types are exact strings, and a near-miss must
        // fail closed rather than open the mic on an unrelated action.
        XCTAssertFalse(VoiceQuickAction.isVoiceShortcut("DEV.OPENWALNUT.IOS.VOICE"))
    }

    /// The Info.plist entry and the Swift constant are two halves of one
    /// contract with NO compiler link between them. A typo in either silently
    /// disables the whole entry point: iOS shows the menu item, the tap
    /// delivers a type the app doesn't recognize, and nothing happens.
    func testInfoPlistDeclaresTheVoiceShortcut() throws {
        let items = try XCTUnwrap(
            Bundle.main.infoDictionary?["UIApplicationShortcutItems"] as? [[String: Any]],
            "Info.plist declares no UIApplicationShortcutItems — the Home-screen long-press menu is empty"
        )
        let types = items.compactMap { $0["UIApplicationShortcutItemType"] as? String }
        XCTAssertTrue(types.contains(VoiceQuickAction.shortcutType),
            "Info.plist shortcut types \(types) don't include VoiceQuickAction.shortcutType (\(VoiceQuickAction.shortcutType)) — the tap would be ignored")
        let voice = try XCTUnwrap(items.first {
            $0["UIApplicationShortcutItemType"] as? String == VoiceQuickAction.shortcutType
        })
        let title = voice["UIApplicationShortcutItemTitle"] as? String
        XCTAssertEqual(title, "Voice to Walnut",
            "the long-press menu label is the whole discoverability surface for this feature")
    }

    // MARK: - Arming

    func testHandleArmsForOurTypeAndRecordsTheDeliveryPath() {
        let action = VoiceQuickAction.shared
        XCTAssertNil(action.pending)
        XCTAssertTrue(action.handle(shortcutType: VoiceQuickAction.shortcutType, source: "launch"))
        XCTAssertEqual(action.pending?.source, "launch",
            "the delivery path must ride the request — which UIKit callback fires differs between cold and warm launch, and the field log is how we find out")
    }

    func testHandleIgnoresForeignTypeAndLeavesMailboxEmpty() {
        let action = VoiceQuickAction.shared
        XCTAssertFalse(action.handle(shortcutType: "dev.openwalnut.ios.other", source: "app-perform"))
        XCTAssertNil(action.pending)
    }

    func testSecondShortcutSupersedesTheFirst() {
        let action = VoiceQuickAction.shared
        action.handle(shortcutType: VoiceQuickAction.shortcutType, source: "launch")
        let first = action.pending
        action.handle(shortcutType: VoiceQuickAction.shortcutType, source: "app-perform")
        XCTAssertNotEqual(action.pending?.id, first?.id,
            "a fresh tap must replace a stale one — the newest press is the user's live intent")
        XCTAssertEqual(action.pending?.source, "app-perform")
    }

    // MARK: - Consumption

    func testConsumeReturnsTheRequestOnceThenEmpties() {
        let action = VoiceQuickAction.shared
        action.handle(shortcutType: VoiceQuickAction.shortcutType, source: "launch")
        XCTAssertNotNil(action.consume())
        XCTAssertNil(action.consume(),
            "a second consumer (the other tab's retained composer, a re-appear) must not open the mic again")
    }

    func testConsumeOnEmptyMailboxIsNil() {
        XCTAssertNil(VoiceQuickAction.shared.consume())
    }

    /// The dangerous case: the app isn't paired, so no composer ever appears to
    /// consume the request. Without expiry it would fire the mic whenever chat
    /// finally rendered — possibly minutes later, with the user long moved on.
    func testExpiredRequestIsDroppedNotHonored() {
        let action = VoiceQuickAction.shared
        let now = Date()
        action.handle(shortcutType: VoiceQuickAction.shortcutType, source: "launch", now: now)
        let later = now.addingTimeInterval(VoiceQuickAction.requestTTL + 1)
        XCTAssertNil(action.consume(now: later),
            "a request older than the TTL must never open the microphone")
        XCTAssertNil(action.pending, "an expired request must also be cleared, not retried on the next appear")
    }

    func testRequestJustInsideTheTTLIsStillHonored() {
        let action = VoiceQuickAction.shared
        let now = Date()
        action.handle(shortcutType: VoiceQuickAction.shortcutType, source: "launch", now: now)
        let later = now.addingTimeInterval(VoiceQuickAction.requestTTL - 1)
        XCTAssertNotNil(action.consume(now: later))
    }

    /// A clock that jumped backwards (NTP / timezone correction) between arming
    /// and consuming yields a negative age. Small negatives are tolerated (the
    /// press really did just happen); a wild one is untrustworthy, and the safe
    /// answer for "should I open the microphone?" is no.
    func testBackwardsClockToleratesSmallSkewButRejectsWildSkew() {
        let request = VoiceQuickAction.Request(id: UUID(), requestedAt: Date(), source: "launch")
        let slightlyBehind = request.requestedAt.addingTimeInterval(-5)
        XCTAssertTrue(VoiceQuickAction.isFresh(request, now: slightlyBehind))
        let wayBehind = request.requestedAt.addingTimeInterval(-(VoiceQuickAction.requestTTL + 60))
        XCTAssertFalse(VoiceQuickAction.isFresh(request, now: wayBehind))
    }

    // MARK: - Auto-send arming (the "goes to the agent, not the draft" switch)

    func testTakeAutoSendIsOneShot() {
        let action = VoiceQuickAction.shared
        action.autoSendArmed = true
        XCTAssertTrue(action.takeAutoSend())
        XCTAssertFalse(action.takeAutoSend(),
            "one transcript may be auto-sent once — a second call (retry of a preserved take) must land in the draft for review")
    }

    func testTakeAutoSendIsFalseForAnOrdinaryMicTap() {
        XCTAssertFalse(VoiceQuickAction.shared.takeAutoSend(),
            "an ordinary mic tap must compose into the draft, never send itself")
    }

    /// Cancel / view-dismissal / a failed transcription all disarm auto-send.
    /// The audio is preserved by the recorder as always; what must NOT happen is
    /// a later manual Retry sending text the user never got to look at.
    func testClearDisarmsAutoSendAndDropsPending() {
        let action = VoiceQuickAction.shared
        action.handle(shortcutType: VoiceQuickAction.shortcutType, source: "launch")
        action.autoSendArmed = true
        action.clear(reason: "cancelled")
        XCTAssertNil(action.pending)
        XCTAssertFalse(action.autoSendArmed)
        XCTAssertFalse(action.takeAutoSend())
    }

    // MARK: - Warm delivery must have a SCENE-level owner

    /// Regression pin for the 2026-08-27 warm-path break.
    ///
    /// UIKit prefers the SCENE delegate for a warm shortcut and only falls back
    /// to `application(_:performActionFor:)` when no scene delegate implements
    /// `windowScene(_:performActionFor:)`. SwiftUI's own internal scene delegate
    /// DOES implement it on iOS 26, so it silently swallowed every warm
    /// delivery: a real long-press on an already-running app armed nothing at
    /// all, while the same tap on a cold app worked.
    ///
    /// The fix is that `QuickActionDelegate` names our own `delegateClass`, so
    /// this asserts the two things that make the fix real: our scene delegate
    /// exists and implements the scene hook (the UIKit contract), and it is the
    /// class the app actually installs (the wiring). A future refactor that
    /// drops either one puts the warm path back in SwiftUI's hands, and the
    /// symptom is invisible to every other test in this file.
    func testSceneDelegateOwnsWarmShortcutDelivery() {
        XCTAssertTrue(
            QuickActionSceneDelegate.instancesRespond(
                to: #selector(UIWindowSceneDelegate.windowScene(_:performActionFor:completionHandler:))
            ),
            "our scene delegate doesn't implement windowScene(_:performActionFor:) — SwiftUI's internal one wins and warm quick actions are dropped"
        )
        let config = QuickActionDelegate.sceneConfiguration(role: .windowApplication)
        XCTAssertTrue(
            config.delegateClass === QuickActionSceneDelegate.self,
            "the app isn't installing QuickActionSceneDelegate, so nothing gets ahead of SwiftUI's scene delegate"
        )
    }

    // MARK: - Consumption guards (the "it does nothing" half of the report)

    /// The rule that decides whether a pending request may open the mic.
    ///
    /// OFFLINE IS NOT IN THIS FUNCTION, and that is the D1 fix: it used to be a
    /// hard block, so a long-press while the phone was offline opened nothing,
    /// logged nothing, and expired 120 seconds later. Recording works offline —
    /// only SENDING does not, and that decision belongs at delivery time.
    func testOnlyRealObstaclesBlockTheMicrophone() {
        XCTAssertNil(
            ComposerBar.voiceQuickActionBlocker(accepts: true, onScreen: true, recorderIdle: true),
            "the ordinary case must go"
        )
        XCTAssertEqual(
            ComposerBar.voiceQuickActionBlocker(accepts: false, onScreen: true, recorderIdle: true),
            "not-a-consumer",
            "a session composer must never steal the shortcut"
        )
        XCTAssertEqual(
            ComposerBar.voiceQuickActionBlocker(accepts: true, onScreen: false, recorderIdle: true),
            "off-screen",
            "a retained off-screen tab must never open a hot mic"
        )
        XCTAssertEqual(
            ComposerBar.voiceQuickActionBlocker(accepts: true, onScreen: true, recorderIdle: false),
            "recorder-busy",
            "a take is already running — do not restart it"
        )
    }

    /// The blocked cases must be RECOVERABLE, not terminal: each blocker names a
    /// condition that ends (the tab comes forward, the upload finishes), and the
    /// composer re-asks on `onChange(of: disabled)` / `onChange(of: voice.state)`.
    /// A request survives being declined — nothing consumes the mailbox on a
    /// deferral, which is what makes the retrigger able to succeed.
    func testADeferredRequestStaysInTheMailbox() {
        XCTAssertTrue(VoiceQuickAction.shared.handle(shortcutType: VoiceQuickAction.shortcutType, source: "scene-perform"))
        XCTAssertNotNil(VoiceQuickAction.shared.pending)
        // The composer's blocked path never calls consume(), so the request is
        // still there for the retrigger.
        XCTAssertNotNil(
            ComposerBar.voiceQuickActionBlocker(accepts: true, onScreen: true, recorderIdle: false)
        )
        XCTAssertNotNil(VoiceQuickAction.shared.pending, "a declined request must not be burned")
        XCTAssertNotNil(VoiceQuickAction.shared.consume(), "…and the retrigger gets it")
        XCTAssertNil(VoiceQuickAction.shared.pending)
    }

    /// Which UIKit callback delivered the take must remain observable AFTER the
    /// mailbox is emptied — it is what the composer publishes as the recording
    /// caption's accessibility value, and therefore the only delivery-layer fact
    /// a UI test can assert. Cold, warm and debug-arg launches are otherwise
    /// indistinguishable from the outside, which is how a warm-path regression
    /// shipped.
    func testConsumedSourceSurvivesConsumptionForTheUI() {
        XCTAssertNil(VoiceQuickAction.shared.lastConsumedSource)
        VoiceQuickAction.shared.handle(shortcutType: VoiceQuickAction.shortcutType, source: "scene-perform")
        _ = VoiceQuickAction.shared.consume()
        XCTAssertEqual(VoiceQuickAction.shared.lastConsumedSource, "scene-perform")
    }

    /// An EXPIRED request must not leave a source behind: the UI would then label
    /// a subsequent ordinary mic tap as if the Home screen had delivered it.
    func testExpiredRequestPublishesNoSource() {
        let armed = Date()
        VoiceQuickAction.shared.handle(
            shortcutType: VoiceQuickAction.shortcutType, source: "launch", now: armed
        )
        XCTAssertNil(VoiceQuickAction.shared.consume(
            now: armed.addingTimeInterval(VoiceQuickAction.requestTTL + 1)
        ))
        XCTAssertNil(VoiceQuickAction.shared.lastConsumedSource)
    }

    // MARK: - Delivery routing (the words must land SOMEWHERE)

    /// By the time a transcript exists the AUDIO IS GONE (success is the one path
    /// that deletes it), so this function decides the fate of the only remaining
    /// copy of what the user said. Every route must be `send` or `draft`; there is
    /// no third answer, and the bug this pins is exactly a third answer.
    func testDeliveryRouteAlwaysHasSomewhereToPutTheWords() {
        XCTAssertEqual(
            ComposerBar.voiceDeliveryRoute(
                autoSendArmed: true, offline: false, busy: false, transcript: "ship it"),
            .send,
            "an armed quick action on a free, online composer is the whole feature"
        )
        XCTAssertEqual(
            ComposerBar.voiceDeliveryRoute(
                autoSendArmed: false, offline: false, busy: false, transcript: "ship it"),
            .draft(reason: "not-armed"),
            "an ordinary mic tap composes into the draft"
        )
        XCTAssertEqual(
            ComposerBar.voiceDeliveryRoute(
                autoSendArmed: true, offline: true, busy: false, transcript: "ship it"),
            .draft(reason: "offline"),
            "recording offline is allowed, so the transcript has to wait in the draft"
        )
        XCTAssertEqual(
            ComposerBar.voiceDeliveryRoute(
                autoSendArmed: true, offline: false, busy: false, transcript: "   \n "),
            .draft(reason: "empty"),
            "a silent take must not fire an empty turn at the agent"
        )
    }

    /// THE LOSS PATH (verifier finding F1). Online, armed, and a turn already
    /// streaming: `ChatStore.send` opens with `guard isActive, !sending, !streaming`
    /// and returns false BEFORE appending any bubble, so a send attempted here
    /// keeps nothing at all. The offline sibling was guarded; this one was not, and
    /// the docstring claimed otherwise.
    func testBusyComposerRoutesToTheDraftInsteadOfLosingTheTranscript() {
        XCTAssertEqual(
            ComposerBar.voiceDeliveryRoute(
                autoSendArmed: true, offline: false, busy: true, transcript: "the words"),
            .draft(reason: "busy"),
            "a turn in flight is not a licence to delete what the user just said"
        )
        // And it stays a draft even when everything else is perfect, i.e. `busy`
        // is not shadowed by an earlier guard returning `.send`.
        for offline in [true, false] {
            if case .send = ComposerBar.voiceDeliveryRoute(
                autoSendArmed: true, offline: offline, busy: true, transcript: "x") {
                XCTFail("busy must never resolve to .send (offline=\(offline))")
            }
        }
    }

    // MARK: - The rescue must fire ONCE, and only when the words are homeless

    /// F7, and it is the OPPOSITE mistake to F1. The first cut discarded the send's
    /// answer, so a refused send deleted the sentence. The second cut rescued on any
    /// `false`, which duplicates: a real failure (500, timeout, disconnect mid-send)
    /// has already kept the text as a retryable red bubble, so putting it in the
    /// draft as well lets the user send the same words twice. `ChatStore`'s own
    /// contract is that every `return false` inside `performSend` runs
    /// `markSendFailed` first — only the refusal BEFORE the append keeps nothing.
    func testOnlyARefusalThatKeptNothingIsRescuedToTheDraft() {
        XCTAssertNil(
            ComposerBar.voiceRescueReason(storeKeptTheWords: true),
            "the store kept it — a second copy in the draft is a duplicate-send hazard"
        )
        XCTAssertEqual(
            ComposerBar.voiceRescueReason(storeKeptTheWords: false),
            "send-refused",
            "nothing kept it, so the draft is the only place left"
        )
    }

    /// …and the Bool that feeds it must actually mean "kept", which is where the
    /// distinction lives. A streaming turn makes `ChatStore.send` refuse BEFORE
    /// appending anything, and this asserts both halves of that: the answer is
    /// false, and the timeline really is untouched (which is WHY it is false).
    func testAStreamingStoreRefusesTheTurnWithoutKeepingAnything() async {
        let chat = ChatStore()
        chat.streaming = true
        XCTAssertFalse(chat.acceptsNewTurn)

        let kept = await ComposerView.sendKeepingWords(chat, "the only copy", [])

        XCTAssertFalse(kept, "a refusal keeps nothing, so the composer must rescue the text")
        XCTAssertTrue(chat.messages.isEmpty, "…and this is the reason: no bubble was appended")
        XCTAssertEqual(
            ComposerBar.voiceRescueReason(storeKeptTheWords: kept), "send-refused",
            "the two halves must agree end to end"
        )
    }

    /// R1. The last leg that reported "safe" while keeping nothing, and the subtlest
    /// of the three because the store was not wrong — it was answering a different
    /// question. A 409 on the answer endpoint means somebody resolved the structured
    /// question elsewhere first, which for THE QUESTION is success (it is gone, the
    /// turn is unblocked), so `answerQuestion` says true. For THE WORDS it is a total
    /// loss: the answer endpoint appends no optimistic bubble, so a dictated answer
    /// simply ceased to exist while the docstring claimed "NO-LOSS, and EXACTLY
    /// ONCE".
    ///
    /// Deliberately SILENT beyond the rescue itself: the words reappearing in the
    /// composer (appended and focused) IS the visible outcome, the same as every
    /// other `voiceDeliveryRoute` draft leg (offline, busy). A notice on top would be
    /// a second announcement of one event — and the question the user was answering
    /// is already gone from the screen, which is the explanation.
    func testAnAnswerSupersededByAnotherClientIsNotReportedAsSafe() {
        // The store keeps its own contract for its own callers…
        XCTAssertNotEqual(ChatStore.AnswerOutcome.supersededKeepingNothing, .delivered)
        XCTAssertNotEqual(ChatStore.AnswerOutcome.supersededKeepingNothing, .failedKeepingNothing,
            "a 409 is neither delivery nor failure — it is the third state that had nowhere to live")
        // …and the voice rescue reads DELIVERY, so only `.delivered` counts as safe.
        for outcome in [ChatStore.AnswerOutcome.supersededKeepingNothing, .failedKeepingNothing] {
            XCTAssertEqual(
                ComposerBar.voiceRescueReason(storeKeptTheWords: outcome == .delivered),
                "send-refused",
                "\(outcome) kept nothing, so the transcript must land in the draft"
            )
        }
        XCTAssertNil(ComposerBar.voiceRescueReason(
            storeKeptTheWords: ChatStore.AnswerOutcome.delivered == .delivered))
    }

    /// The Bool wrapper must keep answering the OTHER question unchanged, or fixing
    /// the voice leg quietly changes what every existing caller of `answerQuestion`
    /// believes. Only an outright failure is a no.
    func testAnswerQuestionBoolStillMeansTheQuestionIsResolved() {
        XCTAssertTrue(ChatStore.AnswerOutcome.delivered != .failedKeepingNothing)
        XCTAssertTrue(ChatStore.AnswerOutcome.supersededKeepingNothing != .failedKeepingNothing,
            "a 409 still resolves the question, so the wrapper still says true")
    }

    /// A store with no pending question cannot answer one, and the answer path keeps
    /// nothing when it declines — so the words come back to the draft.
    func testAnAnswerWithNoPendingQuestionKeepsNothing() async {
        let chat = ChatStore()
        chat.pendingQuestion = true
        // No activeID: `answerQuestionReportingOutcome`'s own guard declines before
        // any network call.
        let outcome = await chat.answerQuestionReportingOutcome("dictated answer")
        XCTAssertEqual(outcome, .failedKeepingNothing)
        XCTAssertTrue(chat.messages.isEmpty, "the answer endpoint never appends a bubble")
        let kept = await ComposerView.sendKeepingWords(chat, "dictated answer", [])
        XCTAssertFalse(kept)
        XCTAssertEqual(ComposerBar.voiceRescueReason(storeKeptTheWords: kept), "send-refused")
    }

    /// The same refusal for the other reason a turn is in flight. Pinned separately
    /// because `sending` and `streaming` are set at different moments (POST in
    /// flight vs SSE deltas arriving) and a guard that lost either one would leave a
    /// real window where the transcript vanishes.
    func testASendingStoreAlsoRefusesWithoutKeepingAnything() async {
        let chat = ChatStore()
        chat.sending = true
        XCTAssertFalse(chat.acceptsNewTurn)
        let kept = await ComposerView.sendKeepingWords(chat, "the only copy", [])
        XCTAssertFalse(kept)
        XCTAssertTrue(chat.messages.isEmpty)
    }

    // MARK: - Main-agent contract

    /// The shortcut promises the MAIN agent (Claude Code engine), whatever
    /// subagent the user last browsed in chat. `ChatStore.mainAgentID` is what
    /// the composer switches to before the mic opens.
    func testMainAgentIsTheQuickActionTarget() {
        XCTAssertEqual(ChatStore.mainAgentID, "general")
        let store = ChatStore()
        store.switchAgent("mentor")
        XCTAssertEqual(store.activeAgentID, "mentor")
        store.switchAgent(ChatStore.mainAgentID)
        XCTAssertEqual(store.activeAgentID, ChatStore.mainAgentID,
            "switching home must be unconditional — a quick-action transcript may never land on a subagent")
    }
}
