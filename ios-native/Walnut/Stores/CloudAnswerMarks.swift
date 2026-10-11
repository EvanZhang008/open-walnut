import CryptoKit
import Foundation

/// Which assistant replies the cloud companion computed, remembered on the phone.
///
/// The live turn says it in its SSE terminal frame (`answeredBy: "cloud"`, or the
/// in-process fallback engine of an older replica). A current server says it again
/// on the reply's history row, so a reload needs nothing from here. An OLDER server's
/// history does not, and without a memory the "Answered on Cloud" caption would show
/// while the turn ends and vanish on the very next refetch or relaunch: the caption
/// has to read the same live and after a reload, so the fact is kept here and put
/// back on the matching fetched row.
///
/// A mark is (conversation, digest of the reply's text, when the phone saw it). A
/// fetched row takes it only if it is an assistant reply in that conversation with
/// the same text AND a timestamp near the mark, so a short reply the Mac gives later
/// ("Done.") in the same conversation is not mislabelled as a cloud answer.
struct CloudAnswerMarks {
    struct Mark: Codable, Equatable {
        let conversationID: String
        let digest: String
        /// Milliseconds since 1970, phone clock, when the turn ended.
        let at: Double
    }

    static let storageKey = "walnut.chat.cloudAnswerMarks"
    /// Bounded: this is a correction for old servers, not a second history.
    static let limit = 64
    /// How far the history row's timestamp may sit from the mark. Wide enough for
    /// server and phone clocks that disagree, narrow enough that the same words
    /// said again later in the conversation keep their own attribution.
    static let matchWindowMs: Double = 15 * 60 * 1000

    private(set) var marks: [Mark]
    private let storedDefaults: UserDefaults
    /// The app's own follow the demo scope (`AppPrefs`).
    private var defaults: UserDefaults { AppPrefs.resolve(storedDefaults) }

    init(defaults: UserDefaults = .standard) {
        self.storedDefaults = defaults
        if let data = AppPrefs.resolve(defaults).data(forKey: Self.storageKey),
           let stored = try? JSONDecoder().decode([Mark].self, from: data) {
            marks = stored
        } else {
            marks = []
        }
    }

    /// Does a turn-end frame say the cloud companion computed this reply?
    /// `answeredBy` is the current wire word; `walnut-agent-fallback` is the engine
    /// an older replica names when it answers with its own built-in agent.
    static func frameSaysCloud(answeredBy: String?, engine: String?) -> Bool {
        answeredBy == "cloud" || engine == "walnut-agent-fallback"
    }

    /// Same normalization the turn-end duplicate check uses: entity refs are
    /// resolved on both sides (an old server sends the live text raw and the
    /// history row stripped), and edge whitespace is not part of the reply.
    static func digest(_ text: String) -> String {
        let normalized = MarkdownParser.replaceEntityRefs(text, bold: false)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let hash = SHA256.hash(data: Data(normalized.utf8))
        return hash.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    mutating func remember(conversationID: String, text: String, atMs: Double) {
        guard !conversationID.isEmpty, !text.isEmpty else { return }
        let digest = Self.digest(text)
        marks.removeAll { $0.conversationID == conversationID && $0.digest == digest }
        marks.append(Mark(conversationID: conversationID, digest: digest, at: atMs))
        if marks.count > Self.limit { marks.removeFirst(marks.count - Self.limit) }
        if let data = try? JSONEncoder().encode(marks) {
            defaults.set(data, forKey: Self.storageKey)
        }
    }

    /// Stamp `answeredBy = "cloud"` on the fetched replies the phone watched the
    /// cloud answer. Rows the server already labelled are left alone, and nothing
    /// is ever UN-stamped: the server's word wins whenever it has one.
    func apply(to rows: [ChatMessage], conversationID: String) -> [ChatMessage] {
        let mine = marks.filter { $0.conversationID == conversationID }
        guard !mine.isEmpty else { return rows }
        var out = rows
        for index in out.indices {
            let row = out[index]
            guard !row.isUser, row.kind == nil, row.answeredBy == nil, !row.text.isEmpty else { continue }
            let digest = Self.digest(row.text)
            let sameText = mine.filter { $0.digest == digest }
            guard !sameText.isEmpty else { continue }
            // A row with no readable time can only be matched by its text.
            let matches = Self.epochMs(row.createdAt).map { rowMs in
                sameText.contains { abs(rowMs - $0.at) <= Self.matchWindowMs }
            } ?? true
            if matches { out[index].answeredBy = "cloud" }
        }
        return out
    }

    static func epochMs(_ iso: String) -> Double? {
        if let date = fractionalISO.date(from: iso) ?? plainISO.date(from: iso) {
            return date.timeIntervalSince1970 * 1000
        }
        return nil
    }

    // ISO8601DateFormatter is thread-safe; built once because building one is not cheap.
    private static let fractionalISO: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plainISO = ISO8601DateFormatter()
}

extension CloudAnswerMarks {
    /// Disconnect and Leave demo: forget every mark, in memory and on disk.
    mutating func removeAll() {
        marks = []
        defaults.removeObject(forKey: Self.storageKey)
    }
}
