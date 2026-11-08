import AudioToolbox
import AVFoundation

/// A tap the person feels without looking: when listening starts, and when the
/// words reached the CEO chat. The phone is often in a pocket or a hand on the
/// Action Button, so the island alone is easy to miss. A failure has its own
/// cue already (the Live Activity's alert sound).
enum TalkCue: Equatable {
    case started
    case sent

    static func play(_ cue: TalkCue) {
        if AudioSilence.isOn { return }
        // iOS mutes haptics and system sounds while a session records unless
        // the session allows them.
        try? AVAudioSession.sharedInstance().setAllowHapticsAndSystemSoundsDuringRecording(true)
        // 1519 / 1520: the system's light and strong taps (haptic only).
        AudioServicesPlaySystemSound(cue == .started ? 1519 : 1520)
    }
}
