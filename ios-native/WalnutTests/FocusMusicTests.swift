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
        XCTAssertEqual(FocusMusicView.phaseText(status(phase: "idle", now: 0, endsAt: 0)), "Off")
        XCTAssertEqual(FocusMusicView.phaseText(status(phase: "break", now: 0, endsAt: 1)), "On a break")
        XCTAssertEqual(FocusMusicView.phaseText(nil), "Unknown")
    }

    /// The screen follows the block between reads: its own clock counts the minutes down, and it reads again at a break's end too.
    func testFollowsTheBlockBetweenReads() {
        let running = status(phase: "focus", now: 0, endsAt: 30 * 60_000)
        XCTAssertEqual(FocusMusicView.phaseText(running, now: 16 * 60_000), "14 min left")
        XCTAssertEqual(FocusMusicView.phaseText(running, now: 31 * 60_000), "Running")
        XCTAssertEqual(FocusMusicPlayer.nextCheckSeconds(status(phase: "break", now: 0, endsAt: 4_000)), 5, accuracy: 0.001)
    }

    /// The Start button names the long break when this block earns it, as the server will.
    func testStartButtonNamesTheLongBreak() throws {
        func read(_ completed: Int, endedAgoMs: Double) throws -> RhythmFocusStatus {
            let json = """
            {"now":10000000,"focus":{"phase":"idle","endsAt":null,"completedInCycle":\(completed),"lastRun":{"startedAt":1,"endedAt":\(10_000_000 - endedAgoMs)}},
             "config":{"focusMinutes":25,"breakMinutes":5,"longBreakMinutes":15,"longBreakEvery":4}}
            """
            return try JSONDecoder().decode(RhythmFocusStatus.self, from: Data(json.utf8))
        }
        XCTAssertEqual(FocusMusicView.thenText(try read(3, endedAgoMs: 60_000), breakMinutes: 5, now: 10_000_000), "then the 15 min long break")
        XCTAssertEqual(FocusMusicView.thenText(try read(1, endedAgoMs: 60_000), breakMinutes: 7, now: 10_000_000), "then a 7 min break")
        // Idle over two hours: a fresh cycle, so block 1 of 4.
        XCTAssertEqual(FocusMusicView.thenText(try read(3, endedAgoMs: 3 * 3_600_000), breakMinutes: 5, now: 10_000_000), "then a 5 min break")
        // An older Rhythm without these fields: the plain break.
        XCTAssertEqual(FocusMusicView.thenText(status(phase: "idle", now: 0, endsAt: 0), breakMinutes: 5, now: 0), "then a 5 min break")
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

    // MARK: - Start: lengths and music

    func testStartChoiceStoresAsOneStringAndReadsBack() {
        for choice in [FocusStartChoice.none, .track("01 Brown Noise.m4a"), .spotify("spotify:playlist:37i9dQZF1DWZeKCadgRdKQ")] {
            XCTAssertEqual(FocusStartChoice(stored: choice.stored), choice)
        }
        XCTAssertNil(FocusStartChoice(stored: nil))
        XCTAssertNil(FocusStartChoice(stored: "track:"))
        XCTAssertNil(FocusStartChoice(stored: "spotify:not-a-uri"))
    }

    func testStartChoiceFallsBackToWhatStartCanKeep() throws {
        let listing = try decodeListing(spotifyAvailable: true)
        // First time: the setting picks the current track, or nothing.
        XCTAssertEqual(FocusStartChoice.resolve(stored: nil, listing: listing, trackID: nil, withFocus: true), .track("01 Brown Noise.m4a"))
        XCTAssertEqual(FocusStartChoice.resolve(stored: nil, listing: listing, trackID: nil, withFocus: false), FocusStartChoice.none)
        // A track that left the folder: the current one. A playlist removed, or Spotify gone: nothing.
        XCTAssertEqual(FocusStartChoice.resolve(stored: .track("gone.m4a"), listing: listing, trackID: nil, withFocus: false), .track("01 Brown Noise.m4a"))
        XCTAssertEqual(FocusStartChoice.resolve(stored: .spotify("spotify:playlist:AAAAAAAAAAAA"), listing: listing, trackID: nil, withFocus: true), FocusStartChoice.none)
        let deep = FocusStartChoice.spotify("spotify:playlist:37i9dQZF1DWZeKCadgRdKQ")
        XCTAssertEqual(FocusStartChoice.resolve(stored: deep, listing: listing, trackID: nil, withFocus: true), deep)
        let noSpotify = try decodeListing(spotifyAvailable: false)
        XCTAssertEqual(FocusStartChoice.resolve(stored: deep, listing: noSpotify, trackID: nil, withFocus: true), FocusStartChoice.none)
        // Not loaded yet: the pick stands.
        XCTAssertEqual(FocusStartChoice.resolve(stored: deep, listing: nil, trackID: nil, withFocus: true), deep)
    }

    func testThePlaysLineSaysWhatAndWhere() throws {
        let listing = try decodeListing(spotifyAvailable: true)
        XCTAssertEqual(FocusMusicView.playsText(.track("01 Brown Noise.m4a"), listing: listing), "Start plays Brown Noise on this phone, until the block ends.")
        XCTAssertEqual(FocusMusicView.playsText(.spotify("spotify:playlist:37i9dQZF1DWZeKCadgRdKQ"), listing: listing), "Start plays Deep Focus in Spotify on your Mac, until the block ends.")
        XCTAssertEqual(FocusMusicView.playsText(.none, listing: listing), "Start plays no music.")
    }

    func testStartArgsUseTheOpsNames() throws {
        let data = try JSONEncoder().encode(RhythmStartArgs(minutes: 50, breakMinutes: 10, spotify: "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ", remember: true))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["minutes"] as? Int, 50)
        XCTAssertEqual(object["breakMinutes"] as? Int, 10)
        XCTAssertEqual(object["spotify"] as? String, "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ")
        XCTAssertEqual(object["remember"] as? Bool, true)
    }

    func testAnOlderRhythmWithoutSpotifyStillDecodes() throws {
        let json = #"{"folder":"/f","isDefault":true,"exists":true,"tracks":[],"skipped":[],"withFocus":true}"#
        let listing = try JSONDecoder().decode(RhythmMusicListing.self, from: Data(json.utf8))
        XCTAssertNil(listing.spotify)
    }

    private func decodeListing(spotifyAvailable: Bool) throws -> RhythmMusicListing {
        let json = """
        {"folder":"/f","isDefault":true,"exists":true,"skipped":[],"withFocus":true,
         "tracks":[{"id":"01 Brown Noise.m4a","title":"Brown Noise","file":"/f/01 Brown Noise.m4a","bytes":10,"type":"audio/mp4"}],
         "spotify":{"available":\(spotifyAvailable),"playlists":[{"uri":"spotify:playlist:37i9dQZF1DWZeKCadgRdKQ","name":"Deep Focus"}]}}
        """
        return try JSONDecoder().decode(RhythmMusicListing.self, from: Data(json.utf8))
    }

    private func status(phase: String, now: Double, endsAt: Double) -> RhythmFocusStatus {
        RhythmFocusStatus(now: now, focus: .init(phase: phase, endsAt: endsAt, title: nil), config: nil)
    }
}
