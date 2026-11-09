import SwiftUI
import UIKit
import PhotosUI
import AVFoundation

/// Pictures for a box that writes to an AI outside the chat composer: a letter's
/// reply, a decision letter's note, a question's "Other" answer (2026-11-03, the
/// user: every box he types to an AI in "should be able to copy pictures").
///
/// The same sources and limits as the chat composer: Photos, Take Photo and Paste
/// all go through `ComposerBar.attach` (the 5-image ceiling and the total size
/// budget), so a picture this box takes is one the chat would take too.
struct ReplyPictureButton: View {
    @Binding var images: [SelectedImage]
    @Binding var notice: String?
    /// Accessibility identifier prefix: `<prefix>.attach`, `<prefix>.photos`, ...
    let idPrefix: String
    var disabled = false
    /// Put the keyboard away before a picker covers the box (the chat composer's
    /// rule: UIKit gives focus back to the field when the cover goes).
    var onWillPresent: () -> Void = {}

    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var pickerItems: [PhotosPickerItem] = []

    private var full: Bool { images.count >= ComposerBar.maxImages }

    var body: some View {
        Menu {
            Button {
                onWillPresent()
                showPhotos = true
            } label: {
                Label(ComposerBar.attachmentSourceLabel("Photos", attached: images.count), systemImage: "photo.on.rectangle")
            }
            .accessibilityIdentifier("\(idPrefix).photos")
            if CameraPicker.isAvailable {
                Button { takePhoto() } label: {
                    Label(ComposerBar.attachmentSourceLabel("Take Photo", attached: images.count), systemImage: "camera")
                }
                .accessibilityIdentifier("\(idPrefix).camera")
            }
            Button { Task { await pasteFromClipboard() } } label: {
                Label("Paste Image", systemImage: "doc.on.clipboard")
            }
            .accessibilityIdentifier("\(idPrefix).paste")
        } label: {
            Image(systemName: "photo.badge.plus")
                // The menu's own label is read from this image, not the menu: name it too.
                .accessibilityLabel(images.isEmpty ? "Add a picture" : "Add a picture, \(images.count) attached")
                .font(.system(size: 19))
                .frame(width: 40, height: 44)
                .contentShape(Rectangle())
        }
        .disabled(disabled || full)
        .accessibilityLabel(images.isEmpty ? "Add a picture" : "Add a picture, \(images.count) attached")
        .accessibilityIdentifier("\(idPrefix).attach")
        .photosPicker(
            isPresented: $showPhotos, selection: $pickerItems,
            maxSelectionCount: max(1, ComposerBar.maxImages - images.count), matching: .images
        )
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            pickerItems = []
            Task { await load(items) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker(
                onCapture: { image in
                    showCamera = false
                    Task { await add([image]) }
                },
                onCancel: { showCamera = false }
            )
            .ignoresSafeArea()
            // A photo being taken (or taken and not yet used) is nowhere else: a push waits
            // until he uses or cancels it (2026-11-08 review, round 3).
            .holdsNavigation()
        }
    }

    private func takePhoto() {
        switch ComposerBar.cameraTapOutcome(
            available: CameraPicker.isAvailable,
            authorization: AVCaptureDevice.authorizationStatus(for: .video)
        ) {
        case .present:
            onWillPresent()
            showCamera = true
        case .notice(let text):
            notice = text
        }
    }

    private func load(_ items: [PhotosPickerItem]) async {
        var loaded: [SelectedImage.LoadResult] = []
        for item in items { loaded.append(await SelectedImage.load(from: item)) }
        merge(loaded)
    }

    private func pasteFromClipboard() async {
        let pictures = await ReplyPictures.clipboardImages()
        guard !pictures.isEmpty else {
            notice = "The clipboard holds no picture."
            return
        }
        await add(pictures)
    }

    private func add(_ pictures: [UIImage]) async {
        merge(await ReplyPictures.make(pictures))
    }

    private func merge(_ loaded: [SelectedImage.LoadResult]) {
        let outcome = ComposerBar.attach(loaded, to: images)
        images = outcome.images
        // This attach's own word, or none: an older notice (an empty clipboard) is out of date.
        notice = outcome.notice
        AppLog.info("composer", "reply pictures attached", [
            "box": idPrefix, "count": String(outcome.images.count),
        ])
    }
}

/// The picked pictures as removable thumbnails, and the sentence for any that
/// were skipped. Draws nothing when there is neither.
struct ReplyPictureStrip: View {
    @Binding var images: [SelectedImage]
    @Binding var notice: String?
    let idPrefix: String
    var size: CGFloat = 56

    var body: some View {
        if !images.isEmpty || notice != nil {
            VStack(alignment: .leading, spacing: 6) {
                if !images.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(images) { image in
                                ZStack(alignment: .topTrailing) {
                                    Image(uiImage: image.thumbnail)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: size, height: size)
                                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                        .accessibilityLabel("Attached picture")
                                        .accessibilityIdentifier("\(idPrefix).picture")
                                    Button {
                                        images.removeAll { $0.id == image.id }
                                        notice = nil
                                    } label: {
                                        Image(systemName: ComposerBar.Symbol.removeImage)
                                            .font(.system(size: 18))
                                            .symbolRenderingMode(.palette)
                                            .foregroundStyle(.white, .black.opacity(0.55))
                                            .padding(3)
                                    }
                                    .accessibilityLabel("Remove photo")
                                    .accessibilityIdentifier("\(idPrefix).pictureRemove")
                                }
                            }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("\(idPrefix).pictures")
                }
                if let notice {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: ComposerBar.Symbol.imageNotice)
                        Text(notice).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 4)
                        Button { self.notice = nil } label: { Image(systemName: "xmark") }
                            .accessibilityLabel("Dismiss")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("\(idPrefix).pictureNotice")
                }
            }
        }
    }
}

enum ReplyPictures {
    /// The pictures on the clipboard (a screenshot, a copied photo). The simulator
    /// sometimes hands an image over only as an item provider (`WysiwygEditor.paste`).
    @MainActor
    static func clipboardImages() async -> [UIImage] {
        let pasteboard = UIPasteboard.general
        if pasteboard.hasImages, let images = pasteboard.images, !images.isEmpty { return images }
        var found: [UIImage] = []
        for provider in pasteboard.itemProviders where provider.canLoadObject(ofClass: UIImage.self) {
            let image: UIImage? = await withCheckedContinuation { done in
                provider.loadObject(ofClass: UIImage.self) { object, _ in done.resume(returning: object as? UIImage) }
            }
            if let image { found.append(image) }
        }
        return found
    }

    /// Downscale and encode off the main actor, as a library pick is.
    static func make(_ pictures: [UIImage]) async -> [SelectedImage.LoadResult] {
        await Task.detached(priority: .userInitiated) { pictures.map { SelectedImage.make(from: $0) } }.value
    }

    /// The one line a sent turn shows for the pictures that went with it.
    static func sentLine(_ count: Int) -> String? {
        switch count {
        case ..<1: return nil
        case 1: return "With a picture"
        default: return "With \(count) pictures"
        }
    }
}
