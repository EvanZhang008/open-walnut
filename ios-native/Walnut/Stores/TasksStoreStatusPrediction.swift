import Foundation

/// A task's `user_status` is DERIVED by the server (`src/core/user-status-sync.ts`): the dot, the
/// status pill, every Needs you count and an Org node's thread number read it, and no write of a
/// phase or a thread sets it. So the phone predicts it on the tap (the web's
/// `hooks/status-prediction.ts`, the same rule):
///
///   - `base` is the status the server last gave. A server row that still carries it has not been
///     derived again, so the prediction stays laid over it.
///   - a server row carrying anything else IS the answer: the prediction goes, whether the answer
///     agrees with it or not. Except while the writes it predicts are still out (`live`): the
///     server's new status is made the base and the prediction is made again over it, so an
///     event about an earlier change never flips the row back under a write still on its way.
///   - a refused write undoes it (the returned closure); no answer within
///     `predictionSeconds`: the server derived the same status again, so the prediction was wrong
///     and its last word goes back.
struct StatusPrediction {
    var base: WalnutUserStatus?
    var predicted: WalnutUserStatus?
    let make: (WalnutTask) -> WalnutUserStatus?
    let live: (() -> Bool)?
    let madeAt: Date
    let token: Int
    var expiry: Task<Void, Never>?
}

extension TasksStore {
    nonisolated static let predictionSeconds: Double = 10

    static func withUserStatus(_ row: WalnutTask, _ status: WalnutUserStatus?) -> WalnutTask {
        var row = row
        row.userStatus = status
        return row
    }

    /// Lay `make`'s status over the row now. Returns the undo (a refused write calls it); a no-op
    /// when the row is not listed or would read the same.
    @discardableResult
    func predictStatus(_ id: String, live: (() -> Bool)? = nil,
                       make: @escaping (WalnutTask) -> WalnutUserStatus?) -> () -> Void {
        guard let idx = tasks.firstIndex(where: { $0.id == id }) else { return {} }
        // The row already carries an earlier prediction: a second one builds on it, and the
        // server's last word stays the base.
        let row = tasks[idx]
        let prior = statusPredictions[id]
        let predicted = make(row)
        guard predicted != row.userStatus else { return {} }
        prior?.expiry?.cancel()
        predictionSeq += 1
        let token = predictionSeq
        var entry = StatusPrediction(base: prior?.base ?? row.userStatus, predicted: predicted, make: make,
                                     live: live, madeAt: Date(), token: token)
        entry.expiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.predictionSeconds))
            guard !Task.isCancelled else { return }
            self?.expirePrediction(id, token: token)
        }
        statusPredictions[id] = entry
        tasks[idx] = Self.withUserStatus(row, predicted)
        return { [weak self] in self?.withdrawPrediction(id, token: token) }
    }

    /// A refused write: the server's last status comes back on the row.
    func withdrawPrediction(_ id: String, token: Int) {
        guard let entry = statusPredictions[id], entry.token == token else { return }
        entry.expiry?.cancel()
        statusPredictions[id] = nil
        if let idx = tasks.firstIndex(where: { $0.id == id }), tasks[idx].userStatus == entry.predicted {
            tasks[idx] = Self.withUserStatus(tasks[idx], entry.base)
        }
    }

    /// No answer in time. While its writes are still out it waits on (a slow relay): the write's
    /// own answer decides then. While the feed is down no answer can come by it: the next list
    /// read decides (`dropUnansweredPredictions`).
    private func expirePrediction(_ id: String, token: Int) {
        guard let entry = statusPredictions[id], entry.token == token else { return }
        if entry.live?() == true || feedState != .live {
            var again = entry
            again.expiry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(Self.predictionSeconds))
                guard !Task.isCancelled else { return }
                self?.expirePrediction(id, token: token)
            }
            statusPredictions[id] = again
            return
        }
        withdrawPrediction(id, token: token)
    }

    /// A row the server sent, as the phone draws it: a standing prediction laid over a status it
    /// has not derived again. `readStartedAt`: when a list read left; one that left before the
    /// prediction was made carries an older status, which is never the server's answer to it.
    func overPrediction(_ row: WalnutTask, readStartedAt: Date? = nil) -> WalnutTask {
        guard var p = statusPredictions[row.id] else { return row }
        if let started = readStartedAt, started < p.madeAt { return Self.withUserStatus(row, p.predicted) }
        if row.userStatus == p.base { return Self.withUserStatus(row, p.predicted) }
        // More writes of the same kind are still out (a second thread acted on): the server's
        // status is the new base, and the prediction is made again over it, not dropped.
        if p.live?() == true {
            let again = p.make(row)
            if again != row.userStatus {
                p.base = row.userStatus
                p.predicted = again
                statusPredictions[row.id] = p
                return Self.withUserStatus(row, again)
            }
        }
        p.expiry?.cancel()
        statusPredictions[row.id] = nil
        return row
    }

    /// After a list read that left well after a prediction was made (the server derives a hand's
    /// change within about 100 ms): a row it still brought with the old status means the server
    /// derived the same one, so the prediction was wrong and goes, as its expiry would.
    func dropUnansweredPredictions(readStartedAt: Date) {
        for (id, p) in statusPredictions where p.live?() != true
            && readStartedAt.timeIntervalSince(p.madeAt) > Self.deriveSeconds {
            withdrawPrediction(id, token: p.token)
        }
    }

    /// How long the server may take to derive a hand's change (its fast lane is about 100 ms).
    nonisolated static let deriveSeconds: Double = 2

    /// The fields of a status the counts and badges read moved (not a timestamp or its words).
    nonisolated static func countedStatusMoved(_ a: WalnutUserStatus?, _ b: WalnutUserStatus?) -> Bool {
        a?.state != b?.state || a?.source != b?.source || a?.threads != b?.threads
            || a?.toRead != b?.toRead || a?.category != b?.category || (a?.snoozed == nil) != (b?.snoozed == nil)
    }

    /// Tell the stores that count by statuses which moved in a list read (the feed's upserts do
    /// the same one row at a time).
    func postStatusMoves(from before: [String: WalnutUserStatus?], to rows: [WalnutTask]) {
        var moved: [String] = []
        var letters = false
        for row in rows {
            guard let was = before[row.id], Self.countedStatusMoved(was, row.userStatus) else { continue }
            moved.append(row.id)
            if was?.source == "letter" || row.userStatus?.source == "letter" { letters = true }
        }
        guard !moved.isEmpty, let hub = signalHub else { return }
        for id in moved { hub.post(.statusChanged(taskId: id)) }
        if letters { hub.post(.inboxChanged) }
    }

    /// Two rows that agree on every field a hand's edit sets (`applyEdit`): a replay of one edit.
    nonisolated static func sameEditedFields(_ a: WalnutTask, _ b: WalnutTask) -> Bool {
        a.id == b.id && a.title == b.title && a.status == b.status && a.phase == b.phase
            && a.priority == b.priority && a.project == b.project && a.dueDate == b.dueDate
            && a.startDate == b.startDate && a.endDate == b.endDate && a.unread == b.unread
            && a.watchedAt == b.watchedAt && a.backgroundAt == b.backgroundAt
    }

    /// `overPrediction` over a whole list, touching only the rows that carry one.
    func overPredictions(_ rows: [WalnutTask], readStartedAt: Date? = nil) -> [WalnutTask] {
        guard !statusPredictions.isEmpty else { return rows }
        var rows = rows
        for id in Array(statusPredictions.keys) {
            guard let idx = rows.firstIndex(where: { $0.id == id }) else { continue }
            rows[idx] = overPrediction(rows[idx], readStartedAt: readStartedAt)
        }
        return rows
    }

    /// The status the server last gave for a task (its prediction's base while one stands).
    func serverStatus(of row: WalnutTask) -> WalnutUserStatus? {
        statusPredictions[row.id].map(\.base) ?? row.userStatus
    }

    // MARK: - A phase set by hand

    /// The phase a status edit moves the task to (server `phaseFromStatus`), nil when the phase
    /// already means that status (a task in Need action set In progress stays there).
    nonisolated static func phase(for status: String, from phase: String) -> String? {
        let statusOfPhase: [String: String] = [
            "TODO": "todo", "WAITING": "todo", "IN_PROGRESS": "in_progress",
            "NEED_ACTION": "in_progress", "COMPLETE": "done",
        ]
        if statusOfPhase[phase] == status { return nil }
        switch status {
        case "todo": return "TODO"
        case "in_progress": return "IN_PROGRESS"
        case "done": return "COMPLETE"
        default: return nil
        }
    }

    /// The status a phase set by hand reads as before the server derives it, by the server's own
    /// rules (the web's `predictedForPhase`), keeping the node's Threads counts:
    ///   - a turn running now reads Working whatever the phase, so a hand's phase moves nothing;
    ///   - In progress set by hand reads Waiting (a phase starts no turn);
    ///   - Not started or In progress with no session is Waiting of kind `not-started`;
    ///   - a snoozed row, Main and a lead (their status is their Threads and team) are left alone.
    /// `fromPhase`: the phase before the hand's change (the row itself may already show the new one).
    nonisolated static func predictedStatus(forPhase phase: String, fromPhase: String, row: WalnutTask,
                                            hasSession: Bool) -> WalnutUserStatus? {
        if phase == "COMPLETE" || fromPhase == phase { return row.userStatus }
        if row.liveActivity != nil { return row.userStatus }
        if row.userStatus?.snoozed != nil || row.orgRole != nil { return row.userStatus }
        let state = phase == "NEED_ACTION" ? "needs" : "waiting"
        let notStarted = state == "waiting" && (phase == "TODO" || phase == "IN_PROGRESS") && !hasSession
        if let was = row.userStatus, was.state == state, (was.toRead ?? "").isEmpty, was.snoozed == nil,
           (was.kind == "not-started") == notStarted {
            return was
        }
        var s = WalnutUserStatus(state: state)
        if notStarted { s.kind = "not-started" }
        s.threads = row.userStatus?.threads
        return s
    }

    /// Predict the status a status edit implies for `id`, while `live` says its write is out. Call
    /// it before the edit's own optimistic row is written (that row carries the new phase).
    func predictPhase(_ id: String, status: String, live: @escaping () -> Bool) -> () -> Void {
        guard let row = tasks.first(where: { $0.id == id }),
              let phase = Self.phase(for: status, from: row.phase) else { return {} }
        let fromPhase = row.phase
        let hasSession = sessions.contains { $0.taskId == id } || !(knownSessionIds(for: id) ?? []).isEmpty
        return predictStatus(id, live: live) { current in
            Self.predictedStatus(forPhase: phase, fromPhase: fromPhase, row: current, hasSession: hasSession)
        }
    }
}
