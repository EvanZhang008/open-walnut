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
    /// Bumped by each silent stand-in, so a late one never ends a newer one.
    @ObservationIgnored private var silentRun = 0

    func toggle(_ id: String, url: URL) {
        if playingID == id { return stop() }
        stop()
        if AudioSilence.isOn {
            playSilently(id, url: url)
            return
        }
        guard let player = try? AVAudioPlayer(contentsOf: url) else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        player.delegate = self
        guard player.play() else { return }
        self.player = player
        playingID = id
    }

    /// Where a test or an agent runs the app (`AudioSilence`): the take shows as
    /// playing for as long as it lasts, and no session or player opens.
    private func playSilently(_ id: String, url: URL) {
        guard let seconds = AudioSilence.seconds(of: url) else { return }
        silentRun += 1
        let run = silentRun
        playingID = id
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(NoticeTiming.seconds(seconds)))
            guard let self, self.silentRun == run, self.playingID == id else { return }
            self.stop()
        }
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
