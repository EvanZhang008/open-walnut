import AVFoundation
import UIKit

/// What the composer's camera (`CameraCaptureView`) drives: a live picture, a
/// photo, and a recording that can take photos while it runs. Two of them:
///
/// - `LiveCameraSource`: the device's cameras through `AVCaptureSession`
///   (AVCapturePhotoOutput beside AVCaptureMovieFileOutput, which the system
///   picker cannot do). Real-device only: a simulator has no capture device.
/// - `FakeCameraSource`: a drawn whiteboard and a short generated video, for the
///   simulator, the demo and the screenshots; it never touches a camera or a mic.
///
/// The view and its model only ever see this protocol.
@MainActor
protocol CameraSource: AnyObject {
    /// The view the live picture is drawn in (made once, kept by the source).
    var previewView: UIView { get }
    /// Whether there is another camera to flip to.
    var canFlip: Bool { get }
    var position: AVCaptureDevice.Position { get }
    /// Told when the system takes the camera away or gives it back, or the camera fails.
    var onInterruption: ((CameraInterruption) -> Void)? { get set }
    /// Start the picture. Throws `CameraSourceError` when there is no camera.
    func start() async throws
    /// Stop everything: the picture, a recording, the microphone. Safe to call twice.
    /// A recording it ended still answers its file to `stopRecording`.
    func stop()
    func flip() async throws
    func takePhoto() async throws -> UIImage
    /// Start recording into `url` (a .mov), with the microphone only when `sound`.
    /// Answers whether the recording has sound (the mic may be refused).
    func startRecording(to url: URL, sound: Bool) async throws -> Bool
    /// Stop the recording and answer the finished file.
    func stopRecording() async throws -> URL
}

/// The camera taken away by the system while the panel is open.
enum CameraInterruption: Equatable {
    /// A call, another app or the system's load paused it; why, in the panel's words.
    case began(String)
    /// It is back (the session starts again by itself).
    case ended
    /// It stopped with an error and must be started again.
    case failed(String)
}

enum CameraSourceError: LocalizedError {
    case noCamera
    case notRunning
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .noCamera: return "This device has no camera to use."
        case .notRunning: return "The camera is not running."
        case .failed(let why): return why
        }
    }
}

enum CameraSources {
    /// The source the composer's camera uses here: the fake one in the simulator
    /// (there is no camera to open) and under the screenshot harness, the live
    /// cameras on a device.
    @MainActor
    static func make() -> CameraSource {
        #if targetEnvironment(simulator)
        return FakeCameraSource()
        #else
        return CameraHarness.isOn ? FakeCameraSource() : LiveCameraSource()
        #endif
    }

    /// Whether the `+` menu offers the camera at all: always in the simulator
    /// (the fake source), on a device when it has a camera.
    static var isAvailable: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return AVCaptureDevice.default(for: .video) != nil
        #endif
    }

    /// Whether this source needs the system's camera permission (the fake does not).
    static var needsPermission: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return !CameraHarness.isOn
        #endif
    }
}
