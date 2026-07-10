import SwiftUI
import UIKit

/// Fetches vault attachments with the Bearer header (AsyncImage can't send
/// headers). Two-tier cache: in-memory NSCache + Caches/ on disk.
@MainActor
final class AttachmentLoader {
    static let shared = AttachmentLoader()

    private let memory = NSCache<NSString, UIImage>()
    private var inflight: [String: Task<UIImage?, Never>] = [:]

    private var diskDirectory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("WalnutAttachments", isDirectory: true)
    }

    private func diskURL(for raw: String) -> URL {
        let safe = raw.replacingOccurrences(of: "/", with: "_")
        return diskDirectory.appendingPathComponent(safe)
    }

    func image(for raw: String) async -> UIImage? {
        if let cached = memory.object(forKey: raw as NSString) { return cached }
        if let running = inflight[raw] { return await running.value }

        let task = Task<UIImage?, Never> { [diskURL = diskURL(for: raw), diskDirectory] in
            // Disk hit — decode off the main actor.
            if let data = try? Data(contentsOf: diskURL), let image = UIImage(data: data) {
                return image
            }
            guard let url = WalnutAPI.attachmentURL(rawPath: raw),
                  let token = AppConfig.token else { return nil }
            var request = URLRequest(url: url)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let image = UIImage(data: data) else { return nil }
            try? FileManager.default.createDirectory(at: diskDirectory, withIntermediateDirectories: true)
            try? data.write(to: diskURL, options: .atomic)
            return image
        }
        inflight[raw] = task
        let image = await task.value
        inflight[raw] = nil
        if let image { memory.setObject(image, forKey: raw as NSString) }
        return image
    }

    /// Seed the cache with an image the caller just uploaded, so the editor's
    /// placeholder resolves instantly instead of round-tripping the fetch.
    func seed(_ image: UIImage, for raw: String) {
        memory.setObject(image, forKey: raw as NSString)
        guard let data = image.jpegData(compressionQuality: 0.9) else { return }
        try? FileManager.default.createDirectory(at: diskDirectory, withIntermediateDirectories: true)
        try? data.write(to: diskURL(for: raw), options: .atomic)
    }
}

/// Full-width rounded attachment image, Apple Notes style. Tap → zoomable
/// full-screen viewer.
struct AttachmentImageView: View {
    let raw: String
    let alt: String

    @State private var image: UIImage?
    @State private var failed = false
    @State private var showViewer = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .onTapGesture { showViewer = true }
                    .fullScreenCover(isPresented: $showViewer) {
                        ImageViewer(image: image)
                    }
            } else if failed {
                HStack(spacing: 6) {
                    Image(systemName: "photo.badge.exclamationmark")
                    Text(alt.isEmpty ? "Image unavailable" : alt)
                        .lineLimit(1)
                }
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            } else {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(.secondarySystemBackground))
                    .frame(height: 180)
                    .overlay { ProgressView() }
            }
        }
        .task(id: raw) {
            if let loaded = await AttachmentLoader.shared.image(for: raw) {
                image = loaded
            } else {
                failed = true
            }
        }
    }
}

/// Full-screen image viewer: pinch zoom, pan when zoomed, drag-down dismiss.
struct ImageViewer: View {
    let image: UIImage
    @Environment(\.dismiss) private var dismiss

    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    @State private var dismissDrag: CGFloat = 0

    var body: some View {
        ZStack {
            Color.black
                .ignoresSafeArea()
                .opacity(max(0.4, 1 - Double(abs(dismissDrag)) / 400))

            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .scaleEffect(scale)
                .offset(x: offset.width, y: offset.height + dismissDrag)
                .gesture(magnification.simultaneously(with: scale > 1.01 ? panGesture : nil))
                .gesture(scale <= 1.01 ? dismissGesture : nil)
                .onTapGesture(count: 2) {
                    withAnimation(.snappy) {
                        if scale > 1.01 {
                            scale = 1; lastScale = 1; offset = .zero; lastOffset = .zero
                        } else {
                            scale = 2.5; lastScale = 2.5
                        }
                    }
                }
        }
        .overlay(alignment: .topTrailing) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title)
                    .foregroundStyle(.white.opacity(0.8))
                    .padding()
            }
        }
        .statusBarHidden()
    }

    private var magnification: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                scale = max(1, min(6, lastScale * value.magnification))
            }
            .onEnded { _ in
                lastScale = scale
                if scale <= 1.05 {
                    withAnimation(.snappy) { scale = 1; lastScale = 1; offset = .zero; lastOffset = .zero }
                }
            }
    }

    private var panGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                offset = CGSize(
                    width: lastOffset.width + value.translation.width,
                    height: lastOffset.height + value.translation.height
                )
            }
            .onEnded { _ in lastOffset = offset }
    }

    private var dismissGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                dismissDrag = value.translation.height
            }
            .onEnded { value in
                if abs(value.translation.height) > 120 {
                    dismiss()
                } else {
                    withAnimation(.snappy) { dismissDrag = 0 }
                }
            }
    }
}
