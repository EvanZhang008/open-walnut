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
