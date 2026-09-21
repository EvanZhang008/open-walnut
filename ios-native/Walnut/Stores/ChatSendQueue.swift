import Foundation

/// One message the user committed while a turn was already running.
///
/// The store banks these instead of refusing them, so the composer can keep its
/// send button mid-turn (`ComposerPrimaryAction`). Everything a delivery needs is
/// in here, because the delivery happens later — possibly after a relaunch, from
/// a restored copy on disk — and nothing else will still be holding the words.
///
/// `conversationID` and `agentID` are part of the entry rather than of the queue's
/// shape: one queue holds entries for several conversations, and an entry may
/// only ever be posted to the conversation it was typed into. A queued message
/// delivered to whatever happens to be on screen is the same class of bug as
/// applying one conversation's fetch under another's title.
struct QueuedSend: Equatable, Identifiable {
    /// Where an entry is in its life. THE SAME THREE WORDS the server's durable
    /// queue uses (`src/core/session-message-queue.ts`: pending → processing →
    /// removed), so the two layers describe one lifecycle rather than two.
    enum Status: String, Codable, Sendable {
        /// On disk, withdrawable, not yet offered to the server.
        case pending
        /// A POST is out for it. Still on disk — that is the whole point, see
        /// `ChatSendQueueStore` — but no longer withdrawable, because the server
        /// may already have it.
        case processing
        /// The process died while a POST was out, so nobody can say whether the
        /// server has it. Not deliverable by any automatic trigger and not deleted
        /// either: it renders as the retryable FAILED bubble the app already has, in
        /// full, and the person who wrote the words decides. The server queue's
        /// `parked` state exists for the same reason (a row no automatic trigger may
        /// ever pick up again) and this is its client twin.
        case undecided
    }

    /// The optimistic bubble's row id. The bubble is created at enqueue time and
    /// is the SAME row all the way through delivery, so nothing flickers and no
    /// text can exist twice.
    let id: String
    let conversationID: String
    let agentID: String
    let text: String
    /// JPEG bytes, exactly what the send path posts.
    ///
    /// NOT a second copy of the image. `Data` is copy-on-write, so the bubble's
    /// `localImages` and this array reference the SAME backing store; what would
    /// genuinely cost 180MB of work is re-encoding these bytes on every queue
    /// mutation, which is why the disk form writes them ONCE to their own file
    /// (again, `ChatSendQueueStore`) and the index rewrite carries none of them.
    let images: [Data]
    /// Timestamp the bubble carries, so a restored queue rebuilds a bubble that
    /// sorts and ages like the one the user saw before the app died.
    let createdAt: String
    var status: Status = .pending

    /// What this entry costs against the queue's byte budget.
    var byteCount: Int { images.reduce(0) { $0 + $1.count } }

    func with(status: Status) -> QueuedSend {
        var copy = self
        copy.status = status
        return copy
    }
}

/// The disk form of an entry: everything except the image bytes.
///
/// The split is the fix for a real cost, not tidiness. An index that carried the
/// bytes was base64-re-encoded and atomically rewritten on every enqueue, every
/// drain step and every withdraw; ten entries at the aggregate attachment budget
/// is ~24MB of JPEG, so a queue mutation became tens of MB of encode plus a whole
/// file rewrite. Bytes now go to their own file once, and this is what gets
/// rewritten.
struct QueuedSendRecord: Codable, Equatable {
    let id: String
    let conversationID: String
    let agentID: String
    let text: String
    let createdAt: String
    let status: QueuedSend.Status
    let imageCount: Int
}

/// Where the queue lives between launches, and the one place that knows the index
/// and the image files have to agree.
enum ChatSendQueueStore {
    /// Index key. One file for every conversation, with each entry naming its own:
    /// a per-conversation key would need a directory walk to restore.
    static let indexKey = "chat-send-queue"
    /// Per-entry image payload keys share this prefix so orphans can be swept.
    static let imageKeyPrefix = "chat-send-queue-images-"

    static func imageKey(_ rowID: String) -> String { "\(imageKeyPrefix)\(rowID)" }

    /// Persist `queue`. Returns false when the INDEX did not land, which is the
    /// only failure a caller can act on: without an index nothing will ever be
    /// restored, so the caller must not believe the words are safe on disk.
    ///
    /// Images are written before the index and deleted after it, in that order, on
    /// purpose: an image file with no index entry is an orphan this file can sweep,
    /// while an index entry with no image file would be a message that restores
    /// having silently lost its attachment.
    @discardableResult
    static func persist(_ queue: [QueuedSend], previous: [QueuedSend]) -> Bool {
        let existing = Set(previous.map(\.id))
        for entry in queue where !existing.contains(entry.id) && !entry.images.isEmpty {
            DurableStore.save(entry.images, key: imageKey(entry.id))
        }
        let landed = DurableStore.save(
            queue.map(record(for:)), key: indexKey
        )
        let kept = Set(queue.map(\.id))
        for entry in previous where !kept.contains(entry.id) && !entry.images.isEmpty {
            DurableStore.remove(key: imageKey(entry.id))
        }
        return landed
    }

    static func record(for entry: QueuedSend) -> QueuedSendRecord {
        QueuedSendRecord(
            id: entry.id, conversationID: entry.conversationID, agentID: entry.agentID,
            text: entry.text, createdAt: entry.createdAt, status: entry.status,
            imageCount: entry.images.count
        )
    }

    /// Read the queue back, re-attaching each entry's image bytes, and sweep any
    /// payload file the index does not claim.
    ///
    /// Statuses come back exactly as they were written; what to DO about a
    /// `processing` one is the caller's decision, see
    /// `ChatSendQueueRules.partitionRestored`.
    static func restore() async -> [QueuedSend] {
        let records = await DurableStore.loadAsync([QueuedSendRecord].self, key: indexKey) ?? []
        var entries: [QueuedSend] = []
        for record in records {
            var images: [Data] = []
            if record.imageCount > 0 {
                images = await DurableStore.loadAsync([Data].self, key: imageKey(record.id)) ?? []
            }
            entries.append(QueuedSend(
                id: record.id, conversationID: record.conversationID,
                agentID: record.agentID, text: record.text, images: images,
                createdAt: record.createdAt, status: record.status
            ))
        }
        sweepOrphanImages(keeping: Set(entries.map(\.id)))
        return entries
    }

    private static func sweepOrphanImages(keeping ids: Set<String>) {
        for key in DurableStore.keys(withPrefix: imageKeyPrefix) {
            let rowID = String(key.dropFirst(imageKeyPrefix.count))
            if !ids.contains(rowID) { DurableStore.remove(key: key) }
        }
    }
}

/// The queue's pure rules — what may be banked, what must be dropped, what may be
/// re-sent, and what the user is told. Separated from the store so they are
/// assertable without a conversation, a network, or a timeline.
enum ChatSendQueueRules {
    /// Ceiling on banked messages, PER CONVERSATION, matching the web console's
    /// `MAX_QUEUE_SIZE`. Per conversation and not global: a global count made ten
    /// messages banked in one conversation refuse a send in a different one, which
    /// is a limit the user has no way to understand from where they are standing.
    static let maxQueuedPerConversation = 10

    /// Ceiling on banked image bytes, across the whole queue. This one IS global,
    /// because the thing it protects is global: `SelectedImage` already notes that
    /// ~50MB of materialised image data is enough to get this app jetsammed, so the
    /// budget is the same 24MB one send is allowed to carry.
    static let maxQueuedBytes = SelectedImage.maxTotalBase64Length

    /// Badge on a banked bubble. The web console's word, so the two surfaces
    /// describe the same state the same way.
    static let badge = "Queued"
    /// …and once a POST is out for it, the session queue sheet's word.
    static let deliveringBadge = "Delivering…"

    /// What VoiceOver hears. The visible capsule has room for one word; the
    /// promise the word stands for still has to be sayable.
    static let badgeAccessibilityLabel = "Queued, delivers when the current reply finishes"
    static let deliveringAccessibilityLabel = "Delivering now, too late to withdraw"

    /// Take it back before it goes out. Same verb the session queue sheet's swipe
    /// action uses.
    static let withdraw = "Withdraw"
    static let withdrawAccessibilityLabel = "Withdraw queued message"

    /// Why a send could not be banked. The composer turns this into a sentence and
    /// puts the words back where the user can see them.
    enum Refusal: Equatable {
        case noConversation
        case countCeiling
        case byteCeiling

        var notice: String {
            switch self {
            case .noConversation:
                return "That message could not be sent yet. It is back in the composer, ready to try again."
            case .countCeiling:
                return "\(maxQueuedPerConversation) messages are already waiting to send. Wait for one to go out before adding another."
            case .byteCeiling:
                return "The messages waiting to send are holding as many photos as they can. Send one before attaching more."
            }
        }
    }

    /// Is there anything here worth banking? Mirrors the composer's own send
    /// guard: text that is only whitespace is nothing, and images alone are a
    /// message (today's send accepts them with empty text).
    static func hasContent(text: String, images: [Data]) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty
    }

    /// May one more message be banked for this conversation, and if not, why not?
    static func refusal(
        toEnqueueInto queue: [QueuedSend], conversationID: String?, agentID: String,
        newBytes: Int
    ) -> Refusal? {
        guard let conversationID else { return .noConversation }
        let mine = queue.filter { $0.conversationID == conversationID && $0.agentID == agentID }
        if mine.count >= maxQueuedPerConversation { return .countCeiling }
        let used = queue.reduce(0) { $0 + $1.byteCount }
        // A message with no attachments is never refused for bytes: it costs
        // nothing, and refusing it would strand the one thing that could drain the
        // queue back under the budget.
        if newBytes > 0, used + newBytes > maxQueuedBytes { return .byteCeiling }
        return nil
    }

    /// The composer's standing notice, or nil. Derived rather than latched, so it
    /// appears while a ceiling is reached (before a tap is refused) and clears
    /// itself the moment a message goes out.
    static func ceilingNotice(
        _ queue: [QueuedSend], conversationID: String?, agentID: String
    ) -> String? {
        guard let conversationID else { return nil }
        switch refusal(toEnqueueInto: queue, conversationID: conversationID,
                       agentID: agentID, newBytes: 1) {
        case .countCeiling: return Refusal.countCeiling.notice
        case .byteCeiling: return Refusal.byteCeiling.notice
        case .noConversation, nil: return nil
        }
    }

    /// Drop entries whose conversation the server no longer lists.
    ///
    /// Hygiene, not safety: the drain already refuses to post anywhere but the
    /// conversation an entry names, so a deleted conversation can never receive
    /// one. That makes every doubt here resolvable in the same direction, and there
    /// are three, each of which would otherwise delete words the user is still owed:
    ///  - A READ THAT DID NOT LAND. An empty set from a failed fetch is
    ///    indistinguishable from "every conversation was deleted", so callers pass
    ///    only a list that actually arrived.
    ///  - ANOTHER AGENT'S ENTRIES. The list is scoped to ONE console agent, so it
    ///    can only judge that agent's conversations; without this, switching from
    ///    Walnut to Mentor wiped everything banked under Walnut.
    ///  - A TRUNCATED PAGE. The list is a page, not a census: an absent
    ///    conversation there may simply be further down than we asked for.
    static func pruned(
        _ queue: [QueuedSend], listedConversations: Set<String>,
        agentID: String, listWasTruncated: Bool
    ) -> [QueuedSend] {
        guard !listWasTruncated else { return queue }
        return queue.filter {
            $0.agentID != agentID || listedConversations.contains($0.conversationID)
        }
    }

    /// Index of the next entry that may be POSTED right now: the oldest `pending`
    /// one belonging to the conversation and agent on screen.
    ///
    /// Not simply `first`. The queue spans conversations, so a head belonging to a
    /// conversation the user has left would otherwise block every entry behind it,
    /// and the message they are looking at would never go out. `processing` entries
    /// are skipped because a POST is already out for them.
    static func nextDeliverable(
        _ queue: [QueuedSend], conversationID: String?, agentID: String
    ) -> Int? {
        guard let conversationID else { return nil }
        return queue.firstIndex {
            $0.status == .pending && $0.conversationID == conversationID
                && $0.agentID == agentID
        }
    }

    /// Does this failure earn an AUTOMATIC re-send?
    ///
    /// Two questions have to answer yes, and they are different questions. First,
    /// did the request provably never reach the server? The queue delivers on its
    /// own, and `POST /conversations/:id/messages` takes no client-minted message
    /// id, so it cannot dedupe a second attempt the way the session queue can
    /// (`SendRetryPolicy` mints `qm-*` ids precisely because that endpoint DOES).
    /// At-least-once against an endpoint with no idempotency key means the agent
    /// can be handed the same instruction twice, which for an instruction is worse
    /// than not sending it at all. Second, could the SAME bytes plausibly succeed
    /// next time? A refusal the server read and declined (a 4xx) is safe to repeat
    /// but pointless: identical bytes get the identical refusal, and an entry that
    /// is re-banked on every settle never leaves the head of its conversation's
    /// queue, so it blocks everything typed after it while wearing a `Queued` badge
    /// that is now a lie.
    ///
    /// So only two shapes qualify: the connection was never established (offline,
    /// refused, DNS, host not found), and a rate limit, which is the one refusal a
    /// later identical attempt is expected to clear. Everything else becomes the
    /// ordinary retryable failed bubble, where a human decides: a timeout, a
    /// connection lost mid-flight, any 5xx (all inconclusive, the server may have
    /// the message), and any other 4xx (conclusive, and not going to change). Note
    /// the timeout half is DELIBERATELY the opposite of
    /// `SendRetryPolicy.isRetryableTransport`, which retries a timeout: that path
    /// carries a stable id and this one has none.
    static func earnsAutomaticRetry(_ error: Error) -> Bool {
        guard let apiError = error as? APIError else { return false }
        switch apiError {
        case .notConfigured, .rateLimited:
            return true
        case .network(let underlying):
            return neverOpenedConnection(underlying as NSError)
        case .server, .unauthorized, .cancelled, .badResponse:
            // A 409 `turn_active` never reaches here: it is its own case (the front
            // of the queue), handled by the caller before this rule is consulted.
            return false
        }
    }

    /// Did the server read this message and decline it? A refusal is conclusive
    /// (nothing was started) and personal to the message (the bytes are what it
    /// objected to), which is what lets the drain move on to the entry behind it
    /// instead of stopping the way it does for a network or server failure. A 409
    /// `turn_active` is not one: that refuses the TIMING, and the caller handles it.
    static func isConclusiveRefusal(_ error: Error) -> Bool {
        guard let apiError = error as? APIError else { return false }
        switch apiError {
        case .server(let status, let code, _, _, _):
            return status >= 400 && status < 500 && code != "turn_active"
        case .unauthorized:
            return true
        case .notConfigured, .rateLimited, .network, .cancelled, .badResponse:
            return false
        }
    }

    /// NSURLError codes that mean the request never left this device. A timeout and
    /// a mid-flight drop are deliberately ABSENT: the server may have the message.
    static func neverOpenedConnection(_ error: NSError) -> Bool {
        guard error.domain == NSURLErrorDomain else { return false }
        switch error.code {
        case NSURLErrorCannotConnectToHost,
             NSURLErrorNotConnectedToInternet,
             NSURLErrorDNSLookupFailed,
             NSURLErrorCannotFindHost,
             NSURLErrorDataNotAllowed,
             NSURLErrorInternationalRoamingOff:
            return true
        default:
            return false
        }
    }

    /// Make a queue read back from disk safe to act on.
    ///
    /// A `processing` entry was mid-POST when the process died, which is the one
    /// state where NOBODY can say whether the server has the message. Both automatic
    /// answers are wrong: re-sending may hand the agent the same instruction twice
    /// (no idempotency key on this endpoint, see `earnsAutomaticRetry`), and dropping
    /// it deletes words the user committed. So it becomes `undecided` — visible, in
    /// full, one tap from going out, and untouchable by every automatic trigger.
    static func restored(_ queue: [QueuedSend]) -> [QueuedSend] {
        queue.map { $0.status == .processing ? $0.with(status: .undecided) : $0 }
    }
}
