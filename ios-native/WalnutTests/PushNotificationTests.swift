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
}
