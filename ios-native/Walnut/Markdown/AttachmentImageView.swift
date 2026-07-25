import SwiftUI
import UIKit
import ImageIO

private enum AttachmentLimits {
    static let memoryBytes = 64 * 1024 * 1024
    static let networkBytes = 30 * 1024 * 1024
    static let diskHighWaterBytes = 256 * 1024 * 1024
    static let diskTargetBytes = 192 * 1024 * 1024
    static let decodeMaxPixelSize = 3_000
    /// Pathological source dimensions (decompression bombs, giant scans) are
    /// rejected from the metadata BEFORE any raster is materialized. The
    /// thumbnail API still has to touch the full image to build the thumbnail,
    /// so a 30MB file that decodes to gigapixels would spike memory hard enough
    /// to get the app jetsammed. Mirrors SelectedImage.maxSourcePixels.
    static let maxSourcePixels = 100_000_000
}

/// Stops oversized responses at the headers or as soon as a lying/absent
/// Content-Length crosses the byte cap, before a giant Data is materialized.
private final class CappedDownloadDelegate: NSObject, URLSessionDataDelegate {
    private let maxBytes: Int
    private var continuation: CheckedContinuation<(Data, HTTPURLResponse)?, Never>?
    private var response: HTTPURLResponse?
    private var buffer = Data()
    private var session: URLSession?
    private var finished = false

    init(maxBytes: Int) {
        self.maxBytes = maxBytes
    }

    func fetch(_ request: URLRequest) async -> (Data, HTTPURLResponse)? {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
            self.session = session
            session.dataTask(with: request).resume()
        }
    }

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            completionHandler(.cancel)
            finish(nil)
            return
        }
        let length = response.expectedContentLength
        guard length <= 0 || length <= Int64(maxBytes) else {
            completionHandler(.cancel)
            finish(nil)
            return
        }
        self.response = http
        if length > 0 { buffer.reserveCapacity(Int(length)) }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard data.count <= maxBytes - buffer.count else {
            dataTask.cancel()
            finish(nil)
            return
        }
        buffer.append(data)
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
    ) {
        guard error == nil, let response else {
            finish(nil)
            return
        }
        finish((buffer, response))
    }

    private func finish(_ value: (Data, HTTPURLResponse)?) {
        guard !finished else { return }
        finished = true
        continuation?.resume(returning: value)
        continuation = nil
        session?.invalidateAndCancel()
        session = nil
    }
}

/// Which session's images we're currently rendering — lets the media endpoint
/// route a remote-host fetch (the cloud box needs to know WHICH daemon holds
/// the file). Set by SessionConversationView on appear, cleared on disappear.
@MainActor
enum MediaContext {
    static var currentSessionID: String?
}

/// Fetches vault attachments with the Bearer header (AsyncImage can't send
/// headers). Two-tier cache: in-memory NSCache + Caches/ on disk.
@MainActor
final class AttachmentLoader {
    static let shared = AttachmentLoader()

    private let memory = NSCache<NSString, UIImage>()
    private var inflight: [String: Task<UIImage?, Never>] = [:]

    private init() {
        memory.totalCostLimit = AttachmentLimits.memoryBytes
    }

    private var diskDirectory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("WalnutAttachments", isDirectory: true)
    }

    private func diskURL(for raw: String) -> URL {
        let safe = raw.replacingOccurrences(of: "/", with: "_")
        return diskDirectory.appendingPathComponent(safe)
    }

    /// Route a raw image reference to the URL that can actually serve it:
    /// external URLs load directly, absolute paths (chat/session images on a
    /// Walnut box) go through /api/v1/media, vault-relative names through the
    /// notes attachment endpoint. Wrong routing was why chat pictures never
    /// rendered — every path was tried against the notes vault and 404ed.
    private static func resolvedURL(for raw: String) -> (url: URL, needsAuth: Bool)? {
        if raw.hasPrefix("http://") || raw.hasPrefix("https://") {
            guard let url = URL(string: raw) else { return nil }
            return (url, false)
        }
        if raw.hasPrefix("/") {
            guard let url = WalnutAPI.mediaURL(absolutePath: raw, sessionID: MediaContext.currentSessionID) else { return nil }
            return (url, true)
        }
        guard let url = WalnutAPI.attachmentURL(rawPath: raw) else { return nil }
        return (url, true)
    }

    func image(for raw: String) async -> UIImage? {
        if let cached = memory.object(forKey: raw as NSString) { return cached }
        if let running = inflight[raw] { return await running.value }

        let resolved = Self.resolvedURL(for: raw)
        let token = resolved?.needsAuth == true ? AppConfig.token : nil
        let task = Task.detached(priority: .userInitiated) { [diskURL = diskURL(for: raw), diskDirectory] in
            await Self.loadImage(resolved: resolved, token: token, diskURL: diskURL, diskDirectory: diskDirectory)
        }
        inflight[raw] = task
        let image = await task.value
        inflight[raw] = nil
        if let image {
            memory.setObject(image, forKey: raw as NSString, cost: Self.decodedCost(image))
        }
        return image
    }

    /// Seed the cache with an image the caller just uploaded, so the editor's
    /// placeholder resolves instantly instead of round-tripping the fetch.
    func seed(_ image: UIImage, for raw: String) {
        memory.setObject(image, forKey: raw as NSString, cost: Self.decodedCost(image))
        guard let data = image.jpegData(compressionQuality: 0.9) else { return }
        let directory = diskDirectory
        let url = diskURL(for: raw)
        Task.detached(priority: .utility) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
            Self.trimDiskCache(in: directory)
        }
    }

    private nonisolated static func loadImage(
        resolved: (url: URL, needsAuth: Bool)?, token: String?, diskURL: URL, diskDirectory: URL
    ) async -> UIImage? {
        if let data = try? Data(contentsOf: diskURL), let image = downsample(data) {
            return image
        }
        guard let resolved else { return nil }
        var request = URLRequest(url: resolved.url)
        if resolved.needsAuth {
            guard let token else { return nil }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        guard let (data, _) = await CappedDownloadDelegate(maxBytes: AttachmentLimits.networkBytes).fetch(request),
              let image = downsample(data)
        else { return nil }
        try? FileManager.default.createDirectory(at: diskDirectory, withIntermediateDirectories: true)
        try? data.write(to: diskURL, options: .atomic)
        trimDiskCache(in: diskDirectory)
        return image
    }

    private nonisolated static func downsample(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              sourcePixelCount(source) <= AttachmentLimits.maxSourcePixels
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: AttachmentLimits.decodeMaxPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: cgImage, scale: 1, orientation: .up)
    }

    /// Source pixel count from metadata only (no decode). `.max` when the
    /// dimensions are unreadable, so an unparseable header is rejected.
    private nonisolated static func sourcePixelCount(_ source: CGImageSource) -> Int {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
        else { return .max }
        let (pixels, overflow) = width.intValue.multipliedReportingOverflow(by: height.intValue)
        return overflow ? .max : pixels
    }

    private nonisolated static func decodedCost(_ image: UIImage) -> Int {
        Int(image.size.width * image.scale * image.size.height * image.scale * 4)
    }

    private nonisolated static func trimDiskCache(in directory: URL) {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles]
        ) else { return }
        var total = 0
        var entries: [(url: URL, size: Int, modified: Date)] = []
        for url in files {
            guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else { continue }
            let size = values.fileSize ?? 0
            total += size
            entries.append((url, size, values.contentModificationDate ?? .distantPast))
        }
        guard total > AttachmentLimits.diskHighWaterBytes else { return }
        for entry in entries.sorted(by: { $0.modified < $1.modified }) {
            try? FileManager.default.removeItem(at: entry.url)
            total -= entry.size
            if total <= AttachmentLimits.diskTargetBytes { break }
        }
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
