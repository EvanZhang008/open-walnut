import AVFoundation
import Observation

/// Plays one unsent recording back, so the person hears which take a Resend or
/// a Delete is about before it goes to the CEO chat. One plays at a time.
@Observable
@MainActor
final class TalkPlayback: NSObject, AVAudioPlayerDelegate {
    static let shared = TalkPlayback()

    /// The entry playing now, if any.
    private(set) var playingID: String?
    @ObservationIgnored private var player: AVAudioPlayer?

    func toggle(_ id: String, url: URL) {
        if playingID == id { return stop() }
        stop()
        guard let player = try? AVAudioPlayer(contentsOf: url) else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        player.delegate = self
        guard player.play() else { return }
        self.player = player
        playingID = id
    }

    func stop() {
        player?.stop()
        player = nil
        playingID = nil
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.stop() }
    }

    /// "6 s", "1 min 12 s": how long a take is.
    static func length(_ seconds: Double) -> String {
        let total = max(1, Int(seconds.rounded()))
        return total < 60 ? "\(total) s" : "\(total / 60) min \(total % 60) s"
    }
}
