import Foundation

/// What the model sheet reads to fill its Cost, Speed and Details rows.
protocol ModelSheetTransport {
    func sessionDetail(id: String) async throws -> SessionDetail
    func sessionCostFacts(id: String) async throws -> SessionCostFacts
}

extension WalnutAPI: ModelSheetTransport {}

/// The facts under the model sheet's two columns, for one session: its record (the
/// last turn's speed, the context, the engine and mode) and its cost and budget.
/// Asked once per open of the sheet, both at once, each bounded by `deadline`, so
/// a slow or older server leaves a row reading "n/a", never a spinner that stays
/// or an error alert: these are facts to glance at, not something the user asked
/// to load. The rows read "…" until their answer lands.
@Observable
@MainActor
final class ModelSheetFacts {
    enum Answer<Value> {
        case waiting
        case answered(Value)
        /// No answer: an older server (404), a replica whose Mac predates the route
        /// (needs_upgrade), the network, or the deadline.
        case missing
    }

    let sessionID: String
    private(set) var record: Answer<SessionDetail.Record> = .waiting
    private(set) var cost: Answer<SessionCostFacts> = .waiting
    @ObservationIgnored private let transport: ModelSheetTransport
    @ObservationIgnored private let deadline: Duration

    /// Longer than a healthy answer from the Mac over a replica, short enough that a
    /// row still reading "…" means something.
    static let defaultDeadline: Duration = .seconds(6)

    init(sessionID: String, transport: ModelSheetTransport = WalnutAPI(), deadline: Duration = defaultDeadline) {
        self.sessionID = sessionID
        self.transport = transport
        self.deadline = deadline
    }

    /// Ask for both; each row fills as its own answer lands.
    func load() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadRecord() }
            group.addTask { await self.loadCost() }
        }
    }

    private func loadRecord() async {
        let api = transport, id = sessionID
        do {
            record = .answered(try await Deadline.run(deadline) { try await api.sessionDetail(id: id).session })
        } catch {
            guard !Task.isCancelled else { return }
            AppLog.info("chat", "model sheet: session facts not read", ["session": id, "error": String(describing: error)])
            record = .missing
        }
    }

    private func loadCost() async {
        let api = transport, id = sessionID
        do {
            cost = .answered(try await Deadline.run(deadline) { try await api.sessionCostFacts(id: id) })
        } catch {
            guard !Task.isCancelled else { return }
            AppLog.info("chat", "model sheet: cost not read", ["session": id, "error": String(describing: error)])
            cost = .missing
        }
    }

    // MARK: - What the rows say

    /// The Cost row's value: "$102", "…" while asking, "n/a" with no answer.
    var costValue: String {
        switch cost {
        case .waiting: return "…"
        case .missing: return "n/a"
        case .answered(let facts): return ModelSheetFormat.costValue(facts.cost)
        }
    }

    /// The Cost row's dot: the budget paused the session.
    var budgetPaused: Bool {
        if case .answered(let facts) = cost { return facts.budget?.state == "paused" }
        return false
    }

    /// The Speed row's value: the session's average on its model ("128 tok/s avg"), the last
    /// turn's "239 tok/s" until a turn was counted, "—" with no measured turn.
    var speedValue: String {
        switch record {
        case .waiting: return "…"
        case .missing: return "n/a"
        case .answered(let r): return ModelSheetFormat.speedValue(r)
        }
    }

    var context: ModelSheetFormat.Context? {
        if case .answered(let r) = record { return ModelSheetFormat.context(r) }
        return nil
    }

    /// The Details row's dot (and what VoiceOver reads for it): "Context 93% full".
    var detailsWarning: String? { context?.warning }
}
