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
///
/// Cancellable and time-boxed: a 30MB download over a wedged connection used to
/// be unstoppable — `withCheckedContinuation` has no cancellation handler, so
/// the enclosing Task's cancellation (view dismissed, `.task(id:)` re-keyed,
/// store torn down) did nothing, and with `timeoutIntervalForRequest` at the
/// default 60s the delegate could sit on the socket long after the UI that
/// wanted the bytes was gone. Now the URLSessionTask is cancelled on Task
/// cancellation, and an outer deadline caps the whole fetch regardless.
private final class CappedDownloadDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let maxBytes: Int
    private let lock = NSLock()
    private var continuation: CheckedContinuation<(Data, HTTPURLResponse)?, Never>?
    private var response: HTTPURLResponse?
    private var buffer = Data()
    private var session: URLSession?
    private var dataTask: URLSessionDataTask?
    private var finished = false

    /// Whole-fetch deadline. Independent of URLSession's per-hop timeouts: a
    /// server that trickles bytes forever resets those and never trips them.
    private static let overallTimeout: TimeInterval = 60

    init(maxBytes: Int) {
        self.maxBytes = maxBytes
    }

    func fetch(_ request: URLRequest) async -> (Data, HTTPURLResponse)? {
        let result: (Data, HTTPURLResponse)? = await withTaskGroup(
            of: (Data, HTTPURLResponse)?.self
        ) { group in
            group.addTask { await self.run(request) }
            group.addTask {
                try? await Task.sleep(for: .seconds(Self.overallTimeout))
                // Deadline hit (or the group was cancelled): tear the transfer
                // down so the other child returns promptly.
                self.abort()
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            self.abort()
            return first
        }
        return result
    }

    private func run(_ request: URLRequest) async -> (Data, HTTPURLResponse)? {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                lock.lock()
                guard !finished else {
                    lock.unlock()
                    continuation.resume(returning: nil)
                    return
                }
                self.continuation = continuation
                let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
                self.session = session
                let task = session.dataTask(with: request)
                self.dataTask = task
                lock.unlock()
                task.resume()
            }
        } onCancel: {
            abort()
        }
    }

    /// Cancel the transfer and settle the continuation. Safe to call repeatedly
    /// and from any thread (cancellation handlers run off the caller's context).
    private func abort() {
        lock.lock()
        let task = dataTask
        lock.unlock()
        task?.cancel()
        finish(nil)
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
        lock.lock()
        let overflow = data.count > maxBytes - buffer.count
        if !overflow { buffer.append(data) }
        lock.unlock()
        if overflow {
            dataTask.cancel()
            finish(nil)
        }
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
    ) {
        lock.lock()
        let response = self.response
        let payload = buffer
        lock.unlock()
        guard error == nil, let response else {
            finish(nil)
            return
        }
        finish((payload, response))
    }

    private func finish(_ value: (Data, HTTPURLResponse)?) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let continuation = self.continuation
        self.continuation = nil
        let session = self.session
        self.session = nil
        dataTask = nil
        lock.unlock()
        continuation?.resume(returning: value)
        session?.invalidateAndCancel()
    }
}

/// Which session's images we're currently rendering — lets the media endpoint
/// route a remote-host fetch (the cloud box needs to know WHICH daemon holds
/// the file). Set by SessionConversationView on appear, cleared on disappear.
///
/// This is a single mutable global, so it is only ever safe to read at the
/// MOMENT a load is requested, on the MainActor. `AttachmentLoader.image(for:)`
/// snapshots it into a scope key and passes that down; nothing inside a detached
/// task may read it, or a fast navigation between two sessions would resolve the
/// URL for whichever session happened to be current when the task got scheduled.
@MainActor
enum MediaContext {
    static var currentSessionID: String?
    /// Vault path of the note currently on screen. Sent alongside a vault
    /// attachment request so the server can break duplicate-filename ties by
    /// proximity — the same read-at-request-time rule as `currentSessionID`.
    /// Set by NoteDetailView on appear, cleared on disappear.
    static var currentNotePath: String?
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

    /// Cache identity = (scope, path), NOT path alone.
    ///
    /// The same absolute path (`/tmp/screenshot.png`, `~/out.png`) exists on
    /// EVERY exec host, and GET /api/v1/media resolves it against whichever
    /// session was passed. Keying on the raw path made the first session's bytes
    /// answer every later session's request for the same path — a chat image
    /// showing up inside an unrelated session, and vice versa. Scope is the
    /// session id captured when the load was requested ("chat" for the chat tab
    /// and for vault attachments, which are host-independent).
    private static func scope(for raw: String, sessionID: String?, notePath: String?) -> String {
        if raw.hasPrefix("http://") || raw.hasPrefix("https://") { return "chat" }
        if raw.hasPrefix("/") {
            // Absolute paths are the host-dependent ones — scope by session.
            return sessionID?.isEmpty == false ? sessionID! : "chat"
        }
        // A vault-relative name is NOT host-dependent, but it IS note-dependent:
        // `Untitled 5.png` exists in seven different `_attachment/` folders here,
        // and the server now picks the copy nearest the embedding note. Caching
        // one name globally would hand note B whichever picture note A resolved
        // first — the same cross-contamination the session scope fixed for
        // absolute paths. Scope by the note's own DIRECTORY (not the note file),
        // since proximity resolution can only differ between directories.
        guard let notePath, !notePath.isEmpty else { return "chat" }
        let directory = (notePath as NSString).deletingLastPathComponent
        return directory.isEmpty ? "chat" : "note:\(directory)"
    }

    private static func cacheKey(_ raw: String, scope: String) -> String {
        "\(scope)\u{1}\(raw)"
    }

    private func diskURL(for key: String) -> URL {
        // `:` and `/` both appear in session ids and paths — flatten both.
        let safe = key
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\u{1}", with: "~")
            .replacingOccurrences(of: ":", with: "-")
        return diskDirectory.appendingPathComponent(safe)
    }

    /// Route a raw image reference to the URL that can actually serve it:
    /// external URLs load directly, absolute paths (chat/session images on a
    /// Walnut box) go through /api/v1/media, vault-relative names through the
    /// notes attachment endpoint. Wrong routing was why chat pictures never
    /// rendered — every path was tried against the notes vault and 404ed.
    /// `sessionID` is captured by the CALLER at request time — never read from
    /// MediaContext in here, see that type's comment.
    private static func resolvedURL(
        for raw: String, sessionID: String?, notePath: String?
    ) -> (url: URL, needsAuth: Bool)? {
        if raw.hasPrefix("http://") || raw.hasPrefix("https://") {
            guard let url = URL(string: raw) else { return nil }
            return (url, false)
        }
        if raw.hasPrefix("/") {
            guard let url = WalnutAPI.mediaURL(absolutePath: raw, sessionID: sessionID) else { return nil }
            return (url, true)
        }
        guard let url = WalnutAPI.attachmentURL(rawPath: raw, notePath: notePath) else { return nil }
        return (url, true)
    }

    func image(for raw: String) async -> UIImage? {
        // Snapshot the routing context HERE, on the MainActor, at request time.
        let sessionID = MediaContext.currentSessionID
        let notePath = MediaContext.currentNotePath
        let scope = Self.scope(for: raw, sessionID: sessionID, notePath: notePath)
        let key = Self.cacheKey(raw, scope: scope)

        if let cached = memory.object(forKey: key as NSString) { return cached }
        // Inflight dedup is scoped too: two sessions asking for the same path
        // concurrently are two DIFFERENT fetches, and sharing one task handed
        // the second session the first one's bytes.
        if let running = inflight[key] { return await running.value }

        let resolved = Self.resolvedURL(for: raw, sessionID: sessionID, notePath: notePath)
        let token = resolved?.needsAuth == true ? AppConfig.token : nil
        let task = Task.detached(priority: .userInitiated) { [diskURL = diskURL(for: key), diskDirectory] in
            await Self.loadImage(resolved: resolved, token: token, diskURL: diskURL, diskDirectory: diskDirectory)
        }
        inflight[key] = task
        let image = await task.value
        inflight[key] = nil
        if let image {
            memory.setObject(image, forKey: key as NSString, cost: Self.decodedCost(image))
        }
        return image
    }

    /// Seed the cache with an image the caller just uploaded, so the editor's
    /// placeholder resolves instantly instead of round-tripping the fetch.
    func seed(_ image: UIImage, for raw: String) {
        let scope = Self.scope(
            for: raw, sessionID: MediaContext.currentSessionID, notePath: MediaContext.currentNotePath
        )
        let key = Self.cacheKey(raw, scope: scope)
        memory.setObject(image, forKey: key as NSString, cost: Self.decodedCost(image))
        guard let data = image.jpegData(compressionQuality: 0.9) else { return }
        let directory = diskDirectory
        let url = diskURL(for: key)
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
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        switch sourcePixelCount(source) {
        case .known(let pixels) where pixels > AttachmentLimits.maxSourcePixels:
            // Genuinely pathological (decompression bomb) — refuse before any
            // raster exists.
            return nil
        case .known, .unknown:
            break
        }
        // `.unknown` (container without pixel-dimension metadata) falls through
        // deliberately: rejecting it made perfectly ordinary images permanently
        // unloadable, and the thumbnail request below is already pixel-bounded
        // by `decodeMaxPixelSize`, so the decode cost stays capped either way.
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

    /// Metadata-only pixel count. `.unknown` distinguishes "the header doesn't
    /// state dimensions" from "the dimensions are huge" — collapsing both onto
    /// `Int.max` rejected valid images (the retry path's headline symptom).
    enum SourcePixels {
        case known(Int)
        case unknown
    }

    nonisolated static func sourcePixelCount(_ source: CGImageSource) -> SourcePixels {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
        else { return .unknown }
        let (pixels, overflow) = width.intValue.multipliedReportingOverflow(by: height.intValue)
        // An overflowing product IS pathologically large, not unknown.
        return .known(overflow ? .max : pixels)
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
                // Forensic crumb: a remote image landing swaps a fixed-height
                // placeholder for real content — a row-height change that can
                // arrive many SECONDS after the page settled (cloud-bridge
                // media fetches are slow), i.e. exactly inside the 5-20s
                // window where the field freezes strike. If the next kill's
                // trail shows img-landed right before the stall, the delayed
                // relayout path is the trigger.
                FreezeContext.shared.note("img-landed", Int(loaded.size.width * loaded.size.height))
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
