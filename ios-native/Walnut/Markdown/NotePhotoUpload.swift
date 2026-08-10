import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// One picked/captured photo heading into the note's vault `_attachment/`.
enum NotePhotoSource {
    /// Library pick — bytes stay inside the provider until this item's turn,
    /// so a 10-photo selection never holds 10 full-resolution rasters at once.
    case provider(NSItemProvider)
    /// Camera capture — UIKit already decoded it; the only raster we hold.
    case captured(UIImage)
}

/// Sequential multi-photo upload for the note editor (photo menu: Take Photo /
/// Choose from Library). Design points:
/// - STRICTLY one photo in flight: load → downscale/JPEG-encode (off-main via
///   SelectedImage, same 1568px policy as chat) → upload → insert, then the
///   next. Peak memory is one raster + one JPEG regardless of selection size.
/// - Per-photo failure isolation: an upload error offers Retry / Skip for THAT
///   photo only; photos before and after insert normally.
/// - Progress toast ("Uploading n of N…") for multi-photo batches — non-modal,
///   so the retry alert never fights a presented progress controller.
extension WysiwygEditor.Coordinator {

    func uploadAndInsertBatch(_ sources: [NotePhotoSource], into textView: UITextView) {
        guard !sources.isEmpty else { return }
        let notePath = parent.notePath
        Task { @MainActor [weak self, weak textView] in
            guard let self, let textView else { return }
            let total = sources.count
            let toast: NoteUploadProgressToast? = total > 1
                ? NoteUploadProgressToast.show(over: textView) : nil
            defer { toast?.dismissToast() }
            var failures = 0
            for (index, source) in sources.enumerated() {
                // The editor screen may have been popped mid-batch — stop
                // uploading into a dead text view.
                guard textView.window != nil else { break }
                toast?.update(current: index + 1, total: total)
                let ok = await self.uploadOne(
                    source, position: index + 1, total: total,
                    notePath: notePath, textView: textView
                )
                if !ok { failures += 1 }
            }
            if failures > 0 {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
    }

    /// Load + prepare + upload + insert a single photo. Returns false when the
    /// photo was skipped (unreadable, over the size cap, or user chose Skip).
    @MainActor
    private func uploadOne(
        _ source: NotePhotoSource, position: Int, total: Int,
        notePath: String, textView: UITextView
    ) async -> Bool {
        // 1) Prepare off-main (decode-bounded downsample + JPEG). Done ONCE —
        //    retries below only repeat the network hop, not the encode.
        guard case .ok(let selected) = await Self.prepare(source),
              SelectedImage.base64Length(selected.jpegData) <= SelectedImage.maxUploadBase64Length
        else {
            await informSkipped(
                "Photo \(position) of \(total) couldn't be prepared within the 10 MB upload limit.",
                over: await stablePresenter(from: textView)
            )
            return false
        }
        // 2) Upload, with per-photo Retry / Skip on failure. A captured photo
        //    exists nowhere else, so silently dropping it is not an option.
        while true {
            do {
                let result = try await WalnutAPI().uploadAttachment(
                    notePath: notePath, data: selected.jpegData, mediaType: "image/jpeg"
                )
                insertImage(selected.thumbnail, into: textView, uploadedPath: result.path)
                return true
            } catch {
                AppLog.warn("notes", "attachment upload failed", [
                    "notePath": notePath,
                    "position": "\(position)/\(total)",
                    "error": String(describing: error),
                ])
                let retry = await askRetryOrSkip(
                    "Photo \(position) of \(total) didn't upload: \(error.localizedDescription)",
                    over: await stablePresenter(from: textView)
                )
                if !retry { return false }
            }
        }
    }

    /// Decode + downscale + encode, entirely off the MainActor. Library picks
    /// go through the Data path (CGImageSource thumbnailing — never
    /// materializes the full raster); camera hands us a decoded UIImage whose
    /// raster is capped by `SelectedImage.make(from: UIImage)`.
    nonisolated private static func prepare(_ source: NotePhotoSource) async -> SelectedImage.LoadResult {
        switch source {
        case .captured(let image):
            return await Task.detached(priority: .userInitiated) {
                SelectedImage.make(from: image)
            }.value
        case .provider(let provider):
            if let data = await loadImageData(from: provider) {
                return await Task.detached(priority: .userInitiated) {
                    SelectedImage.make(from: data)
                }.value
            }
            // Fallback: some providers only vend a decoded object.
            guard let image = await loadUIImage(from: provider) else { return .failed }
            return await Task.detached(priority: .userInitiated) {
                SelectedImage.make(from: image)
            }.value
        }
    }

    /// Raw bytes for the first registered image type (jpeg/heic/png/…) —
    /// CGImageSource downsamples from these without a full decode.
    nonisolated private static func loadImageData(from provider: NSItemProvider) async -> Data? {
        let imageType = provider.registeredTypeIdentifiers.first {
            UTType($0)?.conforms(to: .image) == true
        }
        guard let imageType else { return nil }
        return await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(forTypeIdentifier: imageType) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }

    nonisolated private static func loadUIImage(from provider: NSItemProvider) async -> UIImage? {
        guard provider.canLoadObject(ofClass: UIImage.self) else { return nil }
        return await withCheckedContinuation { continuation in
            provider.loadObject(ofClass: UIImage.self) { object, _ in
                continuation.resume(returning: object as? UIImage)
            }
        }
    }

    // MARK: - Alerts

    /// A presenter that can actually take a present() RIGHT NOW. The picker's
    /// dismiss(animated:) is still in flight when a fast failure (connection
    /// refused) reaches the alert path — presenting on a view controller that
    /// is mid-dismissal silently no-ops, which would leave the alert's
    /// continuation suspended forever and hang the whole batch.
    @MainActor
    private func stablePresenter(from view: UIView) async -> UIViewController? {
        for _ in 0..<30 { // ~3s ceiling
            if let top = topMostViewController(from: view),
               !top.isBeingDismissed, !top.isBeingPresented, top.view.window != nil {
                return top
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return topMostViewController(from: view)
    }

    @MainActor
    private func askRetryOrSkip(_ message: String, over presenter: UIViewController?) async -> Bool {
        guard let presenter else { return false }
        return await withCheckedContinuation { continuation in
            let alert = UIAlertController(
                title: "Photo Upload Failed", message: message, preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "Skip", style: .cancel) { _ in
                continuation.resume(returning: false)
            })
            alert.addAction(UIAlertAction(title: "Retry", style: .default) { _ in
                continuation.resume(returning: true)
            })
            presenter.present(alert, animated: true)
        }
    }

    @MainActor
    private func informSkipped(_ message: String, over presenter: UIViewController?) async {
        guard let presenter else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let alert = UIAlertController(
                title: "Photo Skipped", message: message, preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                continuation.resume()
            })
            presenter.present(alert, animated: true)
        }
    }
}

@MainActor
func topMostViewController(from view: UIView) -> UIViewController? {
    guard var top = view.window?.rootViewController else { return nil }
    while let presented = top.presentedViewController { top = presented }
    return top
}

/// Small non-modal "Uploading n of N…" capsule pinned near the top of the
/// screen. Non-interactive by design — the user can keep editing, and retry
/// alerts present freely because nothing modal is up.
@MainActor
final class NoteUploadProgressToast: UIView {
    private let label = UILabel()

    static func show(over view: UIView) -> NoteUploadProgressToast? {
        guard let window = view.window else { return nil }
        let toast = NoteUploadProgressToast()
        toast.translatesAutoresizingMaskIntoConstraints = false
        toast.isUserInteractionEnabled = false
        toast.accessibilityIdentifier = "note.uploadProgress"
        window.addSubview(toast)
        NSLayoutConstraint.activate([
            toast.centerXAnchor.constraint(equalTo: window.centerXAnchor),
            toast.topAnchor.constraint(equalTo: window.safeAreaLayoutGuide.topAnchor, constant: 8),
            toast.heightAnchor.constraint(equalToConstant: 36),
        ])
        return toast
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 18
        layer.cornerCurve = .continuous
        layer.borderWidth = 0.5
        layer.borderColor = UIColor.separator.withAlphaComponent(0.35).cgColor
        clipsToBounds = true

        let glass = AccessoryBar.glassView()
        glass.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glass)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.textColor = .label
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            glass.leadingAnchor.constraint(equalTo: leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            glass.topAnchor.constraint(equalTo: topAnchor),
            glass.bottomAnchor.constraint(equalTo: bottomAnchor),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func update(current: Int, total: Int) {
        label.text = "Uploading \(current) of \(total)…"
    }

    func dismissToast() {
        UIView.animate(withDuration: 0.2, animations: { self.alpha = 0 }) { _ in
            self.removeFromSuperview()
        }
    }
}
