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
    nonisolated(unsafe) static var undoWindow: TimeInterval = 15

    /// The queue row with this id was withdrawn (server confirmed).
    @ObservationIgnored var onWithdrawn: ((String) -> Void)?
    /// The queue row with this id now holds these words (server confirmed).
    @ObservationIgnored var onEdited: ((String, String) -> Void)?

    /// Rows move under the finger when one goes or comes back: a row action right behind another
    /// one (the second tap of a double tap, Undo then a cross) would land on a different row.
    @ObservationIgnored private var rowTaps = SeatTapGuard(span: 1.0)

    /// While Undo puts messages back in line (it takes the ones behind them off and sends all again so the
    /// order is what it was), the list stands as it will end up: reading the server in between would show a
    /// half-done line. `restoreBefore` holds the ids from before it began; `keptTimes` the time each message
    /// had when it first went in, shown instead of the new row's.
    @ObservationIgnored private var restoring = false
    @ObservationIgnored private var restoreBefore: Set<String> = []
    @ObservationIgnored private var keptTimes: [String: String] = [:]
    /// Rows an interrupting send put in line for the moment before they go out: their bubble is on the page
    /// already, and a second copy under "Going out now" would only repeat it. Shown again when the time
    /// runs out, so a send that sticks is not hidden.
    @ObservationIgnored private var hiddenUntil: [String: Date] = [:]
    nonisolated(unsafe) static var goingOutSpan: TimeInterval = 4

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
        guard !restoring else { return }
        let started = generation
        do {
            let fetched = try await api.sessionQueue(id: sessionId)
            guard started == generation, !restoring else { return }
            let next = withKeptTimes(fetched.filter { !isHidden($0.id) })
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
        // A second withdrawal while the offer stands joins it: one Undo gives them all back.
        let before = withdrawn.map { $0.earlier + [$0] } ?? []
        withdrawn = WithdrawnQueuedMessage(
            id: row.id, text: row.message, followers: followers, wasSetAside: row.status == "parked",
            enqueuedAt: row.enqueuedAt, earlier: before.map(\.flattened)
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
            if !restoring { rows.removeAll { $0.id == row.id } }
            onWithdrawn?(row.id)
            return true
        } catch {
            await refresh()
            return false
        }
    }

    func hideWhileGoingOut(_ id: String) {
        hiddenUntil[id] = Date().addingTimeInterval(Self.goingOutSpan)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.goingOutSpan + 0.1))
            await self?.refresh()
        }
    }

    private func isHidden(_ id: String) -> Bool {
        guard let until = hiddenUntil[id] else { return false }
        if until > Date() { return true }
        hiddenUntil[id] = nil
        return false
    }

    /// Undo begins: show the line as it will stand once the messages are back, each at the place its time gives it.
    func beginRestore(gone: WithdrawnQueuedMessage) {
        restoring = true
        generation += 1
        restoreBefore = Set(rows.map(\.id))
        let back = gone.all.filter { !$0.wasSetAside }.map {
            SessionQueuedMessage(id: $0.id, message: $0.text, status: "pending", enqueuedAt: $0.enqueuedAt)
        }
        func time(_ row: SessionQueuedMessage) -> Date { row.enqueuedDate ?? .distantPast }
        rows = (rows + back).enumerated().sorted {
            time($0.element) == time($1.element) ? $0.offset < $1.offset : time($0.element) < time($1.element)
        }.map(\.element)
    }

    /// Undo is done (or stopped short): read the server again, and keep each returned message's first time.
    func endRestore(plan: RestorePlan) async {
        restoring = false
        generation += 1
        await refresh()
        let fresh = rows.filter { !restoreBefore.contains($0.id) }
        if fresh.count == plan.steps.count {
            for (row, step) in zip(fresh, plan.steps) {
                if let at = step.enqueuedAt { keptTimes[row.id] = at }
            }
            rows = withKeptTimes(rows)
        }
        restoreBefore = []
    }

    private func withKeptTimes(_ list: [SessionQueuedMessage]) -> [SessionQueuedMessage] {
        guard !keptTimes.isEmpty else { return list }
        keptTimes = keptTimes.filter { id, _ in list.contains { $0.id == id } }
        return list.map { row in
            guard let at = keptTimes[row.id] else { return row }
            return SessionQueuedMessage(id: row.id, message: row.message, status: row.status, enqueuedAt: at)
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

    /// Messages a Stop held back, in the order they stood in.
    var heldCount: Int { rows.filter { $0.status == "parked" }.count }

    /// Put every held-back message in line again, one after the other.
    func sendAllHeld() async {
        for row in rows.filter({ $0.status == "parked" }) {
            guard rows.contains(where: { $0.id == row.id && $0.status == "parked" }) else { continue }
            guard await sendNow(row, interrupt: false) else { return }
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

/// A queued message the person withdrew a moment ago (and, in `earlier`, the ones withdrawn just before it).
struct WithdrawnQueuedMessage: Equatable {
    let id: String
    let text: String
    /// The messages that stood behind it and still wait: Undo sends them again behind it, so the
    /// order is what it was.
    let followers: [SessionQueuedMessage]
    /// A Stop had set it aside: Undo hands the words back to the message box instead of sending
    /// them (nothing had asked for them to go).
    let wasSetAside: Bool
    /// When the server took it in: the order the messages stood in.
    var enqueuedAt: String? = nil
    var earlier: [WithdrawnQueuedMessage] = []

    /// This one without the ones before it.
    var flattened: WithdrawnQueuedMessage {
        WithdrawnQueuedMessage(id: id, text: text, followers: followers, wasSetAside: wasSetAside, enqueuedAt: enqueuedAt)
    }

    /// Every message one Undo gives back.
    var all: [WithdrawnQueuedMessage] { earlier + [flattened] }

    /// What Undo does: words to hand back to the message box, and the messages to send again in the
    /// order they stood in (a row still waiting behind one of them is taken off the line first, so it
    /// goes in after it).
    func restorePlan(rows: [SessionQueuedMessage]) -> RestorePlan {
        let items = all
        let aside = items.filter(\.wasSetAside).map(\.text)
        let waiting = items.filter { !$0.wasSetAside }
        let gone = Set(items.map(\.id))
        func time(_ iso: String?) -> Date { WalnutTask.parseISO(iso) ?? .distantPast }
        var entries: [(at: Date, step: RestorePlan.Step)] = waiting.map {
            (time($0.enqueuedAt), .init(text: $0.text, pullRowID: nil, enqueuedAt: $0.enqueuedAt))
        }
        var seen = Set<String>()
        for item in waiting {
            for later in item.followers where !gone.contains(later.id) && seen.insert(later.id).inserted {
                // Its words as they are now (it may have been edited meanwhile); gone from the line = gone.
                guard let current = rows.first(where: { $0.id == later.id }) else { continue }
                entries.append((time(current.enqueuedAt), .init(text: current.message, pullRowID: current.id, enqueuedAt: current.enqueuedAt)))
            }
        }
        let ordered = entries.enumerated().sorted {
            $0.element.at == $1.element.at ? $0.offset < $1.offset : $0.element.at < $1.element.at
        }
        return RestorePlan(draftText: aside.isEmpty ? nil : aside.joined(separator: "\n"), steps: ordered.map(\.element.step))
    }
}

struct RestorePlan: Equatable {
    struct Step: Equatable {
        let text: String
        let pullRowID: String?
        var enqueuedAt: String? = nil
    }
    let draftText: String?
    let steps: [Step]
}

extension Array where Element == SessionQueuedMessage {
    /// The one line over the list: what is about to happen to the messages in it.
    func headline(turnRunning: Bool) -> String {
        if contains(where: { $0.status == "processing" }) { return "Going out now" }
        if contains(where: { $0.status == "pending" }) {
            return turnRunning ? "Waiting to go in" : "Going out now"
        }
        if contains(where: { $0.status == "parked" }) { return turnRunning ? "Not sent" : "Stopped \u{00B7} not sent" }
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
