import Foundation
import Observation

/// What Talk to Walnut said but did not deliver yet, on disk until it reaches
/// the CEO chat or the person deletes it.
///
/// An entry is written BEFORE the send starts (`begin`), so a crash, a kill or
/// a phone that dies mid-send leaves the words here instead of nowhere. Each
/// entry keeps the one message id every attempt uses, so a resend after a send
/// that did arrive (its answer was lost) is the same message to the server,
/// never a second one.
@Observable
@MainActor
final class TalkOutbox {
    static let shared = TalkOutbox()
    static let storeKey = "talk-outbox"

    struct Entry: Codable, Identifiable, Equatable {
        let id: String
        /// The `qm-` id every attempt sends with (server-side dedupe).
        let messageId: String
        let createdAt: Date
        /// The words, once there are any. Nil: the recording was kept but could
        /// not be turned into text yet (`recordingID` names it).
        var text: String?
        var recordingID: String?
        /// Why the last attempt failed, in words the person can act on. Nil
        /// while the first attempt is still going.
        var reason: String?
        var attempts: Int
        var updatedAt: Date
    }

    private(set) var entries: [Entry] = []
    private let key: String

    init(key: String = TalkOutbox.storeKey) {
        self.key = key
        entries = (DurableStore.load([Entry].self, key: key) ?? []).map { entry in
            var entry = entry
            entry.reason = entry.reason.map(TalkReason.short)
            return entry
        }
        #if DEBUG
        // A UI test starts from an empty list (`-walnut.debug.talkClearOutbox YES`),
        // so takes an earlier run left behind never change what it sees.
        if UserDefaults.standard.bool(forKey: "walnut.debug.talkClearOutbox") {
            entries = []
            _ = persist()
        }
        #endif
    }

    /// The entries that failed (the ones the person is shown), newest first.
    var unsent: [Entry] {
        entries.filter { $0.reason != nil }.sorted { $0.createdAt > $1.createdAt }
    }

    /// Record a take about to be sent (or kept without words). Returns whether
    /// it reached the disk; the caller still sends when it did not.
    @discardableResult
    func begin(_ entry: Entry) -> Bool {
        entries.removeAll { $0.id == entry.id }
        entries.append(entry)
        return persist()
    }

    func update(_ id: String, _ change: (inout Entry) -> Void) {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        change(&entries[index])
        entries[index].updatedAt = Date()
        persist()
    }

    func remove(_ id: String) {
        entries.removeAll { $0.id == id }
        persist()
    }

    func entry(_ id: String) -> Entry? { entries.first { $0.id == id } }

    /// An entry whose send was cut off (the app died mid-send) reads as failed
    /// on the next launch, with a reason, instead of as "sending" forever.
    func settleInterrupted(reason: String) {
        var changed = false
        for index in entries.indices where entries[index].reason == nil {
            entries[index].reason = reason
            changed = true
        }
        if changed { persist() }
    }

    func reload() {
        entries = DurableStore.load([Entry].self, key: key) ?? []
    }

    @discardableResult
    private func persist() -> Bool {
        DurableStore.save(entries, key: key)
    }
}

/// The words a failed take is shown with. One failure reads the same however it
/// happened (live, on a resend, or saved by an older build), so a list of kept
/// takes never shows the same cause two ways.
enum TalkReason {
    static let serverUnavailable = "Walnut server unavailable."
    static let uploadCut = "The upload stopped before your Walnut server got all of it."

    /// The failures the next try fixes by itself: the server was away.
    static func goesOutLater(_ reason: String) -> Bool {
        reason == serverUnavailable || reason == uploadCut
    }

    /// Wordings of the unreachable server that older builds and the voice
    /// composer used, each read as `serverUnavailable`.
    static let serverUnavailableWordings = ["Couldn't reach your Walnut server", "Walnut server unavailable"]

    static func short(_ stored: String) -> String {
        if serverUnavailableWordings.contains(where: { stored.hasPrefix($0) }) { return serverUnavailable }
        var text = stored
        for kept in VoiceRecorder.keptTakeEndings where text.hasSuffix(kept) {
            text.removeLast(kept.count)
        }
        return text
    }
}
