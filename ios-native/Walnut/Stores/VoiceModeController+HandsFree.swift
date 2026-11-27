import Foundation

/// Hands-free voice mode: listen, hear the pause, send, read the answer, listen again.
///
///   listening ──(speech, then a 1.2 s pause)──▶ transcribing ──(words)──▶ waiting
///       ▲   │ (a tap before any words, a minute of quiet, a failure)             │
///       │   └──────────────▶ paused ──(a tap)──▶ listening                       ▼
///       └────────────(the answer was read, or the turn had nothing to read)── speaking
///
/// The same shape as the web's voice conversation (web/src/voice/conversation-machine.ts),
/// with one difference the phone forces: the mic is off while the answer is read, because
/// the speaker would be heard as speech. A tap of the mic (or Stop) ends the reading and
/// listens.
extension VoiceModeController {
    static let monitorTick: Duration = .milliseconds(100)

    /// Voice mode was turned on: start listening, unless an answer is on its way.
    func begin() {
        guard handsFree else { return }
        listensOnItsOwn = true
        resumeIfQuiet()
    }

    /// What the status line and the box show while hands-free pauses.
    var pausedByPerson: Bool { handsFree && !listensOnItsOwn }

    /// Listen again when nothing else is going on: no take, no voice, no answer due.
    func resumeIfQuiet() {
        guard mayListenOnItsOwn, recorder.state == .idle, !startingTake else { return }
        Task { await startTake(fromTap: false) }
    }

    /// Nothing stands in the way of listening on its own. Read again once the mic is
    /// open, because the speaker or the person may have moved while it opened.
    private var mayListenOnItsOwn: Bool {
        handsFree && listensOnItsOwn && !pausedForAway && isAppActive()
            && !speaker.isSpeaking && !speakingSoon && !awaitingAnswer
    }

    func handsFreeMicTapped() async {
        switch recorder.state {
        case .transcribing:
            return
        case .recording:
            if detector.hasSpeech {
                // Done talking before the pause came: send now.
                await finishTake()
            } else {
                // Nothing said yet: the tap pauses listening.
                dropTake()
                listensOnItsOwn = false
            }
        case .idle:
            listensOnItsOwn = true
            speakingFollow?.cancel()
            speakingSoon = false
            speaker.stop(handoff: true)
            await startTake(fromTap: true)
        }
    }

    /// Drop the take in progress, nothing sent.
    func dropTake() {
        stopMonitor()
        liveWords.clear()
        if recorder.state == .recording { recorder.cancel() }
    }

    /// `fromTap`: the person asked to talk, so an answer on its way or being read
    /// gives way; on its own it listens only when nothing else is going on.
    private func startTake(fromTap: Bool) async {
        guard recorder.state == .idle, !startingTake else { return }
        guard fromTap ? handsFree && listensOnItsOwn && isAppActive() : mayListenOnItsOwn else { return }
        startingTake = true
        defer { startingTake = false }
        speaker.stop(handoff: true)
        let started = await openMic()
        guard started else {
            listensOnItsOwn = false
            notice = recorder.errorMessage ?? "Couldn't start the microphone."
            return
        }
        // Turned off, the app left, or an answer started while the mic was opening:
        // the answer has the audio session, so the take gives way.
        guard listensOnItsOwn, !pausedForAway, isAppActive(), !speaker.isSpeaking, !speakingSoon else {
            dropTake()
            return
        }
        var detector = TalkPauseDetector()
        detector.sendsOnPause = true
        detector.pauseToSend = pauseToSendSeconds
        detector.noSpeechTimeout = quietPauseSeconds
        self.detector = detector
        startMonitor(since: Date())
        // An answer that ended while the mic opened was left for now: read it
        // (the take has heard nothing yet, so it gives way).
        startingTake = false
        evaluate(now: Date())
    }

    private func openMic() async -> Bool {
        if let micOpener { return await micOpener() }
        #if DEBUG
        if let path = TalkDebug.replayFile {
            // The file stands in for the microphone's sound only; the session is
            // switched on as a real take does it, except in a silent run
            // (`AudioSilence`), which switches nothing on.
            if await recorder.activateForReplay() != nil { return false }
            return recorder._beginReplayTake(source: URL(fileURLWithPath: path))
        }
        #endif
        return await recorder.start()
    }

    /// Read the take's loudness from `since` on. The start is set here, after the old
    /// loop is stopped: `stopMonitor` clears it, and a loop with no start ends at once.
    private func startMonitor(since: Date) {
        stopMonitor()
        takeStartedAt = since
        monitor = Task { @MainActor [weak self] in
            var unread = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.monitorTick)
                guard !Task.isCancelled, let self, let since = self.takeStartedAt else { return }
                guard self.recorder.state == .recording else {
                    // Stopped under the take (a call, Siri) and not by this loop: the
                    // recorder kept its audio. Listening waits for a tap.
                    self.listensOnItsOwn = false
                    return
                }
                guard let level = self.recorder.liveLevel() else {
                    // Stopped under the take (a call): the recorder kept it.
                    unread += 1
                    if unread >= 5 { self.listensOnItsOwn = false; return }
                    continue
                }
                unread = 0
                let elapsed = Date().timeIntervalSince(since)
                let decision = self.detector.feed(level: level, at: elapsed)
                if self.detector.hasSpeech != self.takeHeardSpeech { self.takeHeardSpeech = self.detector.hasSpeech }
                self.liveWords.tick(
                    takeURL: self.recorder.liveTakeURL, heardSpeech: self.detector.hasSpeech, elapsed: elapsed
                )
                switch decision {
                case .keepListening:
                    continue
                case .pauseAfterSpeech, .tooLong:
                    AppLog.info("voice-mode", "a pause sends the take", [
                        "seconds": String(Int(elapsed)), "source": decision == .tooLong ? "max-duration" : "pause",
                    ])
                    Task { await self.finishTake() }
                case .noSpeech:
                    AppLog.info("voice-mode", "listening paused after a quiet minute", [:])
                    self.dropTake()
                    self.listensOnItsOwn = false
                }
                return
            }
        }
    }

    func stopMonitor() {
        monitor?.cancel()
        monitor = nil
        takeStartedAt = nil
        if takeHeardSpeech { takeHeardSpeech = false }
    }

    /// The speaker was asked to read: listen again once it is quiet.
    func followSpeaking() {
        speakingFollow?.cancel()
        speakingFollow = Task { @MainActor [weak self] in
            // The speaker reports speaking from its first word; give it a moment.
            try? await Task.sleep(for: .milliseconds(150))
            while !Task.isCancelled, let self, self.speaker.isSpeaking {
                try? await Task.sleep(for: .milliseconds(150))
            }
            guard !Task.isCancelled, let self else { return }
            self.speakingSoon = false
            self.resumeIfQuiet()
        }
    }

    /// Walnut leaves the front: a take nobody spoke into is dropped and listening
    /// waits for the return; words already said are sent.
    func appWillResign() {
        guard handsFree, listensOnItsOwn else { return }
        pausedForAway = true
        guard recorder.state == .recording else { return }
        if detector.hasSpeech {
            Task { await finishTake() }
        } else {
            dropTake()
        }
    }
}
