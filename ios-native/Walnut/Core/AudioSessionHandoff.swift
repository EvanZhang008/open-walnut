import AVFoundation

/// One queue for every switch-off of the shared `AVAudioSession`.
///
/// Two things in the app now drive that one session: the recorder (`.record`) and
/// voice mode's speaker (`.playback`). Each switches it off after use, off the main
/// thread because `setActive(false)` is an IPC that can block. A switch-off that
/// lands AFTER the other one switched the session on silences it: the speaker's
/// late cleanup would end a recording that had just started. So both chain their
/// switch-offs here, and both wait for the chain before switching on.
@MainActor
enum AudioSessionHandoff {
    private static var pending: Task<Void, Never>?

    /// Queue a switch-off behind any earlier one. Other apps' audio (music the
    /// speaker ducked) resumes when it lands.
    static func deactivateOffMain() {
        let previous = pending
        pending = Task.detached(priority: .userInitiated) {
            await previous?.value
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// Wait for every queued switch-off before switching the session on.
    static func settle() async {
        await pending?.value
    }
}
