import XCTest
@testable import Walnut

/// Every time the phone stamps itself reads the shown clock, and every way out of
/// the demo puts the shown clock back (App Store r7 gate, finding 5: Debug builds
/// only, but the listing shots are taken under the pin).
///  - C1: the chat's local echo is stamped on the shown clock and was judged by the
///    device clock, so under a pin four days back it looked four days old and was
///    dropped from a lagging fetch.
///  - The board footer's "Synced" stamp came from the device clock and was shown
///    against the shown clock: "Synced in 4 days".
///  - A demo whose connection failed kept its pin, so a real pairing made next in
///    the same process ran on the pinned clock.
@MainActor
final class DemoClockGapsTests: XCTestCase {
    private static let iso = ISO8601DateFormatter()

    override func setUp() async throws {
        AppClock.clearDemoPin()
    }

    override func tearDown() async throws {
        AppClock.clearDemoPin()
    }

    /// Launch arguments that pin the demo four days before now.
    private static func fourDaysBack() -> (pin: Date, arguments: [String]) {
        let pin = Date().addingTimeInterval(-4 * 86_400)
        return (pin, ["Walnut", AppClock.demoPinArgument, iso.string(from: pin)])
    }

    /// C1 (the gate's probe): a solidified echo stamped on the pinned clock, absent
    /// from a lagging fetch, is seconds old and is carried.
    func testAnEchoStampedOnThePinnedClockIsCarried() {
        let (pin, arguments) = Self.fourDaysBack()
        AppClock.applyDemoPin(arguments: arguments, demoActive: true)
        XCTAssertLessThan(abs(AppClock.now().timeIntervalSince(pin)), 5)
        let echo = ChatMessage(id: "local-clock", role: "user", text: "hi",
                               createdAt: Self.iso.string(from: AppClock.now()), kind: nil)
        let kept = ChatStore.carryLocalRows(current: [echo], fetched: [])
        XCTAssertEqual(kept.map(\.id), ["local-clock"],
                       "an echo stamped on the pinned clock was judged by the device clock and dropped")
    }

    /// The board footer: a feed update is stamped on the shown clock, so it reads as
    /// just now and never "in 4 days".
    func testTheSyncedStampIsOnTheShownClock() throws {
        let (_, arguments) = Self.fourDaysBack()
        AppClock.applyDemoPin(arguments: arguments, demoActive: true)
        let store = TasksStore(transport: MockTaskTransport())
        store._applyFeedMutationsForTesting([.snapshot(tasks: [], sessions: [])])
        let synced = try XCTUnwrap(store.syncedAt)
        XCTAssertEqual(synced.timeIntervalSince(AppClock.now()), 0, accuracy: 5,
                       "the Synced stamp came from the device clock")
        XCTAssertFalse(AppClock.relativeNamed(synced).hasPrefix("in "), AppClock.relativeNamed(synced))
    }

    /// A demo that could not connect leaves the shown clock on the device's.
    func testADemoThatDidNotStartLeavesTheDeviceClock() async {
        let (_, arguments) = Self.fourDaysBack()
        let connection = ConnectionStore()
        do {
            try await DemoEntry.enter(connection: connection, arguments: arguments,
                                      connect: { _ in throw APIError.badResponse })
            XCTFail("the entry was meant to fail")
        } catch {}
        XCTAssertEqual(AppClock.demoOffset, 0, "a demo that did not start kept its pinned clock")
    }

    /// Pairing a real server ends the pin, whatever left it set.
    func testPairingARealServerLeavesTheDeviceClock() async {
        let (_, arguments) = Self.fourDaysBack()
        AppClock.applyDemoPin(arguments: arguments, demoActive: true)
        XCTAssertNotEqual(AppClock.demoOffset, 0)
        let connection = ConnectionStore()
        _ = try? await connection.connect(serverURL: "https://pairing.example.invalid",
                                          token: "not-a-token", deviceName: nil)
        XCTAssertEqual(AppClock.demoOffset, 0, "a real pairing kept the demo's pinned clock")
    }
}
