import Foundation

/// The messages a person sent a session that have not reached its CLI yet, for the
/// session page: listed above the composer, edited, sent now, or withdrawn.
///
/// Separate from `SessionConversationStore` on purpose, like the lifecycle controller:
/// it writes nothing into the timeline's rendering state. The two meet at two seams
/// only (`onWithdrawn`, `onEdited`), which keep the message's bubble in step with the
/// row: a withdrawn row's bubble would otherwise sit on the page for good, and an
/// edited row's transcript line would never match its old bubble.
///
/// The server has no queue event on the session stream, so this reads `GET /queue`:
/// on the page opening, after a send is accepted, when a turn starts or ends, and on a
/// clock whose pace follows how likely the answer is to change (`pollInterval`).
@Observable
@MainActor
final class SessionQueueModel {
    private let api: SessionQueueTransport
    let sessionId: String

    private(set) var rows: [SessionQueuedMessage] = []
    private(set) var loaded = false
    private(set) var busyIds: Set<String> = []
    /// One line the page shows under the list: why an action did not go through.
    var notice: String?
    /// The message the person just withdrew: the strip offers to put it back for a few
    /// seconds, so a stray tap on the cross costs nothing.
    private(set) var withdrawn: WithdrawnQueuedMessage?
    @ObservationIgnored private var withdrawnClear: Task<Void, Never>?
    /// How long a withdrawn message can be taken back.
    nonisolated(unsafe) static var undoWindow: TimeInterval = 10

    /// The queue row with this id was withdrawn (server confirmed).
    @ObservationIgnored var onWithdrawn: ((String) -> Void)?
    /// The queue row with this id now holds these words (server confirmed).
    @ObservationIgnored var onEdited: ((String, String) -> Void)?

    /// Rows move under the finger when one goes or comes back: a row action right behind another
    /// one (the second tap of a double tap, Undo then a cross) would land on a different row.
    @ObservationIgnored private var rowTaps = SeatTapGuard(span: 1.0)

    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var failures = 0
    /// Bumps per accepted write so a slower GET that started before it cannot put the
    /// old list back over it.
    @ObservationIgnored private var generation = 0

    init(sessionId: String, api: SessionQueueTransport = WalnutAPI()) {
        self.sessionId = sessionId
        self.api = api
    }

    var hasRows: Bool { !rows.isEmpty }

    /// True = this tap on a row action (cross, Send, Undo) is a decision; false = it came right
    /// behind another one and is ignored.
    func takeRowTap(at now: Date = Date()) -> Bool {
        guard rowTaps.allows(at: now) else { return false }
        rowTaps.record(at: now)
        return true
    }

    /// A tap that is always a decision (Undo, right after a cross) but still shields the rows
    /// that move into its place.
    func noteRowTap(at now: Date = Date()) {
        rowTaps.record(at: now)
    }

    // MARK: - Reading

    /// The pace of the read clock, nil = do not poll. Fast while there is something to
    /// watch (a turn runs, or rows wait), slow when idle (a message from another surface
    /// still shows up), and backed off while the server does not answer.
    static func pollInterval(turnRunning: Bool, hasRows: Bool, failures: Int) -> TimeInterval {
        let base: TimeInterval
        switch (turnRunning, hasRows) {
        case (true, true): base = 3
        case (false, true): base = 5
        case (true, false): base = 6
        case (false, false): base = 15
        }
        return min(base * pow(2, Double(min(failures, 4))), 60)
    }

    func refresh() async {
        let started = generation
        do {
            let next = try await api.sessionQueue(id: sessionId)
            guard started == generation else { return }
            failures = 0
            if next != rows { rows = next }
            loaded = true
        } catch {
            if let e = error as? APIError, e.isCancelled { return }
            failures += 1
            // A list that cannot be read keeps what it last showed: an empty strip is a claim.
            loaded = true
        }
    }

    /// Read now and keep reading while the page is up. `turnRunning` is asked each lap.
    func start(turnRunning: @escaping @MainActor () -> Bool) {
        stop()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                let wait = Self.pollInterval(turnRunning: turnRunning(), hasRows: self.hasRows, failures: self.failures)
                try? await Task.sleep(for: .seconds(wait))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        clearUndo()
    }

    // MARK: - Writing

    /// Optimistic removal with a rollback. A 409 means the message already started
    /// delivering: the server's list is the truth, so read it again instead of restoring.
    func withdraw(_ row: SessionQueuedMessage) async {
        guard !busyIds.contains(row.id) else { return }
        busyIds.insert(row.id)
        notice = nil
        generation += 1
        let original = rows
        rows.removeAll { $0.id == row.id }
        defer { busyIds.remove(row.id) }
        do {
            try await api.deleteQueuedMessage(sessionId: sessionId, messageId: row.id)
            onWithdrawn?(row.id)
            let behind = original.drop(while: { $0.id != row.id }).dropFirst().filter { $0.status == "pending" }
            offerUndo(of: row, followers: Array(behind))
            AppLog.info("session", "queued message withdrawn", ["sessionId": sessionId, "messageId": row.id])
        } catch let error as APIError where error.isConflict {
            notice = "That message already started delivering."
            await refresh()
        } catch {
            rows = original
            notice = SessionConversationStore.queueFailureText(error)
        }
    }

    private func offerUndo(of row: SessionQueuedMessage, followers: [SessionQueuedMessage]) {
        withdrawnClear?.cancel()
        withdrawn = WithdrawnQueuedMessage(
            id: row.id, text: row.message, followers: followers, wasSetAside: row.status == "parked"
        )
        withdrawnClear = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.undoWindow))
            guard !Task.isCancelled else { return }
            self?.withdrawn = nil
        }
    }

    /// The offer ends: it was taken, or the page moved on.
    func clearUndo() {
        withdrawnClear?.cancel()
        withdrawnClear = nil
        if withdrawn != nil { withdrawn = nil }
    }

    /// Take a waiting message off the line so Undo can put it back behind the one it follows.
    /// True = the server let it go; false = it already started going out, and stays where it is.
    func pullForRequeue(_ row: SessionQueuedMessage) async -> Bool {
        guard !busyIds.contains(row.id) else { return false }
        generation += 1
        do {
            try await api.deleteQueuedMessage(sessionId: sessionId, messageId: row.id)
            rows.removeAll { $0.id == row.id }
            onWithdrawn?(row.id)
            return true
        } catch {
            await refresh()
            return false
        }
    }

    /// Save new words for a pending row. True = the server holds them now.
    func edit(_ row: SessionQueuedMessage, to text: String) async -> Bool {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty, !busyIds.contains(row.id) else { return false }
        busyIds.insert(row.id)
        notice = nil
        generation += 1
        defer { busyIds.remove(row.id) }
        do {
            try await api.editQueuedMessage(sessionId: sessionId, messageId: row.id, text: words)
            if let index = rows.firstIndex(where: { $0.id == row.id }) {
                rows[index] = SessionQueuedMessage(
                    id: row.id, message: words, status: row.status, enqueuedAt: row.enqueuedAt
                )
            }
            onEdited?(row.id, words)
            return true
        } catch let error as APIError where error.isConflict {
            notice = "That message already started delivering."
            await refresh()
            return false
        } catch {
            notice = SessionConversationStore.queueFailureText(error)
            return false
        }
    }

    /// Send a queued message now. While a turn runs this stops it first (`interrupt`),
    /// so the row goes out in a fresh turn; the list is read again after.
    func sendNow(_ row: SessionQueuedMessage, interrupt: Bool) async -> Bool {
        guard !busyIds.contains(row.id) else { return false }
        busyIds.insert(row.id)
        notice = nil
        generation += 1
        defer { busyIds.remove(row.id) }
        do {
            try await api.sendQueuedNow(messageId: row.id, interrupt: interrupt)
            AppLog.info("session", "queued message sent now", [
                "sessionId": sessionId, "messageId": row.id, "interrupt": String(interrupt),
            ])
            await refresh()
            return true
        } catch let error as APIError where error.isConflict || error.code == "not_queued" {
            // The send-now route names a gone row `not_queued`; the queue routes say `conflict`.
            notice = "That message is no longer waiting."
            await refresh()
            return false
        } catch {
            notice = SessionConversationStore.queueFailureText(error)
            return false
        }
    }
}

/// A queued message the person withdrew a moment ago.
struct WithdrawnQueuedMessage: Equatable {
    let id: String
    let text: String
    /// The messages that stood behind it and still wait: Undo sends them again behind it, so the
    /// order is what it was.
    let followers: [SessionQueuedMessage]
    /// A Stop had set it aside: Undo hands the words back to the message box instead of sending
    /// them (nothing had asked for them to go).
    let wasSetAside: Bool
}

extension Array where Element == SessionQueuedMessage {
    /// The one line over the list: what is about to happen to the messages in it.
    func headline(turnRunning: Bool) -> String {
        if contains(where: { $0.status == "processing" }) { return "Going out now" }
        if contains(where: { $0.status == "pending" }) {
            return turnRunning ? "Waiting to go in" : "Going out now"
        }
        if contains(where: { $0.status == "parked" }) { return "Stopped \u{00B7} not sent" }
        if contains(where: { $0.status == "held" }) { return "Waiting for your Mac" }
        return ""
    }
}

extension SessionConversationStore {
    /// A queue write failed: the sentence says what to do, never a status code.
    static func queueFailureText(_ error: Error) -> String {
        guard let apiError = error as? APIError else { return error.localizedDescription }
        switch apiError.code {
        case "bridge_offline": return "Can't reach your Mac right now. Try again in a moment."
        case "not_found": return "This session no longer exists on the server."
        case "not_supported_cloud": return "Send now needs your Mac online."
        default: return SessionControlsSheet.friendlyControlError(error)
        }
    }
}

extension SessionQueuedMessage {
    /// What the row says about itself when it is not simply waiting for the turn to end.
    var statusNote: String? {
        switch status {
        case "processing": return "Delivering…"
        case "parked": return "Not sent"
        case "held": return "Waiting for your Mac"
        default: return nil
        }
    }

    /// A pending or set-aside row can be edited, withdrawn or sent now (a person's Send now
    /// puts a set-aside row back in line). A row being delivered or held on the companion
    /// can be none of them (the server answers 409).
    var canEdit: Bool { status == "pending" || status == "parked" }
    var canWithdraw: Bool { status == "pending" || status == "parked" }
    var canSendNow: Bool { status == "pending" || status == "parked" }
}
