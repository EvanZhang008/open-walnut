import Foundation
import os

/// The demo's lock-screen work card (`GET /api/push/work-card`): the same numbers the real
/// server reads (src/core/push/work-card.ts), from the demo's own tasks, so "Try the demo"
/// shows the card and its lists with no server. Its stretch begins with the first read that
/// finds something working and ends, as the server's does, once nothing worked for `endGrace`;
/// the demo never pushes, so the card only changes while the app is open.
extension DemoServer {
    private struct CardStretch { var since: Date?; var idleSince: Date? }
    private static let cardStretch = OSAllocatedUnfairLock(initialState: CardStretch())
    /// src/core/push/work-card.ts END_GRACE_MS.
    static let endGrace: TimeInterval = 15 * 60

    /// A fresh demo has no stretch yet.
    static func resetWorkCard() { cardStretch.withLock { $0 = CardStretch() } }

    func workCard() -> DemoReply {
        let now = self.now
        let tasks = withState { $0.tasks.map(\.wire) }
        let working = tasks.filter { TeamStatusModel.state(of: $0) == .working }
        let since: Date? = Self.cardStretch.withLock { s in
            if !working.isEmpty {
                s.idleSince = nil
                if s.since == nil { s.since = now }
            } else if s.since != nil {
                let idle = s.idleSince ?? now
                s.idleSince = idle
                if now.timeIntervalSince(idle) >= Self.endGrace { s = CardStretch() }
            }
            return s.since
        }
        let from = since ?? now
        let needs = tasks.filter { TeamStatusModel.state(of: $0) == .needs }
            .sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
        let completed = tasks.filter { t in
            guard TeamStatusModel.state(of: t) == .done, let at = t.completedAtValue else { return false }
            return at >= from
        }
        var state: [String: Any] = [
            "working": working.count, "needs": needs.count, "completed": completed.count,
            "since": floor(from.timeIntervalSince1970), "updatedAt": floor(now.timeIntervalSince1970),
        ]
        if let first = needs.first {
            state["needsTitle"] = String(first.title.prefix(60))
            state["needsTaskId"] = first.id
        }
        return .object([
            "state": state,
            "lists": ["working": working.map(\.id), "needs": needs.map(\.id), "completed": completed.map(\.id)],
            "active": since != nil,
            "stretch": since.map { ISO8601DateFormatter().string(from: $0) } as Any,
        ])
    }
}
