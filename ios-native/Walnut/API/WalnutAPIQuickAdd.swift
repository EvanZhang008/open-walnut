import Foundation

// MARK: - Quick-add backfill endpoints (additive /api/v1, docs/reference/api-v1.md)
//
// The NL quick-add flow (QuickAddRow → TasksStore.quickAdd) creates the task
// instantly with the raw text, then upgrades it in place once the background
// quick-parse lands. These are the two wire calls that upgrade path needs
// beyond what WalnutAPI/Wave1/Wave2 already expose: a PATCH that can carry
// `start_date` (the Wave 1 additive field the base `updateTask` predates) and
// the focus-tier setter.

extension WalnutAPI {
    /// PATCH /api/v1/tasks/:id with the parse-backfill field set. Only non-nil
    /// fields ride the wire (synthesized Encodable omits nils); callers must
    /// pass at least one — the server 400s an empty patch.
    /// Answers the updated task in the same slim ProjectedTask shape.
    func backfillTask(
        id: String, title: String? = nil, dueDate: String? = nil,
        startDate: String? = nil, priority: String? = nil, project: String? = nil
    ) async throws -> WalnutTask {
        struct Body: Encodable {
            let title: String?
            let due_date: String?
            let start_date: String?
            let priority: String?
            let project: String?
        }
        let updated: TaskCreated = try await send(
            "PATCH", "/tasks/\(escape(id))",
            body: Body(
                title: title, due_date: dueDate, start_date: startDate,
                priority: priority, project: project
            )
        )
        return updated.task
    }

    /// PUT /api/v1/focus/tasks/:id/tier — move a PINNED task between tiers
    /// (`focus|satellite|backlog|wait` or a registered `ct_*` id). The task
    /// must already be pinned (pin first via `pinTask`). Answers the full
    /// tier split so callers can adopt the authoritative buckets.
    @discardableResult
    func setTaskFocusTier(id: String, tier: String) async throws -> FocusTierResult {
        try await send(
            "PUT", "/focus/tasks/\(escape(id))/tier", body: ["tier": tier]
        )
    }
}
