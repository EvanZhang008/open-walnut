import Foundation

/// Messages with files that have not reached the server yet, kept on disk.
///
/// A message with files is only POSTed once its files are on the session's host,
/// so for the whole upload it exists nowhere but in this app. If iOS ends the app
/// meanwhile (the person swipes it away, or it is reclaimed in the background), the
/// bubble would be gone with its files and words. Each such send is written here
/// when it starts and removed when the server accepts it or the person discards it;
/// the session page puts it back on screen and sends it again when it next opens
/// (`SessionConversationStore.restorePendingFileSends`) once its transcript is read:
/// a send whose row is already there was taken before the app ended and is only
/// let go, any other goes under its own message id, and its finished uploads
/// answer their path again. All of it goes through one serial queue: writes off
/// the main actor, reads after the writes queued before them.
enum PendingFileSends {
    struct FileRef: Codable, Equatable {
        let id: String
        let name: String
        let size: Int64
        let sha256: String
        let kind: String
    }

    struct Entry: Codable, Equatable {
        let bubbleID: String
        let messageID: String?
        let sessionID: String
        let text: String
        let createdAt: String
        let voice: Bool
        let files: [FileRef]
        var held: [String: Int64]
        /// Photos sent with the files, as JPEG files beside the record.
        let imageCount: Int
        /// When it was written, so a send nobody reopened is let go after a week.
        let savedAt: Date

        init(bubbleID: String, messageID: String?, sessionID: String, text: String, createdAt: String,
             voice: Bool, files: [FileRef], held: [String: Int64], imageCount: Int, savedAt: Date) {
            self.bubbleID = bubbleID; self.messageID = messageID; self.sessionID = sessionID
            self.text = text; self.createdAt = createdAt; self.voice = voice; self.files = files
            self.held = held; self.imageCount = imageCount; self.savedAt = savedAt
        }

        /// Only what a send cannot go without is required; a record from another
        /// build missing the rest still comes back.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            bubbleID = try c.decode(String.self, forKey: .bubbleID)
            sessionID = try c.decode(String.self, forKey: .sessionID)
            text = try c.decode(String.self, forKey: .text)
            files = try c.decode([FileRef].self, forKey: .files)
            messageID = try c.decodeIfPresent(String.self, forKey: .messageID)
            createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ISO8601DateFormatter().string(from: Date())
            voice = try c.decodeIfPresent(Bool.self, forKey: .voice) ?? false
            held = try c.decodeIfPresent([String: Int64].self, forKey: .held) ?? [:]
            imageCount = min(max(0, try c.decodeIfPresent(Int.self, forKey: .imageCount) ?? 0), PendingFileSends.maxImages)
            savedAt = try c.decodeIfPresent(Date.self, forKey: .savedAt) ?? Date()
        }
    }

    /// One record that does not decode costs only itself.
    private struct Lenient: Decodable {
        let entry: Entry?
        init(from decoder: Decoder) throws { entry = try? Entry(from: decoder) }
    }

    /// More photos than a message can carry means a damaged record.
    static let maxImages = 10

    /// Every read and write goes through this one queue: the launch sweep runs off
    /// the main actor while the page writes, and a read-modify-write must not
    /// interleave with another. Writes go out asynchronously (a photo can be
    /// megabytes); a read waits for the writes queued before it.
    private static let queue = DispatchQueue(label: "dev.openwalnut.pending-file-sends")

    /// A week: a send older than that is not going to be wanted.
    static let keepFor: TimeInterval = 7 * 24 * 3600

    static var dir: URL { ComposerFileStore.root.appendingPathComponent(ComposerFileStore.outboxName, isDirectory: true) }

    private static func url(session: String) -> URL? {
        guard let safe = safeComponent(session) else { return nil }
        return dir.appendingPathComponent(safe + ".json")
    }

    private static func imageURL(bubble: String, index: Int) -> URL? {
        guard let safe = safeComponent(bubble) else { return nil }
        return dir.appendingPathComponent("\(safe)-\(index).jpg")
    }

    private static func safeComponent(_ s: String) -> String? {
        guard !s.isEmpty, !s.contains("/"), !s.hasPrefix(".") else { return nil }
        return s
    }

    static func entries(session: String) -> [Entry] {
        queue.sync { read(session: session) }
    }

    private static func read(session: String) -> [Entry] {
        guard let url = url(session: session), let data = try? Data(contentsOf: url) else { return [] }
        return ((try? JSONDecoder().decode([Lenient].self, from: data)) ?? []).compactMap(\.entry)
    }

    private static func write(_ list: [Entry], session: String) {
        guard let url = url(session: session) else { return }
        if list.isEmpty { try? FileManager.default.removeItem(at: url); return }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try JSONEncoder().encode(list).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            AppLog.warn("session-upload", "pending file send could not be kept", ["sessionId": session, "error": "\(error)"])
        }
    }

    static func save(_ entry: Entry, images: [Data]) {
        queue.async {
            for (i, data) in images.prefix(maxImages).enumerated() {
                if let url = imageURL(bubble: entry.bubbleID, index: i) {
                    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    try? data.write(to: url, options: .atomic)
                }
            }
            var list = read(session: entry.sessionID).filter { $0.bubbleID != entry.bubbleID }
            list.append(entry)
            write(list, session: entry.sessionID)
        }
    }

    static func updateHeld(session: String, bubble: String, held: [String: Int64]) {
        queue.async {
            var list = read(session: session)
            guard let i = list.firstIndex(where: { $0.bubbleID == bubble }), list[i].held != held else { return }
            list[i].held = held
            write(list, session: session)
        }
    }

    static func remove(session: String, bubble: String) {
        queue.async { drop(session: session, bubble: bubble) }
    }

    private static func drop(session: String, bubble: String) {
        let list = read(session: session)
        guard let gone = list.first(where: { $0.bubbleID == bubble }) else { return }
        for i in 0..<gone.imageCount {
            if let url = imageURL(bubble: bubble, index: i) { try? FileManager.default.removeItem(at: url) }
        }
        write(list.filter { $0.bubbleID != bubble }, session: session)
    }

    static func images(of entry: Entry) -> [Data] {
        queue.sync {
            (0..<entry.imageCount).compactMap { i in imageURL(bubble: entry.bubbleID, index: i).flatMap { try? Data(contentsOf: $0) } }
        }
    }

    /// The files a kept send still needs, so the launch sweep keeps their copies.
    /// Drops sends older than `keepFor` first (their files then go with the sweep).
    static func keptFileIDs(now: Date = Date()) -> Set<String> {
        queue.sync {
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
            var ids = Set<String>()
            for name in names where name.hasSuffix(".json") {
                let session = String(name.dropLast(5))
                let list = read(session: session)
                let fresh = list.filter { now.timeIntervalSince($0.savedAt) < keepFor }
                for old in list where !fresh.contains(old) { drop(session: session, bubble: old.bubbleID) }
                for entry in fresh { entry.files.forEach { ids.insert($0.id) } }
            }
            return ids
        }
    }

    static func ref(_ file: ComposerFile) -> FileRef {
        FileRef(id: file.id, name: file.name, size: file.size, sha256: file.sha256, kind: file.kind.rawValue)
    }

    /// The app's copy of a kept file, and whether it is still there whole.
    static func file(_ ref: FileRef) -> (file: ComposerFile, present: Bool) {
        let url = ComposerFileStore.root.appendingPathComponent(ref.id, isDirectory: true).appendingPathComponent(ref.name)
        let file = ComposerFile(id: ref.id, name: ref.name, size: ref.size, sha256: ref.sha256,
                                kind: ComposerFile.Kind(rawValue: ref.kind) ?? .other, localURL: url)
        return (file, (try? ComposerFileStore.fileSize(url)) == ref.size)
    }
}
