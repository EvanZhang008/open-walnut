import Foundation
import CryptoKit
import UniformTypeIdentifiers
import PhotosUI
import SwiftUI

/// A file the person attached to a session message: a video from the photo
/// library or anything from Files. Unlike a photo (`SelectedImage`, sent inline as
/// a JPEG), its bytes are uploaded to the session's host in chunks before the
/// message goes (`SessionFileUploader`), and the message names the saved paths
/// (`ComposerFile.messageText`).
///
/// The bytes live in the app's own copy (`ComposerFileStore`), made at pick
/// time: a Files URL is only readable inside its security scope and a picked
/// video arrives as a temporary file the system deletes, while an upload can
/// take minutes and be retried after the app was away.
struct ComposerFile: Identifiable, Equatable, Hashable, Sendable {
    /// The upload id the server and the host key the file by (`up-<uuid>`).
    let id: String
    /// The name the session sees, already in the server's rule (`safeName`).
    let name: String
    let size: Int64
    let sha256: String
    let kind: Kind
    /// The app's copy (`ComposerFileStore`).
    let localURL: URL

    enum Kind: String, Sendable {
        case video, image, pdf, audio, other
    }

    /// One file per message at most this large, the server's cap.
    static let maxBytes: Int64 = 4 * 1024 * 1024 * 1024
    /// Files per message.
    static let maxFiles = 10

    static func kind(for type: UTType?, name: String) -> Kind {
        let type = type ?? UTType(filenameExtension: (name as NSString).pathExtension)
        guard let type else { return .other }
        if type.conforms(to: .movie) || type.conforms(to: .video) { return .video }
        if type.conforms(to: .image) { return .image }
        if type.conforms(to: .pdf) { return .pdf }
        if type.conforms(to: .audio) { return .audio }
        return .other
    }

    var symbol: String { Self.symbol(for: kind) }

    static func symbol(for kind: Kind) -> String {
        switch kind {
        case .video: return "film"
        case .image: return "photo"
        case .pdf: return "doc.richtext"
        case .audio: return "waveform"
        case .other: return "doc"
        }
    }

    /// "12.4 MB" style, the way Files shows a size.
    static func sizeLabel(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    /// A name the server takes (session-uploads.ts `isUploadName`): no slash or
    /// control character, no leading dot or space, at most 200 UTF-8 bytes (the
    /// extension kept), never the host's staging suffix, never empty.
    /// What JavaScript's `trim()` removes, which the server's check uses: the
    /// Unicode spaces and line breaks, plus the byte-order mark Swift's set lacks.
    private static let trimmed = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))

    static func safeName(_ raw: String) -> String {
        var name = String(raw.unicodeScalars.map { scalar -> Character in
            if scalar.value < 0x20 || scalar.value == 0x7f || scalar == "/" || scalar == "\\" { return "_" }
            return Character(scalar)
        })
        name = name.trimmingCharacters(in: trimmed)
        while name.hasPrefix(".") { name.removeFirst() }
        name = name.trimmingCharacters(in: trimmed)
        if name.hasSuffix(".walnut-part") { name += "_" }
        if name.utf8.count > 200 {
            // Cut the stem, keep a short extension: "….mov" still opens as a video.
            let ext = (name as NSString).pathExtension
            let suffix = !ext.isEmpty && ext.utf8.count <= 20 ? "." + ext : ""
            var stem = suffix.isEmpty ? name : (name as NSString).deletingPathExtension
            while !stem.isEmpty, stem.utf8.count + suffix.utf8.count > 200 { stem.removeLast() }
            name = stem.trimmingCharacters(in: trimmed) + suffix
        }
        return name.isEmpty || name.hasPrefix(".") ? "file" + name : name
    }

    // MARK: - The message text

    /// The header line of a message with attached files: byte for byte the
    /// server's `FILES_ATTACHED_LINE` (session-uploads.ts).
    static let headerLine = "[Files attached \u{2014} open them from these paths]"

    /// What the session receives: the saved paths under the header, then the
    /// person's words (the server's `withFilePaths`).
    static func messageText(_ text: String, paths: [String]) -> String {
        guard !paths.isEmpty else { return text }
        let list = paths.map { "- \($0)" }.joined(separator: "\n")
        return "\(headerLine)\n\(list)\n\n\(text)"
    }
}

/// The app's copies of attached files, one folder per upload id under
/// Application Support. A copy lives until its message is accepted, the person
/// removes it, or it is a day old with nothing holding it (`purgeStale`).
enum ComposerFileStore {
    static var root: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("PendingUploads", isDirectory: true)
    }

    enum ImportError: LocalizedError {
        case tooLarge(Int64)
        case unreadable(String)

        var errorDescription: String? {
            switch self {
            case .tooLarge(let size):
                return "That file is \(ComposerFile.sizeLabel(size)); a file can be at most \(ComposerFile.sizeLabel(ComposerFile.maxBytes))."
            case .unreadable(let why):
                return "That file couldn't be read (\(why))."
            }
        }
    }

    static func newUploadID() -> String { "up-" + UUID().uuidString.lowercased() }

    /// Copy (or `move`) a file into the store and hash it. Off the main actor: a
    /// video is hundreds of megabytes. `scoped` = a Files URL, read inside its
    /// security scope.
    static func importCopy(of source: URL, name rawName: String? = nil, type: UTType? = nil,
                           scoped: Bool, move: Bool = false) async throws -> ComposerFile {
        try await Task.detached(priority: .userInitiated) {
            let started = scoped && source.startAccessingSecurityScopedResource()
            defer { if started { source.stopAccessingSecurityScopedResource() } }
            let size = try fileSize(source)
            if size > ComposerFile.maxBytes { throw ImportError.tooLarge(size) }
            let id = newUploadID()
            let name = ComposerFile.safeName(rawName ?? source.lastPathComponent)
            let dir = root.appendingPathComponent(id, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest = dir.appendingPathComponent(name)
            do {
                // A picked video is our own temporary copy already: moved, not copied twice.
                if move { try FileManager.default.moveItem(at: source, to: dest) }
                else { try FileManager.default.copyItem(at: source, to: dest) }
            } catch {
                try? FileManager.default.removeItem(at: dir)
                throw ImportError.unreadable(error.localizedDescription)
            }
            // Never sent through iCloud backup: a scratch copy of something the person already has.
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutable = dir
            try? mutable.setResourceValues(values)
            let digest = try sha256(of: dest)
            let resolvedType = type ?? (try? dest.resourceValues(forKeys: [.contentTypeKey]))?.contentType
            return ComposerFile(id: id, name: name, size: try fileSize(dest), sha256: digest,
                                kind: ComposerFile.kind(for: resolvedType, name: name), localURL: dest)
        }.value
    }

    /// A video from the photo picker, as the file it is (no re-encode).
    static func importVideo(_ item: PhotosPickerItem) async throws -> ComposerFile {
        guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
            throw ImportError.unreadable("the video is not available")
        }
        defer { try? FileManager.default.removeItem(at: movie.url.deletingLastPathComponent()) }
        let type = item.supportedContentTypes.first { $0.conforms(to: .movie) }
        return try await importCopy(of: movie.url, type: type, scoped: false, move: true)
    }

    static func remove(_ file: ComposerFile) {
        remove(id: file.id)
    }

    static func remove(id: String) {
        guard id.hasPrefix("up-"), !id.contains("/") else { return }
        try? FileManager.default.removeItem(at: root.appendingPathComponent(id, isDirectory: true))
    }

    /// Copies a day old that nothing holds: an app killed with a draft or a
    /// sending bubble leaves its copy behind.
    /// The folder of sends not yet accepted (`PendingFileSends`), never swept here.
    static let outboxName = "outbox"

    static func purgeStale(keeping ids: Set<String>, olderThan age: TimeInterval = 24 * 3600) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let cutoff = Date().addingTimeInterval(-age)
        for entry in entries where !ids.contains(entry.lastPathComponent) && entry.lastPathComponent != outboxName {
            let modified = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            if modified < cutoff { try? fm.removeItem(at: entry) }
        }
    }

    static func removeAll() {
        try? FileManager.default.removeItem(at: root)
    }

    static func fileSize(_ url: URL) throws -> Int64 {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs[.size] as? NSNumber)?.int64Value ?? 0
    }

    static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// A picked video as a file. The system hands a temporary copy that it may
/// delete when the closure returns, so it is moved into a folder of our own first.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let dir = FileManager.default.temporaryDirectory
                .appendingPathComponent("picked-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest = dir.appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: dest)
            return PickedMovie(url: dest)
        }
    }
}
