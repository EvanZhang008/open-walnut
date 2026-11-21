import AVFoundation
import Observation
import UIKit

/// What the composer's camera does, apart from how it looks (`CameraCaptureView`):
/// Photo or Video, a recording of at most a minute that can take photos while it
/// runs, a look at what was taken (Retake / Add another / Send), and the camera
/// off whenever it is not on screen. It drives a `CameraSource`, so the same
/// model runs the device's cameras and the simulator's fake one.
@MainActor
@Observable
final class CameraCaptureModel {
    enum Mode: String, CaseIterable { case photo, video }

    enum Stage: Equatable {
        /// Asking for the camera or starting it.
        case starting
        case live
        case recording
        /// The recording stopped; its stills and narration are being made.
        case finishing
        case preview
        /// Camera access is off (`CameraCaptureView` says how to turn it on).
        case denied
        case failed(String)
    }

    /// What was taken, shown for a look before it goes anywhere.
    enum Taken {
        case photo(UIImage)
        case video(CameraClipMaker.Clip, narration: CameraClipMaker.Narration, still: UIImage?)
    }

    /// What the composer gets from the camera.
    struct Actions {
        /// A photo for the composer's attachments (the composer's own merge, its
        /// five-photo ceiling and notice included); false when it did not take it.
        var addPhoto: (UIImage) async -> Bool = { _ in true }
        /// A recorded video, its stills and narration, for the attachments; false
        /// when the message has no room for another file (nothing is attached).
        var addClip: (CameraClipMaker.Clip) -> Bool = { _ in true }
        /// Send the composer's message (what is attached, with the typed words).
        var send: () -> Void = {}
        var close: () -> Void = {}
        /// Camera access is off: attach from the library or Files instead.
        var pickFile: () -> Void = {}
        /// How many more photos the message takes.
        var photoRoom: () -> Int = { 5 }
        /// The names the message already holds, so a video's name is its own.
        var takenNames: () -> Set<String> = { [] }
        /// The server's speech to text.
        var transcribe: @Sendable (Data) async throws -> String = { data in
            try await WalnutAPI().transcribe(audio: data, format: "m4a")
        }
    }

    /// The experiment that turns this camera on (src/core/experimental.ts); off,
    /// `+` → Take Photo opens the system camera as before.
    static let experimentID = "camera_capture"

    /// The longest recording, and when its countdown shows.
    static let maxSeconds: TimeInterval = 60
    static let countdownFrom: TimeInterval = 50

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
    private(set) var taken: Taken?
    /// A short line over the picture ("Photo added"), cleared after a moment.
    private(set) var notice: String?
    /// Photos taken during this recording.
    private(set) var photosWhileRecording = 0
    private(set) var busy = false

    @ObservationIgnored private var recordingStartedAt: Date?
    /// The folder the recording is written in, until its clip is made or dropped.
    @ObservationIgnored private var recordingDir: URL?
    /// The source was stopped (the app left the screen, or it failed): it starts
    /// again before the picture is live.
    @ObservationIgnored private var sourceStopped = false
    /// The app is off the screen: nothing starts the camera until it is back.
    @ObservationIgnored private var away = false
    /// The panel closed: a clip still being made is dropped when it is ready.
    @ObservationIgnored private var closed = false
    /// Making the stopped recording's clip (its stills and speech to text); its
    /// own task, so a caller's cancellation never cuts it short, and `close`
    /// cancels it so a dropped clip's sound is not sent anywhere.
    @ObservationIgnored private var finishing: Task<Void, Never>?
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
    /// A recording ends into its preview (never sent by itself), its stills and
    /// words made with the camera already off; the picture starts again on return,
    /// or when the person goes back to it from the preview.
    func sceneLeft() async {
        away = true
        source.stop()
        sourceStopped = true
        if stage == .recording { await stopRecording() }
    }

    func sceneReturned() async {
        away = false
        if stage == .live || stage == .starting { stage = .starting; await appear() }
    }

    /// The system took the camera away or gave it back (`CameraInterruption`).
    func interrupted(_ event: CameraInterruption) async {
        switch event {
        case .began(let why):
            // Leaving the screen stopped the camera already (`sceneLeft`).
            guard !away else { return }
            // A call or another app: the recording ends into its preview, never on with a stopped camera.
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

    /// Close: whatever was taken and not added goes, and the camera stops. A clip
    /// still being made is dropped when it is ready (`stopRecording`).
    func close() {
        closed = true
        clock?.cancel()
        finishing?.cancel()
        source.stop()
        discardTaken()
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
            busy = true
            defer { busy = false }
            do {
                taken = .photo(try await source.takePhoto())
                stage = .preview
            } catch {
                say("The photo could not be taken.")
            }
        case (.video, .live):
            await startRecording()
        default:
            break
        }
    }

    /// A photo while the video keeps recording: straight into the attachments.
    func photoWhileRecording() async {
        guard stage == .recording, !busy else { return }
        guard actions.photoRoom() > 0 else { say("This message already has \(ComposerBar.maxImages) photos."); return }
        busy = true
        defer { busy = false }
        do {
            let image = try await source.takePhoto()
            // Only a photo the composer took counts; a refused one says why there.
            guard await actions.addPhoto(image) else { say("The photo was not added."); return }
            photosWhileRecording += 1
            say(photosWhileRecording == 1 ? "Photo added" : "\(photosWhileRecording) photos added")
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
        photosWhileRecording = 0
        stage = .recording
        clock?.cancel()
        clock = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, !Task.isCancelled, self.stage == .recording, let started = self.recordingStartedAt else { return }
                self.elapsed = self.now().timeIntervalSince(started)
                // A minute at most: it stops into its preview, never sent by itself.
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
        let work = Task { await self.finishRecording() }
        finishing = work
        await work.value
        finishing = nil
    }

    private func finishRecording() async {
        defer { removeRecordingDir() }
        do {
            let url = try await source.stopRecording()
            let name = CameraClipMaker.videoName(at: recordingStartedAt ?? now(), ext: "mov", taken: actions.takenNames())
            let clip = try await CameraClipMaker.make(recording: url, name: name, transcribe: actions.transcribe)
            // Closed while it was made: nothing holds its copies any more.
            guard !closed else { clip.files.forEach(ComposerFileStore.remove); return }
            let narration: CameraClipMaker.Narration
            if case .video(_, let said?, _) = clip.video.clip { narration = .said(said) }
            else if case .video(_, _, let note?) = clip.video.clip { narration = .none(note: note) }
            else { narration = .none(note: "no narration") }
            // The first still is the recording's first frame.
            let still = clip.stills.first.flatMap { UIImage(contentsOfFile: $0.localURL.path) }
            taken = .video(clip, narration: narration, still: still)
            stage = .preview
        } catch {
            guard !closed else { return }
            await backToLive()
            say("The video could not be saved.")
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

    // MARK: - After the look

    func retake() async {
        discardTaken()
        await backToLive()
    }

    /// Into the composer's attachments; the camera stays open for the next one.
    func addAnother() async {
        guard await deliverTaken() else { return }
        await backToLive()
    }

    /// Into the attachments, then the composer's message goes with its typed words.
    func send() async {
        guard await deliverTaken() else { return }
        clock?.cancel()
        source.stop()
        actions.send()
    }

    private func deliverTaken() async -> Bool {
        guard stage == .preview, let taken, !busy else { return false }
        busy = true
        defer { busy = false }
        switch taken {
        case .photo(let image):
            guard actions.photoRoom() > 0 else { say("This message already has \(ComposerBar.maxImages) photos."); return false }
            guard await actions.addPhoto(image) else { say("The photo was not added."); return false }
        case .video(let clip, _, _):
            guard actions.addClip(clip) else {
                say("This message has no room for another file.")
                return false
            }
        }
        self.taken = nil
        return true
    }

    private func discardTaken() {
        if case .video(let clip, _, _) = taken { clip.files.forEach(ComposerFileStore.remove) }
        taken = nil
    }

    private func say(_ text: String) {
        notice = text
        noticeClear?.cancel()
        noticeClear = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }
}
