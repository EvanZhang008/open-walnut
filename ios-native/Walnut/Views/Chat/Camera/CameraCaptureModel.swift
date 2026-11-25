import AVFoundation
import Observation
import UIKit

/// What the composer's camera does, apart from how it looks (`CameraCaptureView`):
/// Photo or Video, a recording of at most a minute that can take photos while it
/// runs, and the camera off whenever it is not on screen. What is taken goes
/// straight into the composer's attachments (2026-11-22, as the web's
/// `CameraDock`): a photo the moment the shutter is pressed, a video once its
/// words are in. The camera stays open for the next one; the composer's own Send
/// sends them. A video the composer refused stays here until it is added or
/// discarded, so a minute's recording is never lost. It drives a `CameraSource`,
/// so the same model runs the device's cameras and the simulator's fake one.
@MainActor
@Observable
final class CameraCaptureModel {
    enum Mode: String, CaseIterable { case photo, video }

    enum Stage: Equatable {
        /// Asking for the camera or starting it.
        case starting
        case live
        case recording
        /// The recording stopped; its stills and narration are being made, then it
        /// goes into the composer by itself.
        case finishing
        /// The composer refused the video (its file limit): it is held here
        /// (`heldClip`) until it is added or discarded; no new recording meanwhile.
        case notAdded
        /// Camera access is off (`CameraCaptureView` says how to turn it on).
        case denied
        case failed(String)
    }

    /// What the composer gets from the camera.
    struct Actions {
        /// A photo for the composer's attachments (the composer's own merge, its
        /// five-photo ceiling and notice included); false when it did not take it.
        var addPhoto: (UIImage) async -> Bool = { _ in true }
        /// A recorded video, its stills and narration, for the attachments; false
        /// when the message has no room for another file (nothing is attached).
        var addClip: (CameraClipMaker.Clip) -> Bool = { _ in true }
        var close: () -> Void = {}
        /// Camera access is off: attach from the library or Files instead.
        var pickFile: () -> Void = {}
        /// How many more photos the message takes.
        var photoRoom: () -> Int = { 5 }
        /// The names the message already holds, so a video's name is its own.
        var takenNames: () -> Set<String> = { [] }
        /// What was said in a finished video's file: its sound through the
        /// server's speech to text (`CameraClipMaker.narrate`).
        var narrate: @Sendable (URL) async -> CameraClipMaker.Narration = { url in
            await CameraClipMaker.narrate(url) { data in
                try await WalnutAPI().transcribe(audio: data, format: "m4a")
            }
        }
    }

    /// The experiment that turns this camera on (src/core/experimental.ts); off,
    /// `+` → Take Photo opens the system camera as before.
    static let experimentID = "camera_capture"

    /// The longest recording, and when its countdown shows.
    static let maxSeconds: TimeInterval = 60
    static let countdownFrom: TimeInterval = 50

    /// A video's narration note when the person did not wait for its words.
    static let wordsSkippedNote = "words skipped"

    let source: CameraSource
    let allowsVideo: Bool
    @ObservationIgnored var actions: Actions

    var mode: Mode = .photo
    private(set) var stage: Stage = .starting
    /// Sound for the next recording; on by default (a whiteboard is explained aloud).
    var soundOn = true
    /// Whether the recording running now has sound (the mic can be refused).
    private(set) var recordingHasSound = false
    private(set) var elapsed: TimeInterval = 0
    /// A short line over the picture (why a photo was not added), cleared after a moment.
    private(set) var notice: String?
    /// What this camera put in the message since it opened (`addedLabel`).
    private(set) var photosAdded = 0
    private(set) var videosAdded = 0
    /// The video the composer refused (`.notAdded`), its copies kept until it is
    /// added or discarded.
    private(set) var heldClip: CameraClipMaker.Clip?
    private(set) var busy = false

    @ObservationIgnored private var recordingStartedAt: Date?
    /// The folder the recording is written in, until its clip is made or dropped.
    @ObservationIgnored private var recordingDir: URL?
    /// The source was stopped (the app left the screen, or it failed): it starts
    /// again before the picture is live.
    @ObservationIgnored private var sourceStopped = false
    /// The app is off the screen: nothing starts the camera until it is back.
    @ObservationIgnored private var away = false
    /// The panel closed: a clip still being made goes in without its words.
    @ObservationIgnored private var closed = false
    /// Making the stopped recording's clip (its stills and speech to text); its
    /// own task, so neither a caller's cancellation nor a close cuts it short.
    @ObservationIgnored private var finishing: Task<Void, Never>?
    /// The stopped recording's speech to text, and the wait for it that either
    /// its answer or "Skip the words" ends (`wordsIn`, whichever comes first).
    @ObservationIgnored private var wordsTask: Task<Void, Never>?
    @ObservationIgnored private var wordsWait: CheckedContinuation<CameraClipMaker.Narration, Never>?
    /// Which recording's words the wait is for: a skipped recording's late
    /// answer never ends the next recording's wait.
    @ObservationIgnored private var wordsGen: UUID?
    /// The person skipped the words of the recording being finished.
    @ObservationIgnored private var wordsSkipped = false
    @ObservationIgnored private var clock: Task<Void, Never>?
    @ObservationIgnored private var noticeClear: Task<Void, Never>?
    @ObservationIgnored private let now: () -> Date

    init(source: CameraSource, allowsVideo: Bool, actions: Actions = Actions(), now: @escaping () -> Date = Date.init) {
        self.source = source
        self.allowsVideo = allowsVideo
        self.actions = actions
        self.now = now
        source.onInterruption = { [weak self] event in
            Task { await self?.interrupted(event) }
        }
    }

    // MARK: - Pure rules

    /// The timer pill while recording: "0:23", and from 50 s on, how much is left.
    static func timerLabel(elapsed: TimeInterval) -> String {
        let clock = AttachmentHeaders.clipClock(ms: Int(elapsed * 1000))
        guard elapsed >= countdownFrom else { return clock }
        let left = max(0, Int((maxSeconds - elapsed).rounded(.up)))
        return "\(clock) \u{00B7} \(left)s left"
    }

    /// Whether a recording this long stops by itself now.
    static func reachedLimit(_ elapsed: TimeInterval) -> Bool { elapsed >= maxSeconds }

    /// What this camera put in the message: "2 photos added", "1 photo and 1
    /// video added"; nil before anything (the web's `addedLabel`).
    static func addedLabel(photos: Int, videos: Int) -> String? {
        var parts: [String] = []
        if photos > 0 { parts.append(photos == 1 ? "1 photo" : "\(photos) photos") }
        if videos > 0 { parts.append(videos == 1 ? "1 video" : "\(videos) videos") }
        return parts.isEmpty ? nil : parts.joined(separator: " and ") + " added"
    }

    var addedLabel: String? { Self.addedLabel(photos: photosAdded, videos: videosAdded) }

    // MARK: - Lifecycle

    /// The view is on screen: ask for the camera (the system asks once) and start it.
    func appear() async {
        guard stage == .starting || stage == .live else { return }
        stage = .starting
        if CameraSources.needsPermission {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: break
            case .notDetermined:
                guard await AVCaptureDevice.requestAccess(for: .video) else { stage = .denied; return }
            default:
                stage = .denied
                return
            }
        }
        do {
            try await source.start()
            sourceStopped = false
            stage = .live
        } catch {
            sourceStopped = true
            stage = .failed(error.localizedDescription)
        }
    }

    /// The app left the screen: the camera stops at once, before anything else.
    /// A recording ends and goes into the composer (never sent by itself), its
    /// stills and words made with the camera already off; the picture starts
    /// again on return.
    func sceneLeft() async {
        away = true
        source.stop()
        sourceStopped = true
        if stage == .recording { await stopRecording() }
    }

    func sceneReturned() async {
        away = false
        switch stage {
        case .live, .starting:
            stage = .starting
            await appear()
        case .notAdded where sourceStopped:
            // The picture behind the held video; it was granted already.
            do {
                try await source.start()
                sourceStopped = false
            } catch {
                // Started again once the video is added or discarded (`backToLive`).
            }
        default:
            // A recording being finished goes back to the picture by itself (`backToLive`).
            break
        }
    }

    /// The system took the camera away or gave it back (`CameraInterruption`).
    func interrupted(_ event: CameraInterruption) async {
        switch event {
        case .began(let why):
            // Leaving the screen stopped the camera already (`sceneLeft`).
            guard !away else { return }
            // A call or another app: the recording ends (and is added), never on with a stopped camera.
            if stage == .recording { await stopRecording() }
            say(why)
        case .ended:
            // The session starts again by itself.
            break
        case .failed(let why):
            AppLog.warn("camera", "camera stopped", ["error": why])
            sourceStopped = true
            if stage == .recording {
                await stopRecording()
            } else if stage == .live || stage == .starting {
                await backToLive()
            }
        }
    }

    /// Close: the camera stops; what was added stays in the composer. A video
    /// being finished still goes in, without waiting for its words (its stills
    /// are made first when they are not yet); only one the composer refused
    /// (`.notAdded`) is dropped.
    func close() {
        closed = true
        clock?.cancel()
        source.stop()
        if stage == .finishing { skipWords() }
        dropHeldClip()
        // A clip being made still reads its recording; it removes the folder when done.
        if stage != .finishing { removeRecordingDir() }
        actions.close()
    }

    // MARK: - Taking

    func shutter() async {
        // Stop always ends a recording, even while a photo is being taken during
        // it: that photo still lands (or fails) by itself.
        if stage == .recording { await stopRecording(); return }
        guard !busy else { return }
        switch (mode, stage) {
        case (.photo, .live):
            await addPhoto()
        case (.video, .live):
            await startRecording()
        default:
            break
        }
    }

    /// A photo while the video keeps recording, as any photo: straight in.
    func photoWhileRecording() async {
        guard stage == .recording, !busy else { return }
        await addPhoto()
    }

    /// A photo straight into the composer's attachments; the camera stays on.
    private func addPhoto() async {
        guard actions.photoRoom() > 0 else { say("This message already has \(ComposerBar.maxImages) photos."); return }
        busy = true
        defer { busy = false }
        do {
            let image = try await source.takePhoto()
            // Only a photo the composer took counts; a refused one says why there.
            guard await actions.addPhoto(image) else { say("The photo was not added."); return }
            photosAdded += 1
        } catch {
            say("The photo could not be taken.")
        }
    }

    func flip() async {
        guard stage == .live, !busy else { return }
        try? await source.flip()
    }

    private func startRecording() async {
        busy = true
        defer { busy = false }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("camera-" + UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            recordingDir = dir
            recordingHasSound = try await source.startRecording(to: dir.appendingPathComponent("recording.mov"), sound: soundOn)
        } catch {
            removeRecordingDir()
            say("The recording could not start.")
            return
        }
        if soundOn && !recordingHasSound { say("Recording without sound: the microphone is off for Walnut.") }
        recordingStartedAt = now()
        elapsed = 0
        stage = .recording
        clock?.cancel()
        clock = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, !Task.isCancelled, self.stage == .recording, let started = self.recordingStartedAt else { return }
                self.elapsed = self.now().timeIntervalSince(started)
                // A minute at most: it stops and is added, never sent by itself.
                // Stopped from a task of its own: stopRecording cancels this clock
                // (its clip is made in `finishing`, which no caller's cancellation reaches).
                if Self.reachedLimit(self.elapsed) {
                    Task { await self.stopRecording() }
                    return
                }
            }
        }
    }

    private func stopRecording() async {
        guard stage == .recording else { return }
        clock?.cancel()
        stage = .finishing
        wordsSkipped = false
        let work = Task { await self.finishRecording() }
        finishing = work
        await work.value
        finishing = nil
    }

    private func finishRecording() async {
        defer { removeRecordingDir() }
        let made: CameraClipMaker.Clip
        do {
            let url = try await source.stopRecording()
            let name = CameraClipMaker.videoName(at: recordingStartedAt ?? now(), ext: "mov", taken: actions.takenNames())
            made = try await CameraClipMaker.make(recording: url, name: name)
        } catch {
            guard !closed else { return }
            await backToLive()
            say("The video could not be saved.")
            return
        }
        await deliver(made.narrated(await words(for: made)))
    }

    /// What was said in the clip: its speech to text, or at once when the person
    /// skips the words (`skipWords`) or the camera closes.
    private func words(for clip: CameraClipMaker.Clip) async -> CameraClipMaker.Narration {
        if wordsSkipped || closed { return .none(note: Self.wordsSkippedNote) }
        let url = clip.video.localURL
        let narrate = actions.narrate
        let gen = UUID()
        return await withCheckedContinuation { wait in
            wordsWait = wait
            wordsGen = gen
            wordsTask = Task { @MainActor in
                let narration = await narrate(url)
                self.wordsIn(narration, for: gen)
            }
        }
    }

    /// The words of recording `gen` are in, or skipped: the first of these ends
    /// that recording's wait, and nothing ends another's.
    private func wordsIn(_ narration: CameraClipMaker.Narration, for gen: UUID?) {
        guard let gen, gen == wordsGen, let wait = wordsWait else { return }
        wordsGen = nil
        wordsWait = nil
        wordsTask = nil
        wait.resume(returning: narration)
    }

    /// "Skip the words": the video goes in now, without what was said.
    func skipWords() {
        guard stage == .finishing else { return }
        wordsSkipped = true
        wordsTask?.cancel()
        wordsIn(.none(note: Self.wordsSkippedNote), for: wordsGen)
    }

    /// Into the composer; one it refuses is held (`.notAdded`) rather than lost.
    private func deliver(_ clip: CameraClipMaker.Clip) async {
        if actions.addClip(clip) {
            videosAdded += 1
            // Closed meanwhile: the camera stays off.
            if !closed { await backToLive() }
        } else if closed {
            // Refused after the camera closed: nothing is left to hold it.
            AppLog.warn("camera", "video not added after the camera closed", ["reason": "no room for another file"])
            clip.files.forEach(ComposerFileStore.remove)
        } else {
            heldClip = clip
            stage = .notAdded
            say("This message has no room for another file.")
        }
    }

    private func removeRecordingDir() {
        guard let dir = recordingDir else { return }
        recordingDir = nil
        try? FileManager.default.removeItem(at: dir)
    }

    /// The live picture again, starting the camera first when it was stopped
    /// (once the app is back on the screen, when it is away now).
    private func backToLive() async {
        if sourceStopped {
            stage = .starting
            if !away { await appear() }
        } else {
            stage = .live
        }
    }

    // MARK: - A video the composer refused

    /// "Add the video": try the composer again (a file taken off it makes room).
    func addHeldClip() async {
        guard stage == .notAdded, let clip = heldClip else { return }
        heldClip = nil
        await deliver(clip)
    }

    /// "Discard it": the held video and its copies go; the picture is live again.
    func discardHeldClip() async {
        guard stage == .notAdded else { return }
        dropHeldClip()
        await backToLive()
    }

    private func dropHeldClip() {
        heldClip?.files.forEach(ComposerFileStore.remove)
        heldClip = nil
    }

    private func say(_ text: String) {
        notice = text
        noticeClear?.cancel()
        noticeClear = NoticeTiming.after(2.5) { [weak self] in self?.notice = nil }
    }
}
