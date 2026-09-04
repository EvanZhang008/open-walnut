import UserNotifications
import XCTest
@testable import Walnut

/// Push notifications for Human Inbox letters — the pure halves.
///
/// Two contracts are pinned here, both of which fail SILENTLY when broken (no
/// crash, no error: notifications simply stop working, which is indistinguishable
/// from "the server didn't send one"):
///
///  1. **Payload → letter id.** The server builds the payload in
///     `src/core/push/letter-push.ts`; `LetterDeepLink` parses it. If either side
///     renames a key the tap opens nothing. The fixtures below are the exact
///     shapes the server emits, byte for byte.
///  2. **Mode gating.** `always` is the DEFAULT and must survive a missing or
///     junk stored value — a preference read that silently falls back to "quiet"
///     would reproduce the bug this feature fixes (letters never arriving).
@MainActor
final class PushNotificationTests: XCTestCase {

    // MARK: - Fixtures matching the server exactly

    /// What `apnsPayload(letterPushContent(...))` produces: the letter fields sit
    /// FLAT beside `aps`, and are repeated nested under `data`.
    private func serverPayload(
        letterId: String = "lt-m9x2k1-a4f7",
        type: String = "human_inbox_letter"
    ) -> [AnyHashable: Any] {
        let data: [String: Any] = [
            "type": type,
            "letterId": letterId,
            "letterType": "review",
            "kind": "new",
        ]
        var payload: [AnyHashable: Any] = [
            "aps": [
                "alert": ["title": "New letter: Sync freeze root cause found",
                          "body": "The 22h stall was an orphaned rebase lock."],
                "sound": "default",
                "content-available": 1,
            ],
            "data": data,
        ]
        for (key, value) in data { payload[key] = value }
        return payload
    }

    // MARK: - Payload → letter id

    func testFlatServerPayloadYieldsLetterId() {
        XCTAssertEqual(
            LetterDeepLink.letterId(fromPush: serverPayload()),
            "lt-m9x2k1-a4f7"
        )
    }

    /// The nested-only shape must still parse: it's what an older/alternate
    /// sender produces, and the parser advertises support for it.
    func testNestedOnlyPayloadYieldsLetterId() {
        let payload: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "t", "body": "b"]],
            "data": [
                "type": "human_inbox_letter",
                "letterId": "lt-m9x2k1-a4f7",
            ],
        ]
        XCTAssertEqual(LetterDeepLink.letterId(fromPush: payload), "lt-m9x2k1-a4f7")
    }

    /// A push that is not a letter (a session result, a cron notification) must
    /// not be routed to the inbox.
    func testNonLetterPushIsIgnored() {
        XCTAssertNil(LetterDeepLink.letterId(fromPush: serverPayload(type: "session_result")))
        XCTAssertNil(LetterDeepLink.letterId(fromPush: ["aps": ["alert": "hi"]]))
    }

    /// A push is untrusted input that becomes a URL path, so a malformed id is
    /// refused on device rather than sent to the server.
    func testMalformedLetterIdIsRefused() {
        for bad in ["../../etc/passwd", "lt-../-aaaa", "xx-abc-defg", "lt-abc", ""] {
            XCTAssertNil(
                LetterDeepLink.letterId(fromPush: serverPayload(letterId: bad)),
                "should refuse \(bad)"
            )
        }
    }

    /// The server's real id generator is `lt-<timestamp36>-<rand>`; pin that the
    /// validator accepts that exact shape.
    func testServerShapedIdsAreValid() {
        XCTAssertTrue(LetterDeepLink.isValidLetterId("lt-m9x2k1-a4f7"))
        XCTAssertTrue(LetterDeepLink.isValidLetterId("lt-1-abcd"))
        XCTAssertFalse(LetterDeepLink.isValidLetterId("lt-M9X2K1-a4f7"), "uppercase is not base36 here")
    }

    // MARK: - Tap vs silent delivery

    /// A TAP is a user instruction and opens the letter; a background delivery is
    /// not, and must only refresh the badge. Opening a letter the user never
    /// asked for is the failure this guards.
    func testOnlyATapArmsTheReader() {
        let link = LetterDeepLink.shared
        link.clear()
        let before = link.arrivals

        link.handle(push: serverPayload(), source: "background")
        XCTAssertNil(link.pending, "a silent delivery must not open a letter")
        XCTAssertEqual(link.arrivals, before + 1, "but it must still refresh the list")

        link.handle(push: serverPayload(), source: LetterDeepLink.tapSource)
        XCTAssertEqual(link.pending?.letterId, "lt-m9x2k1-a4f7")
        link.clear()
    }

    // MARK: - Mode gating

    func testDefaultModeIsAlways() {
        UserDefaults.standard.removeObject(forKey: PushRegistration.modeKey)
        XCTAssertEqual(PushRegistration.mode, .always)
    }

    /// A junk stored value must not silently become "quiet" — that would
    /// reproduce the reported bug (letters never arriving).
    func testJunkStoredModeFallsBackToAlways() {
        UserDefaults.standard.set("garbage", forKey: PushRegistration.modeKey)
        XCTAssertEqual(PushRegistration.mode, .always)
        UserDefaults.standard.removeObject(forKey: PushRegistration.modeKey)
    }

    func testWhenInactiveRoundTrips() {
        UserDefaults.standard.set(
            PushRegistration.Mode.whenInactive.rawValue,
            forKey: PushRegistration.modeKey
        )
        XCTAssertEqual(PushRegistration.mode, .whenInactive)
        UserDefaults.standard.removeObject(forKey: PushRegistration.modeKey)
    }

    /// The raw values ARE the server's wire contract (`/api/push/preferences`
    /// and `letter-push-policy.ts` both parse these exact strings).
    func testModeRawValuesMatchTheServerWireContract() {
        XCTAssertEqual(PushRegistration.Mode.always.rawValue, "always")
        XCTAssertEqual(PushRegistration.Mode.whenInactive.rawValue, "when-inactive")
        XCTAssertEqual(PushRegistration.Mode.allCases.count, 2)
    }

    func testEveryModeHasUserFacingCopy() {
        for mode in PushRegistration.Mode.allCases {
            XCTAssertFalse(mode.label.isEmpty)
            XCTAssertFalse(mode.blurb.isEmpty)
        }
    }

    // MARK: - Token encoding

    /// APNs hands back opaque bytes; the server needs lowercase hex. A wrong
    /// encoding produces a token Apple rejects, which reads like a server bug.
    func testDeviceTokenIsLowercaseHex() {
        let data = Data([0x00, 0x0f, 0xa4, 0xff])
        XCTAssertEqual(PushRegistration.hexString(from: data), "000fa4ff")
    }

    func testTokenHexLengthMatchesByteCount() {
        let data = Data(repeating: 0xab, count: 32)
        let hex = PushRegistration.hexString(from: data)
        XCTAssertEqual(hex.count, 64)
        XCTAssertEqual(hex, String(repeating: "ab", count: 32))
    }

    /// A DEBUG build must register against the sandbox gateway; crossing
    /// environments fails exactly like a malformed token.
    func testEnvironmentMatchesBuildConfiguration() {
        #if DEBUG
        XCTAssertEqual(PushRegistration.environment, "sandbox")
        #else
        XCTAssertEqual(PushRegistration.environment, "production")
        #endif
    }

    // MARK: - The upload memo (why a broken install heals itself)

    private static let token = String(repeating: "ab", count: 32)
    private static let primary = URL(string: "http://192.168.1.10:3456")
    private static let replica = URL(string: "https://companion.example.dev")

    /// THE regression test for the reported symptom: letters never notified because
    /// the phone believed it had already uploaded. The memo used to be the bare
    /// token, so it meant "some box once took this", and the app never POSTed again
    /// — not to the box that actually sends. A legacy memo must therefore NEVER
    /// match, which forces exactly one re-upload after the update.
    func testLegacyBareTokenMemoForcesOneReUpload() {
        let legacy = Self.token                                  // what old builds stored
        let now = PushRegistration.uploadMemo(token: Self.token, server: Self.primary)
        XCTAssertNotEqual(legacy, now, "a bare-token memo must not satisfy the new check")
        // ...and having uploaded once, the app goes quiet again (no re-upload loop).
        XCTAssertEqual(now, PushRegistration.uploadMemo(token: Self.token, server: Self.primary))
    }

    /// A token accepted by one box says nothing about another. Nothing clears this
    /// memo on re-pair (`AppConfig.save`/`clear` know nothing about push), so the
    /// SERVER has to be part of the value or a re-paired phone stays unregistered.
    func testMemoIsScopedToTheServer() {
        XCTAssertNotEqual(
            PushRegistration.uploadMemo(token: Self.token, server: Self.primary),
            PushRegistration.uploadMemo(token: Self.token, server: Self.replica)
        )
    }

    /// A rotated token (reinstall) must upload even against the same server.
    func testMemoChangesWithTheToken() {
        XCTAssertNotEqual(
            PushRegistration.uploadMemo(token: Self.token, server: Self.primary),
            PushRegistration.uploadMemo(token: String(repeating: "cd", count: 32), server: Self.primary)
        )
    }

    /// An unpaired app must not write a memo that a later pairing would match.
    func testUnpairedMemoNeverMatchesAPairedOne() {
        let unpaired = PushRegistration.uploadMemo(token: Self.token, server: nil)
        XCTAssertNotEqual(unpaired, PushRegistration.uploadMemo(token: Self.token, server: Self.primary))
        XCTAssertTrue(unpaired.hasPrefix("unpaired|"))
    }

    // MARK: - Memo logging (telling the three silent states apart)

    /// The launch trigger logs which state it found. These three must not collapse
    /// into each other, because they need different actions: `none` = never
    /// uploaded, `legacy-no-server` = a pre-relay memo that heals on this launch,
    /// a real server = compare it with the paired one.
    func testDescribeMemoSeparatesTheThreeStates() {
        XCTAssertEqual(PushRegistration.describeMemo(nil).server, "none")
        XCTAssertEqual(PushRegistration.describeMemo("").server, "none")
        XCTAssertEqual(PushRegistration.describeMemo(Self.token).server, "legacy-no-server")

        let composite = PushRegistration.uploadMemo(token: Self.token, server: Self.primary)
        let described = PushRegistration.describeMemo(composite)
        XCTAssertEqual(described.server, Self.primary?.absoluteString)
        XCTAssertEqual(described.tokenPrefix, String(Self.token.prefix(12)))
    }

    /// A legacy memo is 64 hex chars with no separator; the prefix still has to be
    /// usable, since it is what lines up with the server's own push log.
    func testDescribeMemoKeepsATokenPrefixForALegacyValue() {
        XCTAssertEqual(
            PushRegistration.describeMemo(Self.token).tokenPrefix,
            String(Self.token.prefix(12))
        )
    }

    /// A raw status number in a log tells nobody whether permission was granted.
    func testAuthorizationStatusHasAReadableName() {
        XCTAssertEqual(PushRegistration.statusName(.notDetermined), "notDetermined")
        XCTAssertEqual(PushRegistration.statusName(.denied), "denied")
        XCTAssertEqual(PushRegistration.statusName(.authorized), "authorized")
        XCTAssertEqual(PushRegistration.statusName(.provisional), "provisional")
    }

    // MARK: - "The server has no row for me" (the safety net)

    /// `device_not_registered` is the server's machine-readable way of saying the
    /// box holds no row for this device, and it is what makes the app drop its memo
    /// and re-register. Keyed on the CODE, with the status as the fallback.
    func testDeviceNotRegisteredIsRecognised() {
        let byCode = APIError.server(
            status: 404, code: "device_not_registered",
            message: "This device has no registered push token — register it again",
            serverHash: nil, serverContent: nil
        )
        XCTAssertTrue(PushRegistration.isDeviceNotRegistered(byCode))

        // An older server, or a proxy that rewrote the body, still answers 404.
        let byStatus = APIError.server(
            status: 404, code: "http_error", message: "Server returned 404",
            serverHash: nil, serverContent: nil
        )
        XCTAssertTrue(PushRegistration.isDeviceNotRegistered(byStatus))
    }

    /// Everything else must NOT drop the memo: a bridge outage or an offline Mac is
    /// a "try again later", and re-registering on every 503 would hammer the server.
    func testTransientFailuresDoNotCountAsForgotten() {
        let bridgeDown = APIError.server(
            status: 503, code: "bridge_offline",
            message: "Your primary box is offline", serverHash: nil, serverContent: nil
        )
        XCTAssertFalse(PushRegistration.isDeviceNotRegistered(bridgeDown))
        XCTAssertFalse(PushRegistration.isDeviceNotRegistered(APIError.unauthorized))
        XCTAssertFalse(PushRegistration.isDeviceNotRegistered(APIError.rateLimited))
        XCTAssertFalse(PushRegistration.isDeviceNotRegistered(APIError.notConfigured))
    }

    // MARK: - Launch reconcile (asking the SENDING box whether it agrees)

    private func pushStatus(_ json: String) throws -> WalnutAPI.PushStatus {
        try JSONDecoder().decode(WalnutAPI.PushStatus.self, from: Data(json.utf8))
    }

    /// Defaults to this device's token, since that is what the decision is keyed on.
    private func shouldReregister(
        _ status: WalnutAPI.PushStatus?, myToken: String = PushNotificationTests.token
    ) -> Bool {
        PushRegistration.shouldReregister(after: status, myToken: myToken)
    }

    /// One `tokens` row as the server ships it: 12 characters of the stored token
    /// plus a literal `"..."` (`tokenPrefix()` in core/push/send.ts).
    private func row(prefixOf token: String, length: Int = 12) -> String {
        #"{"platform":"ios","kind":"apns","key_name":"phone-a","origin":"local","#
            + #""registered_at":"2026-09-01T00:00:00.000Z","mode":"always","#
            + #""token_prefix":"\#(String(token.prefix(length)))..."}"#
    }

    /// The old-server shape, and the only case the NAME rule still decides: no
    /// `tokens` array to read, so `registeredThisDevice: false` is all there is.
    /// `registered: true` beside it is the split-brain shape — some phone is
    /// registered there, just not this one.
    func testExplicitFalseFromTheServerForcesReRegistration() throws {
        let status = try pushStatus("""
        {"registered":true,"registeredThisDevice":false,"count":2,
         "apns":{"configured":true,"environment":"production","topic":"dev.openwalnut.ios"}}
        """)
        XCTAssertEqual(status.registeredThisDevice, false)
        XCTAssertEqual(status.count, 2)
        XCTAssertEqual(status.apns?.configured, true)
        XCTAssertNil(status.tokens, "no row list, so the name rule is all that is left")
        XCTAssertEqual(PushRegistration.decisionRule(for: status), .identity)
        XCTAssertTrue(shouldReregister(status))
    }

    /// The common case, and it must stay a no-op: re-uploading a token the server
    /// already holds on every launch would POST forever for nothing.
    func testServerConfirmationLeavesTheMemoAlone() throws {
        let status = try pushStatus("""
        {"registered":true,"registeredThisDevice":true,"count":1,"apns":{"configured":true}}
        """)
        XCTAssertEqual(status.registeredThisDevice, true)
        XCTAssertFalse(shouldReregister(status))
    }

    /// An older server answers this route without the field at all. Absence is not
    /// a "no": reading it as one would drop the memo and re-upload on every single
    /// launch against every server that predates the field.
    func testOldServerWithoutTheFieldIsNotEvidence() throws {
        let status = try pushStatus(#"{"registered":true,"count":1}"#)
        XCTAssertNil(status.registeredThisDevice, "an old server never reported this")
        XCTAssertNil(status.apns)
        XCTAssertEqual(PushRegistration.decisionRule(for: status), .identity)
        XCTAssertFalse(shouldReregister(status))
    }

    /// No answer at all (a 503 from a down bridge, an offline phone, a 401) is a
    /// "try again later", never a reason to throw away a memo that is probably fine.
    func testAFailedStatusCallChangesNothing() {
        XCTAssertFalse(shouldReregister(nil))
        XCTAssertEqual(PushRegistration.decisionRule(for: nil), PushRegistration.DecisionRule.none)
    }

    // MARK: - Deciding by TOKEN, not by the caller's name

    /// My own row is present, so nothing to do. This is the answer the name rule
    /// gets right too — the next test is where they part company.
    func testMyOwnRowInTheListIsAConfirmation() throws {
        let status = try pushStatus(#"{"registered":true,"count":1,"tokens":[\#(row(prefixOf: Self.token))]}"#)
        XCTAssertEqual(PushRegistration.decisionRule(for: status), .token)
        XCTAssertFalse(shouldReregister(status))
    }

    /// THE case identity cannot answer. A bearer-less LAN caller is filed under a
    /// SHARED placeholder name, so with two such phones the one that never
    /// registered still reads `registeredThisDevice: true` and would go on believing
    /// it was registered forever. The rows say otherwise, and the rows win.
    func testRowsForOtherPhonesOnlyMeanReRegisterEvenWhenTheNameSaysYes() throws {
        let other = String(repeating: "cd", count: 32)
        let third = String(repeating: "ef", count: 32)
        let status = try pushStatus("""
        {"registered":true,"registeredThisDevice":true,"count":2,
         "tokens":[\(row(prefixOf: other)),\(row(prefixOf: third))]}
        """)
        XCTAssertEqual(status.registeredThisDevice, true, "the name rule would say 'all good'")
        XCTAssertTrue(shouldReregister(status), "but no row carries MY token")
    }

    /// An empty list is a definite "this box holds nothing", not a missing answer.
    func testAnEmptyRowListMeansReRegister() throws {
        let status = try pushStatus(#"{"registered":false,"count":0,"tokens":[]}"#)
        XCTAssertEqual(status.tokens?.count, 0)
        XCTAssertEqual(PushRegistration.decisionRule(for: status), .token)
        XCTAssertTrue(shouldReregister(status))
    }

    /// APNs hands the app opaque bytes and the app hex-encodes them; nothing
    /// guarantees both sides picked the same case, and a case mismatch reading as
    /// "not my row" would re-upload on every launch forever.
    func testPrefixComparisonIsCaseInsensitive() throws {
        let status = try pushStatus(#"{"count":1,"tokens":[\#(row(prefixOf: Self.token.lowercased()))]}"#)
        XCTAssertFalse(
            shouldReregister(status, myToken: Self.token.uppercased()),
            "the same token in a different case is still the same token"
        )
    }

    /// A prefix too short to identify anything must be IGNORED, not treated as a
    /// match. This one WOULD match on a naive comparison (my token starts `abab`),
    /// which is the point: confirming a row on 3 characters would let another
    /// phone's row silence this phone forever.
    func testAnUnusablyShortPrefixIsNotAMatch() throws {
        let status = try pushStatus(#"{"count":1,"tokens":[\#(row(prefixOf: Self.token, length: 3))]}"#)
        XCTAssertEqual(status.tokens?.first?.tokenPrefix, "aba...")
        XCTAssertNil(PushRegistration.comparablePrefix("aba..."), "3 characters decide nothing")
        XCTAssertTrue(shouldReregister(status))
    }

    /// The wire shape, byte for byte from `pushRegistrationStatus`. If the server
    /// renames `token_prefix` the whole token rule silently degrades to "no row
    /// matches", so pin the key mapping and the `"..."` decoration.
    func testServerRowShapeDecodes() throws {
        let status = try pushStatus("""
        {"registered":true,"registeredThisDevice":true,"count":1,
         "apns":{"configured":true,"environment":"production","topic":"dev.openwalnut.ios"},
         "tokens":[{"platform":"ios","kind":"apns","key_name":"phone-a","origin":"local",
                    "registered_at":"2026-09-01T00:00:00.000Z","mode":"always",
                    "token_prefix":"aabbccddeeff..."}]}
        """)
        XCTAssertEqual(status.tokens?.first?.tokenPrefix, "aabbccddeeff...")
        XCTAssertEqual(PushRegistration.comparablePrefix("aabbccddeeff..."), "aabbccddeeff")
        XCTAssertFalse(shouldReregister(status, myToken: "AABBCCDDEEFFaabbccddeeffaabb"))
        XCTAssertTrue(shouldReregister(status, myToken: String(repeating: "cd", count: 32)))
    }

    /// Defence in depth, NOT the production path. `WalnutAPI.decode` throws
    /// `APIError.server` for any non-2xx before a body is ever handed to
    /// `PushStatus`, so a real 503 arrives as the thrown-error case above. This pins
    /// the other way in: every field is optional so an older server decodes, which
    /// means an error body a proxy rewrote to 200, or some future path that decodes
    /// before checking the status, also decodes. Either must land on nil rather than
    /// on a false that re-registers during exactly the outage that cannot store it.
    func testRelayUnavailableBodyDoesNotDecodeIntoAFalse() throws {
        let bodies = [
            #"{"error":"primary unreachable","code":"bridge_unavailable","retry":true}"#,
            // What the route actually emits: the standard nested envelope.
            #"{"error":{"code":"bridge_offline","message":"Your primary box is offline"},"retry":true}"#,
        ]
        for body in bodies {
            let status = try pushStatus(body)
            XCTAssertNil(status.registeredThisDevice, "no facts in \(body)")
            XCTAssertNil(status.tokens, "and no rows either")
            XCTAssertFalse(shouldReregister(status), "must not act on \(body)")
        }
    }

    /// `count: 0` with no field is still not actionable — the count is a diagnostic
    /// for a human, and the per-device answer is the only thing that decides.
    func testCountAloneIsNotADecision() throws {
        let status = try pushStatus(#"{"registered":false,"count":0,"apns":{"configured":false}}"#)
        XCTAssertEqual(status.apns?.configured, false)
        XCTAssertFalse(shouldReregister(status))
    }

    // MARK: - The wiring (which branch of a token callback does what)

    private func launchAction(
        memoMatches: Bool, reconcileDone: Bool = false,
        inFlight: Bool = false, paired: Bool = true
    ) -> PushRegistration.LaunchAction {
        PushRegistration.launchAction(
            memoMatches: memoMatches, reconcileDone: reconcileDone,
            inFlight: inFlight, paired: paired
        )
    }

    /// The mismatch branch must POST and must NOT spend a GET first: the upload IS
    /// the reconcile there, and asking first would only delay it. A rotated token
    /// still uploads after the launch has already reconciled.
    func testAMemoMismatchUploadsAndNeverAsks() {
        XCTAssertEqual(launchAction(memoMatches: false), .upload)
        XCTAssertEqual(launchAction(memoMatches: false, reconcileDone: true), .upload)
        XCTAssertEqual(launchAction(memoMatches: false, inFlight: true), .upload)
    }

    /// The whole point of the change: a matching memo is the branch that asks. This
    /// is the cell a regression moves — running the reconcile on EVERY callback, or
    /// on none, both left all the other tests green before this existed.
    func testAMatchingMemoAsksTheServerOnce() {
        XCTAssertEqual(launchAction(memoMatches: true), .reconcile)
        XCTAssertEqual(
            launchAction(memoMatches: true, reconcileDone: true), PushRegistration.LaunchAction.none,
            "the server already answered this launch"
        )
        XCTAssertEqual(
            launchAction(memoMatches: true, inFlight: true), PushRegistration.LaunchAction.none,
            "one launch really does deliver two token callbacks — they must not both GET"
        )
    }

    /// Unpaired there is no box to POST to and none to ask, so BOTH branches are
    /// silent. `upload(token:)` guards on this too; this is the half that is testable.
    func testAnUnpairedAppDoesNothingOnEitherBranch() {
        XCTAssertEqual(
            launchAction(memoMatches: false, paired: false), PushRegistration.LaunchAction.none
        )
        XCTAssertEqual(
            launchAction(memoMatches: true, paired: false), PushRegistration.LaunchAction.none
        )
        XCTAssertEqual(
            launchAction(memoMatches: true, reconcileDone: false, paired: false),
            PushRegistration.LaunchAction.none
        )
    }

    /// A GET that FAILED settled nothing, so it must not burn the launch's only
    /// chance: a phone launched while the bridge is down would otherwise never
    /// reconcile again for the life of the process.
    ///
    /// Only the pure half is pinned here. `launchReconcileDone` is private state set
    /// exclusively on a decoded answer (and `reconcileInFlight` is cleared in a
    /// `defer`), so after a throw the inputs are `reconcileDone: false,
    /// inFlight: false` — which is exactly the cell below, reachable a second time.
    /// Pinning the flag itself would need a network seam this class does not have.
    func testAFailedReconcileLeavesTheLaunchRetryable() {
        XCTAssertEqual(launchAction(memoMatches: true, reconcileDone: false, inFlight: false), .reconcile)
    }
}
