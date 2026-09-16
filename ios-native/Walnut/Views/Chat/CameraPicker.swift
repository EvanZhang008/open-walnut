import SwiftUI
import UIKit

/// The system camera as a SwiftUI view: the composer's `+` → Take Photo presents
/// this full screen, and a kept shot goes straight into the SAME attachment path
/// a library pick uses (`SelectedImage.make(from: UIImage)` → the composer's
/// shared merge). Nothing downstream can tell a capture from a pick.
///
/// `UIImagePickerController` rather than an AVFoundation capture session of our
/// own, and rather than `PHPickerViewController` (which has no camera source at
/// all). The picker brings the whole shutter/review/retake UI, and it is the same
/// control the note editor's photo menu already shoots through
/// (`AccessoryBar.takePhoto`), so the two capture surfaces in this app behave
/// identically.
///
/// `allowsEditing = false`: no crop step. The composer downscales to 1568px and
/// re-encodes anyway, so an editing pass would only add a screen between the
/// shutter and the message — and `.editedImage` would then be the key carrying
/// the result, which is exactly the sort of split the shared path exists to avoid.
///
/// PERMISSION IS THE PICKER'S JOB on the undecided path: presenting it is what
/// raises the system prompt, so the composer deliberately does not pre-ask. Only
/// an already-DENIED state is intercepted before presentation (a picker presented
/// then shows a black frame with no explanation) — see
/// `ComposerBar.cameraTapOutcome`.
struct CameraPicker: UIViewControllerRepresentable {
    /// A shot the user KEPT. `allowsEditing` is off, so `.originalImage` is the
    /// only key that can carry it.
    let onCapture: (UIImage) -> Void
    /// Cancel. There is nothing to restore on this path: the draft and the
    /// existing attachments were never touched, so this only lowers the cover.
    let onCancel: () -> Void

    /// Is there a camera to open at all? When there isn't, the menu item is HIDDEN
    /// rather than disabled: an item that can never do anything reads as a broken
    /// app.
    ///
    /// NOT a simulator check, and worth saying because the folklore says otherwise:
    /// measured on the iPhone 16 Pro simulator (iOS 26) this answers TRUE and the
    /// picker really does present (a grey viewfinder with a live shutter, flash and
    /// camera-flip). So "hidden here" is a claim about hardware, not about
    /// simulators, and nothing should be written as if the two were the same.
    static var isAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        // Guarded by the caller (`ComposerBar.cameraTapOutcome`) — setting
        // `.camera` on hardware that has none is a UIKit assertion failure, so the
        // fallback here is the library rather than a crash.
        picker.sourceType = Self.isAvailable ? .camera : .photoLibrary
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {
        // The callbacks are captured once, at coordinator build time, and the
        // picker owns its own state — nothing to push on an update.
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onCancel: onCancel)
    }

    /// The delegate. NOT the thing that dismisses: the cover is driven by the
    /// composer's `@State`, so both callbacks lower that flag and the
    /// presentation ends the way SwiftUI expects. Calling
    /// `picker.dismiss(animated:)` here as well would race the cover's own
    /// dismissal and can leave the flag true with no picker on screen.
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let onCapture: (UIImage) -> Void
        private let onCancel: () -> Void

        init(onCapture: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage else {
                // Nothing usable came back. Treat it as a cancel rather than
                // leaving the cover up with no way out.
                onCancel()
                return
            }
            onCapture(image)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}
