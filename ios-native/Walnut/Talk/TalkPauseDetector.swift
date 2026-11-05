import Foundation

/// Decides when a Talk to Walnut take is over, from the microphone's loudness.
///
/// The person presses the Action Button and talks; nobody looks at the screen.
/// So the take ends by itself on a pause after speech, and gives up on its own
/// when nothing was said at all. Pure value logic: fed one level reading at a
/// time (`feed`), it answers what to do, which is what the unit tests drive.
///
/// The threshold follows the room: the quietest stretch heard so far is the
/// noise floor, and speech is anything clearly above it. A fixed dB line
/// either missed soft speech in a quiet room or never heard a pause on a street.
struct TalkPauseDetector {
    enum Decision: Equatable {
        case keepListening
        /// Speech came and then a pause: send what was said.
        case pauseAfterSpeech
        /// Nothing that sounded like speech in `noSpeechTimeout`.
        case noSpeech
        /// The take reached `maxDuration`: send it as it is.
        case tooLong
    }

    /// How long a quiet stretch after speech ends the take. Long enough for a
    /// breath between two sentences, short enough to feel immediate.
    var pauseToSend: TimeInterval = 1.8
    var noSpeechTimeout: TimeInterval = 8
    var maxDuration: TimeInterval = 300
    /// Speech must stand this far above the noise floor.
    var speechMarginDB: Float = 12
    /// Never call anything quieter than this speech, however silent the room.
    var minSpeechDB: Float = -50
    /// Loud enough is speech, whatever the floor did (a noisy room's floor
    /// creeps up while someone talks without a gap).
    var surelySpeechDB: Float = -22
    /// Speech must add up to this much before a pause can end the take, so a
    /// cough or a door does not send an empty sentence.
    var minSpeech: TimeInterval = 0.3
    /// The floor the threshold uses is never above this: someone who starts
    /// talking at once makes their own voice the first "quiet" reading, and a
    /// floor that high would call normal speech (-30 dBFS) silence.
    var floorCapDB: Float = -42

    private(set) var floorDB: Float?
    private(set) var heardSpeech: TimeInterval = 0
    /// The loudest reading so far: a take that never counted as speech but was
    /// not silent either is still worth transcribing.
    private(set) var loudestDB: Float = -160
    private var lastTime: TimeInterval?
    private var quietSince: TimeInterval?

    var hasSpeech: Bool { heardSpeech >= minSpeech }

    var thresholdDB: Float {
        let floor = min(floorDB ?? minSpeechDB - speechMarginDB, floorCapDB)
        return min(max(floor + speechMarginDB, minSpeechDB), surelySpeechDB)
    }

    /// Anything above the quietest speech was heard, speech or not.
    var heardSomething: Bool { loudestDB >= minSpeechDB }

    /// One reading: `level` in dBFS at `time` seconds into the take.
    mutating func feed(level: Float, at time: TimeInterval) -> Decision {
        let step = lastTime.map { max(0, min(time - $0, 0.5)) } ?? 0
        lastTime = time
        let reading = level.isFinite ? max(level, -160) : -160
        loudestDB = max(loudestDB, reading)
        // The floor drops at once to a quieter reading and rises slowly, so a
        // long sentence does not lift it to the speech itself.
        if let floor = floorDB {
            floorDB = reading < floor ? reading : floor + min(reading - floor, 0.5) * Float(step)
        } else {
            floorDB = reading
        }
        if reading >= thresholdDB {
            heardSpeech += step
            quietSince = nil
        } else if quietSince == nil {
            quietSince = time
        }
        if time >= maxDuration { return .tooLong }
        if hasSpeech, let quiet = quietSince, time - quiet >= pauseToSend { return .pauseAfterSpeech }
        if !hasSpeech, time >= noSpeechTimeout { return .noSpeech }
        return .keepListening
    }
}
