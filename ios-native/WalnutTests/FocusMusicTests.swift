import XCTest
@testable import Walnut

/// The phone's focus music: the order rules (twins of the Rhythm web player's
/// `nextTrackIndex`), when the tie to a focus block is checked again, the block's line,
/// and the shape of Rhythm's `music_tracks` answer as the plugin sends it.
@MainActor
final class FocusMusicTests: XCTestCase {
    func testRepeatOneStaysInOrderWrapsShuffleNeverRepeats() {
        XCTAssertEqual(FocusMusicOrder.nextIndex(.one, current: 2, count: 5, random: 0.5), 2)
        XCTAssertEqual(FocusMusicOrder.nextIndex(.inOrder, current: 4, count: 5, random: 0.5), 0)
        XCTAssertEqual(FocusMusicOrder.nextIndex(.inOrder, current: 1, count: 5, random: 0.5), 2)
        XCTAssertEqual(FocusMusicOrder.nextIndex(.shuffle, current: 0, count: 1, random: 0.9), 0)
        XCTAssertEqual(FocusMusicOrder.nextIndex(.inOrder, current: 0, count: 0, random: 0.1), -1)
        for current in 0..<4 {
            for random in [0, 0.24, 0.5, 0.74, 0.999] {
                let next = FocusMusicOrder.nextIndex(.shuffle, current: current, count: 4, random: random)
                XCTAssertNotEqual(next, current)
                XCTAssertTrue((0..<4).contains(next))
            }
        }
    }

    func testOrderRawValuesMatchTheWebPlayer() {
        XCTAssertEqual(FocusMusicOrder.allCases.map(\.rawValue), ["one", "in_order", "shuffle"])
    }

    func testTheTieIsCheckedAtTheBlockEndOrEveryTwentySeconds() {
        let ending = status(phase: "focus", now: 1_000_000, endsAt: 1_005_000)
        XCTAssertEqual(FocusMusicPlayer.nextCheckSeconds(ending), 6, accuracy: 0.001)
        let long = status(phase: "focus", now: 1_000_000, endsAt: 1_000_000 + 25 * 60_000)
        XCTAssertEqual(FocusMusicPlayer.nextCheckSeconds(long), 20)
        XCTAssertEqual(FocusMusicPlayer.nextCheckSeconds(status(phase: "idle", now: 1, endsAt: 0)), 20)
        XCTAssertEqual(FocusMusicPlayer.nextCheckSeconds(nil), 20)
        XCTAssertEqual(FocusMusicPlayer.nextCheckSeconds(status(phase: "focus", now: 2_000, endsAt: 1_000)), 1)
    }

    func testTiesOnlyToABlockThatIsStillRunning() {
        let readAt = Date(timeIntervalSince1970: 1_000)
        let running = status(phase: "focus", now: 1_000_000, endsAt: 1_000_000 + 5 * 60_000)
        XCTAssertTrue(FocusMusicPlayer.shouldTie(withFocus: false, status: running, readAt: readAt, now: readAt.addingTimeInterval(60)))
        // Read an hour ago: that block is over, so Play from the Lock Screen is not tied to it.
        XCTAssertFalse(FocusMusicPlayer.shouldTie(withFocus: false, status: running, readAt: readAt, now: readAt.addingTimeInterval(3_600)))
        XCTAssertFalse(FocusMusicPlayer.shouldTie(withFocus: false, status: status(phase: "idle", now: 1, endsAt: 0), readAt: readAt, now: readAt))
        XCTAssertFalse(FocusMusicPlayer.shouldTie(withFocus: false, status: nil, readAt: readAt, now: readAt))
        XCTAssertTrue(FocusMusicPlayer.shouldTie(withFocus: true, status: nil, readAt: readAt, now: readAt))
    }

    func testBlockLine() {
        XCTAssertEqual(FocusMusicView.phaseText(status(phase: "focus", now: 0, endsAt: 18 * 60_000 - 1)), "18 min left")
        XCTAssertEqual(FocusMusicView.phaseText(status(phase: "idle", now: 0, endsAt: 0)), "Not running")
        XCTAssertEqual(FocusMusicView.phaseText(status(phase: "break", now: 0, endsAt: 1)), "On a break")
        XCTAssertEqual(FocusMusicView.phaseText(nil), "Unknown")
    }

    func testDecodesTheMusicTracksAnswer() throws {
        let json = """
        {"ok":true,"result":{"folder":"/Users/me/.open-walnut/plugin-data/walnut-rhythm/focus-music","isDefault":true,"exists":true,
         "tracks":[{"id":"01 Brown Noise.m4a","title":"Brown Noise","file":"/Users/me/.open-walnut/plugin-data/walnut-rhythm/focus-music/01 Brown Noise.m4a","bytes":465926687,"type":"audio/mp4"}],
         "skipped":["Cafe.flac"],"withFocus":true}}
        """
        let envelope = try JSONDecoder().decode(WalnutAPI.RhythmOpEnvelope<RhythmMusicListing>.self, from: Data(json.utf8))
        XCTAssertTrue(envelope.ok)
        XCTAssertEqual(envelope.result?.tracks.first?.title, "Brown Noise")
        XCTAssertEqual(envelope.result?.tracks.first?.bytes, 465_926_687)
        XCTAssertEqual(envelope.result?.skipped, ["Cafe.flac"])
        XCTAssertNil(envelope.result?.error)
    }

    func testDecodesARefusal() throws {
        let json = #"{"ok":false,"message":"Rhythm runs on your primary Walnut; this is a cloud replica."}"#
        let envelope = try JSONDecoder().decode(WalnutAPI.RhythmOpEnvelope<RhythmMusicListing>.self, from: Data(json.utf8))
        XCTAssertFalse(envelope.ok)
        XCTAssertNil(envelope.result)
        XCTAssertEqual(envelope.message, "Rhythm runs on your primary Walnut; this is a cloud replica.")
    }

    private func status(phase: String, now: Double, endsAt: Double) -> RhythmFocusStatus {
        RhythmFocusStatus(now: now, focus: .init(phase: phase, endsAt: endsAt, title: nil), config: nil)
    }
}
