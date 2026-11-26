import Foundation

/// Session sends the server held for a computer that was away (a 202 `queued`, the cloud
/// companion's bank, core/send-queue.ts), kept on this phone until it is known what became of
/// each: in the conversation, still held, or never delivered.
///
/// WHY (review of 2026-11-25). The companion lets a held send go after a day (`send_expired`:
/// a day-old thought should never surprise a session) and tells only a phone that asks
/// (`GET /sessions/:id/messages/:messageId`, kept a day more). No phone asked, so after a long
/// absence of the Mac the words were gone with nothing saying so, though the phone had said they
/// would arrive. The phone may reach the Mac instead of the companion (Wi-Fi, Tailscale), which
/// answers 404 there, and the companion forgets a delivery a day after it: so the conversation
/// itself (its transcript, from either) settles a send it cannot answer for, by the message id
/// its row names. One never delivered comes back, not sent, where it was typed: the Action
/// Button's list (`TalkOutbox`), the thread's Follow up box (`ComposerDrafts`), or the session's
/// page (`PendingFileSends`), for the person to send again or delete, never sent by itself, and
/// under a new message id, as the server answers the old one "not sent" for good.
///
/// Every held receipt is noted where the phone builds it (`WalnutAPI.sessionSendReceipt`), so no
/// sender can hold words without this; a sender with its own box names it before it sends
/// (`expect`). Records go through one serial queue.
enum HeldSessionSends {
    /// Where words that come back go.
    enum Origin: Codable, Equatable {
        /// The Action Button's Talk to Walnut: its list of takes.
        case talk
        /// A thread's Follow up box (`OrgThreadFollowUpDraft.key`).
        case thread(draftKey: String)
    }

    struct Record: Codable, Equatable {
        let sessionId: String
        let messageId: String
        let text: String
        let heldAt: Date
        /// Nil: the session's page.
        var origin: Origin?
        /// It carried pictures, which the server held and this phone did not keep.
        var pictures: Bool?
    }

    private struct Expected: Codable, Equatable {
        let messageId: String
        let origin: Origin
    }

    static let storeKey = "held-session-sends"
    private static let expectedKey = "held-session-sends-origins"
    /// The most kept; the oldest go first.
    static let keepLimit = 200
    private static let expectedLimit = 100
    /// Past the companion's day (`SEND_HORIZON_MS`) with a margin: it delivers a held send only
    /// within that day, so one the conversation does not show by then never arrives.
    static let undeliveredAfter: TimeInterval = 26 * 3_600
    /// One nothing could settle (no transcript read): back for the person after this.
    static let givenBackAfter: TimeInterval = 7 * 86_400
    /// How far before a send's own time its row is looked for (the phone's clock may be off).
    static let clockMargin: TimeInterval = 600
    /// The fewest seconds between two follow-ups that are not forced.
    static let followGap: TimeInterval = 120

    private static let queue = DispatchQueue(label: "walnut.held-session-sends")

    static func all() -> [Record] {
        queue.sync { read() }
    }

    /// Names the box a send's words go back to, before it is sent: a held answer is noted under
    /// it even if the app ends right after.
    static func expect(messageId: String, origin: Origin) {
        queue.sync {
            var expected = DurableStore.load([Expected].self, key: expectedKey) ?? []
            expected.removeAll { $0.messageId == messageId }
            expected.append(Expected(messageId: messageId, origin: origin))
            _ = DurableStore.save(Array(expected.suffix(expectedLimit)), key: expectedKey)
        }
    }

    /// A held receipt: kept until it is known what became of it.
    static func note(sessionId: String, messageId: String, text: String, pictures: Bool, at: Date = Date()) {
        queue.sync {
            let origin = (DurableStore.load([Expected].self, key: expectedKey) ?? []).last { $0.messageId == messageId }?.origin
            var records = read()
            records.removeAll { $0.messageId == messageId }
            records.append(Record(sessionId: sessionId, messageId: messageId, text: text, heldAt: at,
                                  origin: origin, pictures: pictures ? true : nil))
            write(Array(records.suffix(keepLimit)))
        }
    }

    static func remove(messageId: String) {
        queue.sync {
            var records = read()
            records.removeAll { $0.messageId == messageId }
            write(records)
        }
    }

    static func eraseAll() {
        queue.sync {
            DurableStore.remove(key: storeKey)
            DurableStore.remove(key: expectedKey)
        }
    }

    private static func read() -> [Record] { DurableStore.load([Record].self, key: storeKey) ?? [] }
    private static func write(_ records: [Record]) {
        if records.isEmpty { DurableStore.remove(key: storeKey) } else { _ = DurableStore.save(records, key: storeKey) }
    }

    // MARK: - Follow-up

    @MainActor private static var following = false
    @MainActor private static var lastFollow: Date?

    /// What is known of one held send.
    enum Fate: Equatable {
        case delivered
        case waiting
        case notSent(String)
    }

    /// Read, and not there: the companion delivers only within its day, but a relay it lost the
    /// answer to may still wait on the Mac (review round 3), so the person checks before sending.
    static let undeliveredSentence = "Not in the conversation: Walnut held this while your Mac was away, and it has not arrived. Check the conversation before you send it again."
    static let unsettledSentence = "Walnut held this while your Mac was away and could not check whether it arrived. Check the conversation before you send it again."

    /// Asks about every held send (on each return to the app): one delivered is let go, one
    /// still held stays, one never delivered comes back where it was typed. True when one came
    /// back to the Action Button's list.
    @MainActor
    @discardableResult
    static func follow(reader: HeldSendStatusReading = WalnutAPI(), talkOutbox: TalkOutbox = .shared,
                       drafts: ComposerDrafts = .shared, now: Date = Date(), force: Bool = false) async -> Bool {
        guard !following else { return false }
        if !force, let lastFollow, now.timeIntervalSince(lastFollow) < followGap { return false }
        let records = all()
        guard !records.isEmpty else { return false }
        following = true
        lastFollow = now
        defer { following = false }
        var backToTalk = false
        for record in records {
            switch await fate(of: record, reader: reader, now: now) {
            case .waiting:
                continue
            case .delivered:
                remove(messageId: record.messageId)
                AppLog.info("held-send", "went through", ["sessionId": record.sessionId, "messageId": record.messageId])
            case .notSent(let reason):
                let said = record.pictures == true ? reason + " Its pictures were not kept on this iPhone." : reason
                putBack(record, reason: said, talkOutbox: talkOutbox, drafts: drafts, now: now)
                if record.origin == .talk { backToTalk = true }
                remove(messageId: record.messageId)
                AppLog.warn("held-send", "came back not sent", [
                    "sessionId": record.sessionId, "messageId": record.messageId, "origin": "\(record.origin.map { "\($0)" } ?? "session")",
                ])
            }
        }
        return backToTalk
    }

    /// The server's word first when it is final (delivered, held, not sent); else the
    /// conversation's, once the companion's day is past.
    @MainActor
    static func fate(of record: Record, reader: HeldSendStatusReading, now: Date) async -> Fate {
        if let status = try? await reader.sessionMessageStatus(sessionId: record.sessionId, messageId: record.messageId) {
            switch status.state {
            case "delivered": return .delivered
            case "held": return .waiting
            case "not_sent": return .notSent(status.message?.isEmpty == false ? status.message! : undeliveredSentence)
            default: break // unknown: the companion no longer knows (it forgets a day after)
            }
        }
        // 404 (the Mac holds no messages), unknown, or no answer: the conversation shows it or not.
        let age = now.timeIntervalSince(record.heldAt)
        if let shown = await conversationShows(record, reader: reader) {
            if shown { return .delivered }
            return age > undeliveredAfter ? .notSent(undeliveredSentence) : .waiting
        }
        return age > givenBackAfter ? .notSent(unsettledSentence) : .waiting
    }

    /// Whether the session's transcript, read back to the send's time, has its row; nil when that
    /// could not be read. Only the Mac's own page (`pageable`) proves a row is missing: the
    /// companion's fallbacks (its bridge tail of the last 512 KB, its synced copy) and the Mac's
    /// saved copy can lack rows without saying so (review round 3).
    @MainActor
    static func conversationShows(_ record: Record, reader: HeldSendStatusReading) async -> Bool? {
        let oldest = record.heldAt.addingTimeInterval(-clockMargin)
        let stamp = ISO8601DateFormatter()
        guard let page = try? await reader.sessionTranscriptPage(id: record.sessionId, before: nil, since: stamp.string(from: oldest), visible: 0)
        else { return nil }
        let first = page.messages.first.flatMap { SessionConversationStore.isoDate($0.timestamp) }
        var bubble = ChatMessage(id: "held", role: "user", text: record.text, createdAt: stamp.string(from: record.heldAt), kind: nil)
        bubble.clientMessageId = record.messageId
        let shown = page.messages.contains { m in
            m.role == "user" && m.kind == nil && SessionConversationStore.rowIsRestoredSend(bubble, row: SessionConversationStore.row(from: m))
        }
        if shown { return true }
        guard page.pageable == true, page.truncated == false || (first.map { $0 <= oldest } ?? false) else { return nil }
        return false
    }

    @MainActor
    private static func putBack(_ record: Record, reason: String, talkOutbox: TalkOutbox, drafts: ComposerDrafts, now: Date) {
        switch record.origin {
        case .talk?:
            talkOutbox.begin(TalkOutbox.Entry(
                id: UUID().uuidString, messageId: SendRetryPolicy.newMessageId(), createdAt: record.heldAt, text: record.text,
                recordingID: nil, reason: reason, attempts: 1, updatedAt: now
            ))
        case .thread(let key)?:
            // Back in the box it was typed in, after whatever is being written there now, and the
            // box says why (`ComposerDrafts.returnNote`).
            let draft = drafts.draft(key)
            drafts.setDraft(draft.isEmpty ? record.text : draft + "\n\n" + record.text, key: key)
            drafts.setReturnNote(reason, key: key)
        case nil:
            let stamp = ISO8601DateFormatter()
            stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            PendingFileSends.save(PendingFileSends.Entry(
                bubbleID: "held-" + UUID().uuidString.lowercased(), messageID: SendRetryPolicy.newMessageId(),
                sessionID: record.sessionId, text: record.text, createdAt: stamp.string(from: record.heldAt), voice: false,
                files: [], held: [:], imageCount: 0, savedAt: now, failed: true, note: reason
            ), images: [])
        }
    }
}

/// What the server says of a message it held (`GET /sessions/:id/messages/:messageId`).
struct HeldSendStatus: Decodable, Equatable {
    /// `held`, `delivered`, `not_sent` or `unknown`.
    let state: String
    var code: String? = nil
    var message: String? = nil
}

/// The two reads a follow-up makes, a seam for the unit tests.
protocol HeldSendStatusReading {
    func sessionMessageStatus(sessionId: String, messageId: String) async throws -> HeldSendStatus
    func sessionTranscriptPage(id: String, before: String?, since: String?, visible: Int) async throws -> SessionTranscript
}

extension WalnutAPI: HeldSendStatusReading {
    func sessionMessageStatus(sessionId: String, messageId: String) async throws -> HeldSendStatus {
        try await get("/sessions/\(escape(sessionId))/messages/\(escape(messageId))")
    }

    /// The receipt of a session send, built here only: one the server held for a computer that
    /// is away is kept on this phone until it is known what became of it (`HeldSessionSends`).
    func sessionSendReceipt(session id: String, text: String, pictures: Bool, messageId: String, queued: Bool?) -> SessionSendReceipt {
        let receipt = SessionSendReceipt(messageId: messageId, queued: queued == true)
        if receipt.queued { HeldSessionSends.note(sessionId: id, messageId: messageId, text: text, pictures: pictures) }
        return receipt
    }
}
