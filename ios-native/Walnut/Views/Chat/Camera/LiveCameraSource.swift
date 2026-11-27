import AVFoundation
import UIKit

/// The device's cameras for the composer's camera (`CameraSource`).
///
/// REAL-DEVICE ONLY: nothing in this file runs in the simulator (there is no
/// capture device; `CameraSources.make` gives the simulator `FakeCameraSource`),
/// so the unit tests and the screenshots never reach it. What only a device
/// shows: the permission prompts, the picture, a photo taken while a recording
/// runs, the flip, the sound, and the portrait rotation of what is saved.
///
/// One `AVCaptureSession` with a photo output beside a movie output: that pair
/// is what lets a photo be taken without stopping the video, which the system
/// picker (`UIImagePickerController`) cannot do. The microphone joins the session
/// only for a recording with sound, and leaves it when the recording stops. All
/// session work runs on one serial queue, as Apple asks. A call, another app or a
/// camera fault (`AVCaptureSession`'s interruption and runtime error
/// notifications) is told to the model through `onInterruption`, so a recording
/// never keeps its clock running on a stopped camera.
@MainActor
final class LiveCameraSource: NSObject, CameraSource {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "walnut.camera.session")
    private let photoOutput = AVCapturePhotoOutput()
    private let movieOutput = AVCaptureMovieFileOutput()
    private var videoInput: AVCaptureDeviceInput?
    private var audioInput: AVCaptureDeviceInput?
    private let preview = CameraPreviewView()
    private var photoWaits: [Int64: PhotoWait] = [:]
    private var recordingWait: RecordingWait?
    private(set) var position: AVCaptureDevice.Position = .back
    var onInterruption: ((CameraInterruption) -> Void)?
    private let observers = NotificationTokens()

    /// Listen for the session's interruptions and errors, once (from the first `start`).
    private func observeSession() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        let tell: @MainActor (CameraInterruption) -> Void = { [weak self] event in self?.onInterruption?(event) }
        observers.add(center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: .main) { note in
            let raw = note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int
            let why = Self.interruptionWords(raw.flatMap(AVCaptureSession.InterruptionReason.init(rawValue:)))
            MainActor.assumeIsolated { tell(.began(why)) }
        })
        observers.add(center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: .main) { _ in
            MainActor.assumeIsolated { tell(.ended) }
        })
        observers.add(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main) { note in
            let error = note.userInfo?[AVCaptureSessionErrorKey] as? Error
            let why = error?.localizedDescription ?? "The camera stopped."
            MainActor.assumeIsolated { tell(.failed(why)) }
        })
    }

    /// Why the camera paused, in the panel's words.
    nonisolated static func interruptionWords(_ reason: AVCaptureSession.InterruptionReason?) -> String {
        guard let reason else { return "The camera paused." }
        switch reason {
        case .audioDeviceInUseByAnotherClient: return "The microphone is in use by a call or another app."
        case .videoDeviceInUseByAnotherClient: return "Another app is using the camera."
        case .videoDeviceNotAvailableWithMultipleForegroundApps: return "The camera is off while another app shares the screen."
        case .videoDeviceNotAvailableDueToSystemPressure: return "The camera paused: the phone is under heavy load."
        default: return "The camera paused."
        }
    }

    var previewView: UIView { preview }

    var canFlip: Bool { Self.device(position == .back ? .front : .back) != nil }

    static func device(_ position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
    }

    /// Run `work` on the session queue and wait for it. Nonisolated: `work` runs
    /// off the main actor, so it is `@Sendable` and touches only what it was handed.
    nonisolated private func onQueue<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: Result { try work() }) }
        }
    }

    func start() async throws {
        guard let device = Self.device(position) ?? AVCaptureDevice.default(for: .video) else { throw CameraSourceError.noCamera }
        observeSession()
        let input = try AVCaptureDeviceInput(device: device)
        let session = session, photoOutput = photoOutput, movieOutput = movieOutput
        try await onQueue {
            session.beginConfiguration()
            defer { session.commitConfiguration() }
            // `.high`, not `.photo`: the photo preset takes no movie output.
            if session.canSetSessionPreset(.high) { session.sessionPreset = .high }
            for old in session.inputs { session.removeInput(old) }
            guard session.canAddInput(input) else { throw CameraSourceError.failed("The camera could not be opened.") }
            session.addInput(input)
            if !session.outputs.contains(photoOutput), session.canAddOutput(photoOutput) { session.addOutput(photoOutput) }
            if !session.outputs.contains(movieOutput), session.canAddOutput(movieOutput) { session.addOutput(movieOutput) }
            // A backstop a little past the model's own one-minute stop.
            movieOutput.maxRecordedDuration = CMTime(seconds: 61, preferredTimescale: 600)
        }
        videoInput = input
        position = device.position
        preview.previewLayer.session = session
        preview.previewLayer.videoGravity = .resizeAspectFill
        try await onQueue {
            Self.portrait(photoOutput.connection(with: .video))
            Self.portrait(movieOutput.connection(with: .video))
            if !session.isRunning { session.startRunning() }
        }
        Self.portrait(preview.previewLayer.connection)
    }

    /// What is saved stands the way the phone is held in this portrait-only view.
    nonisolated private static func portrait(_ connection: AVCaptureConnection?) {
        guard let connection, connection.isVideoRotationAngleSupported(90) else { return }
        connection.videoRotationAngle = 90
    }

    func stop() {
        let session = session, movieOutput = movieOutput
        queue.async {
            if movieOutput.isRecording { movieOutput.stopRecording() }
            if session.isRunning { session.stopRunning() }
            session.beginConfiguration()
            for input in session.inputs { session.removeInput(input) }
            session.commitConfiguration()
        }
        audioInput = nil
        videoInput = nil
    }

    func flip() async throws {
        guard let next = Self.device(position == .back ? .front : .back) else { return }
        let input = try AVCaptureDeviceInput(device: next)
        let session = session, old = videoInput, photoOutput = photoOutput, movieOutput = movieOutput
        try await onQueue {
            session.beginConfiguration()
            defer { session.commitConfiguration() }
            if let old { session.removeInput(old) }
            guard session.canAddInput(input) else {
                if let old, session.canAddInput(old) { session.addInput(old) }
                throw CameraSourceError.failed("That camera could not be opened.")
            }
            session.addInput(input)
            Self.portrait(photoOutput.connection(with: .video))
            Self.portrait(movieOutput.connection(with: .video))
        }
        videoInput = input
        position = next.position
        Self.portrait(preview.previewLayer.connection)
    }

    func takePhoto() async throws -> UIImage {
        guard videoInput != nil else { throw CameraSourceError.notRunning }
        let settings = AVCapturePhotoSettings()
        // A silent run (`AudioSilence`) takes the picture without the shutter sound, wherever
        // iOS allows that (some places' law forbids it, and iOS then plays it regardless).
        if AudioSilence.isOn, photoOutput.isShutterSoundSuppressionSupported {
            settings.isShutterSoundSuppressionEnabled = true
        }
        let wait = PhotoWait()
        photoWaits[settings.uniqueID] = wait
        defer { photoWaits[settings.uniqueID] = nil }
        let photoOutput = photoOutput
        return try await withCheckedThrowingContinuation { continuation in
            wait.done = { continuation.resume(with: $0) }
            queue.async { photoOutput.capturePhoto(with: settings, delegate: wait) }
        }
    }

    func startRecording(to url: URL, sound: Bool) async throws -> Bool {
        guard videoInput != nil else { throw CameraSourceError.notRunning }
        var withSound = false
        // A silent run (`AudioSilence`) records the picture only: the microphone never opens.
        if sound, !AudioSilence.isOn, await AVCaptureDevice.requestAccess(for: .audio), let mic = AVCaptureDevice.default(for: .audio),
           let input = try? AVCaptureDeviceInput(device: mic) {
            let session = session
            withSound = (try? await onQueue { () -> Bool in
                session.beginConfiguration()
                defer { session.commitConfiguration() }
                guard session.canAddInput(input) else { return false }
                session.addInput(input)
                return true
            }) ?? false
            if withSound { audioInput = input }
        }
        let wait = RecordingWait()
        recordingWait = wait
        let movieOutput = movieOutput
        try await onQueue {
            Self.portrait(movieOutput.connection(with: .video))
            movieOutput.startRecording(to: url, recordingDelegate: wait)
        }
        return withSound
    }

    func stopRecording() async throws -> URL {
        guard let wait = recordingWait else { throw CameraSourceError.notRunning }
        let movieOutput = movieOutput
        let url = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            wait.onFinish { continuation.resume(with: $0) }
            queue.async { if movieOutput.isRecording { movieOutput.stopRecording() } }
        }
        recordingWait = nil
        // The microphone leaves with the recording.
        if let mic = audioInput {
            let session = session
            queue.async {
                session.beginConfiguration()
                session.removeInput(mic)
                session.commitConfiguration()
            }
            audioInput = nil
        }
        return url
    }
}

/// The layer the live picture is drawn in.
final class CameraPreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

/// One photo's delegate, kept until its photo arrives.
private final class PhotoWait: NSObject, AVCapturePhotoCaptureDelegate {
    var done: ((Result<UIImage, Error>) -> Void)?

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let result: Result<UIImage, Error>
        if let error {
            result = .failure(error)
        } else if let data = photo.fileDataRepresentation(), let image = UIImage(data: data) {
            result = .success(image)
        } else {
            result = .failure(CameraSourceError.failed("The photo could not be read."))
        }
        DispatchQueue.main.async { [self] in
            done?(result)
            done = nil
        }
    }
}

/// A recording's delegate: the finished file, whenever it ends (stopped, or at
/// the backstop's maximum, which still leaves a whole file).
private final class RecordingWait: NSObject, AVCaptureFileOutputRecordingDelegate {
    private var result: Result<URL, Error>?
    private var waiter: ((Result<URL, Error>) -> Void)?

    /// Called on the main queue, once, with the result (at once if it is in).
    func onFinish(_ body: @escaping (Result<URL, Error>) -> Void) {
        if let result { body(result) } else { waiter = body }
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo url: URL,
                    from connections: [AVCaptureConnection], error: Error?) {
        let finished = (error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool
        let outcome: Result<URL, Error> = error == nil || finished == true ? .success(url) : .failure(error!)
        DispatchQueue.main.async { [self] in
            if let waiter { waiter(outcome); self.waiter = nil } else { result = outcome }
        }
    }
}

/// Notification observers removed when their owner goes.
private final class NotificationTokens {
    private var tokens: [NSObjectProtocol] = []

    var isEmpty: Bool { tokens.isEmpty }

    func add(_ token: NSObjectProtocol) { tokens.append(token) }

    deinit { tokens.forEach(NotificationCenter.default.removeObserver) }
}
