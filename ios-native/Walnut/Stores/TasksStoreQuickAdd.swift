import Foundation

// MARK: - NL quick-add (Things/Todoist-grade fast path)
//
// One line of text → task appears INSTANTLY → AI upgrades it in place.
//
//   1. Insert a local placeholder row synchronously (raw text as title) —
//      the user sees the task the moment they hit return.
//   2. POST /tasks with the raw title; adopt the server row (placeholder
//      swap + pending overlay so REPLICA refreshes keep it).
//   3. In parallel, POST /tasks/quick-parse; when it lands, PATCH the parsed
//      fields (cleaned title / due / start / priority / project) onto the
//      task and apply any pin tier — the row upgrades in place.
//
// The parse NEVER gates creation (a manual path always works: the text IS
// the task), and a parse failure simply leaves the raw-title task — no error
// UI on the happy path. Race safety: if the user edits/completes/deletes the
// row before the parse returns (userTouchedIds), or ANY writer changed it
// (updated_at moved — covers web/desktop edits arriving over SSE), the
// backfill is dropped wholesale — user intent always beats the AI.

extension TasksStore {
    /// Create a task from one line of natural language. Returns the created
    /// server row (the parse upgrade continues in the background). Throws
    /// only when the CREATE itself fails — the caller shows that error.
    /// `pinSeed` pre-pins the created task (focus-area quick add).
    @discardableResult
    func quickAdd(_ text: String, pinSeed: Bool = false) async throws -> WalnutTask {
        let raw = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
        guard !raw.isEmpty else { throw APIError.badResponse }

        // 1. Instant local placeholder (never blocks on the network).
        let placeholderId = "quickadd-\(UUID().uuidString)"
        let nowISO = ISO8601DateFormatter().string(from: Date())
        insertPlaceholder(WalnutTask(
            id: placeholderId, title: raw, status: "todo", phase: "TODO",
            priority: "none", project: "", dueDate: nil,
            createdAt: nowISO, updatedAt: nowISO, completedAt: nil,
            starred: nil, pinned: pinSeed ? true : nil, tags: nil, summary: nil
        ))

        // 2. Fire the parse NOW — it runs concurrently with the create POST,
        //    so the upgrade usually lands ~1s after the row appears.
        let parseTask = Task { [api] in try? await api.quickParseTask(text: raw) }

        let created: WalnutTask
        do {
            created = try await api.createTask(title: raw)
        } catch {
            parseTask.cancel()
            removePlaceholder(id: placeholderId)
            AppLog.warn("tasks", "quick-add create failed", ["error": error.localizedDescription])
            throw error
        }
        // pinSeed: adopt a locally-pinned copy so the row doesn't flash OUT of
        // the Pinned section between create and the pin call landing (the
        // server row is created unpinned; applyPin runs right below).
        let adopted = pinSeed ? Self.withPinned(created) : created
        adoptCreated(adopted, replacingPlaceholder: placeholderId)
        AppLog.info("tasks", "quick-add created", ["taskId": created.id, "pinSeed": String(pinSeed)])

        // 3. Background upgrade — never awaited by the caller.
        Task { [weak self] in
            if pinSeed {
                await self?.applyPin(taskId: created.id, tier: nil)
            }
            await self?.backfillFromParse(created: created, raw: raw, parseTask: parseTask, pinAlreadySeeded: pinSeed)
        }
        return created
    }

    /// Await the parse and PATCH its fields onto the created task — unless
    /// the row moved on (user edit here, or any writer via updated_at).
    private func backfillFromParse(
        created: WalnutTask, raw: String,
        parseTask: Task<QuickParsedTask?, Never>, pinAlreadySeeded: Bool
    ) async {
        guard let parse = await parseTask.value, isActive else { return }
        guard backfillStillSafe(created) else { return }

        // Only fields the parse actually produced ride the PATCH; a title
        // identical to the raw text is the parser's fallback echo, not a
        // suggestion (same rule as the web QuickTaskComposer).
        let cleaned = parse.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = (!cleaned.isEmpty && cleaned != raw) ? cleaned : nil
        let priority = ["immediate", "important", "backlog"].contains(parse.priority ?? "") ? parse.priority : nil
        let project = parse.project?.trimmingCharacters(in: .whitespaces)

        // end_date is the end of parse.startDate's block, so it only rides when
        // the start does — the server refuses an end with no start.
        let endDate = parse.startDate != nil ? parse.endDate : nil

        if title != nil || parse.dueDate != nil || parse.startDate != nil
            || priority != nil || (project?.isEmpty == false) {
            do {
                let updated = try await patchBackfill(
                    id: created.id, title: title, dueDate: parse.dueDate,
                    startDate: parse.startDate, endDate: endDate, priority: priority,
                    project: (project?.isEmpty == false) ? project : nil
                )
                // Re-check: the user may have edited DURING the PATCH.
                if backfillStillSafe(created) { adoptBackfilled(updated) }
                AppLog.info("tasks", "quick-add parse applied", ["taskId": created.id])
            } catch {
                // Parse upgrade is best-effort — the raw-title task stays.
                AppLog.warn("tasks", "quick-add backfill failed", ["taskId": created.id, "error": error.localizedDescription])
            }
        }

        if !pinAlreadySeeded, let tier = parse.pinTier, backfillStillSafe(created) {
            await applyPin(taskId: created.id, tier: tier)
        }
    }

    /// True while the backfill may still write: the user hasn't mutated the
    /// task on this device, and no OTHER writer bumped updated_at (SSE keeps
    /// the local row current, so a web-side edit shows up here too).
    private func backfillStillSafe(_ created: WalnutTask) -> Bool {
        guard !isUserTouched(created.id) else { return false }
        guard let current = tasks.first(where: { $0.id == created.id }) else {
            // Row gone (deleted, or REPLICA refresh dropped it) — the pending
            // overlay path still PATCHes safely, but without a visible row we
            // can't judge freshness. Only proceed when it's still overlaid.
            return pendingCreatedIds.contains(created.id)
        }
        return current.updatedAt == created.updatedAt
    }

    /// One backfill PATCH; a project source conflict (409) retries once
    /// WITHOUT the project so the date/title upgrade still lands.
    private func patchBackfill(
        id: String, title: String?, dueDate: String?, startDate: String?,
        endDate: String?, priority: String?, project: String?
    ) async throws -> WalnutTask {
        do {
            return try await api.backfillTask(
                id: id, title: title, dueDate: dueDate,
                startDate: startDate, endDate: endDate, priority: priority, project: project
            )
        } catch let error as APIError where error.isConflict && project != nil {
            return try await api.backfillTask(
                id: id, title: title, dueDate: dueDate,
                startDate: startDate, endDate: endDate, priority: priority, project: nil
            )
        }
    }

    /// Same row with pinned=true (WalnutTask is immutable; updatedAt is kept
    /// so the backfill freshness check still matches the created row).
    private static func withPinned(_ t: WalnutTask) -> WalnutTask {
        WalnutTask(
            id: t.id, title: t.title, status: t.status, phase: t.phase,
            priority: t.priority, project: t.project, dueDate: t.dueDate,
            createdAt: t.createdAt, updatedAt: t.updatedAt,
            completedAt: t.completedAt, starred: t.starred,
            pinned: true, tags: t.tags, summary: t.summary,
            startDate: t.startDate, endDate: t.endDate
        )
    }

    /// Pin (idempotent) + optional tier move. Optimistic: the tier map is
    /// written immediately (badge shows the moment the row is pinned) and the
    /// debounced refresh reconciles with the server split. Announces WHERE
    /// the pin landed ("Pinned · Focus") via the toast surface. Best-effort:
    /// failures only log — quick-add's task itself already exists.
    func applyPin(taskId: String, tier: String?) async {
        let landed = tier ?? "satellite"
        taskTiers[taskId] = landed
        // Flip the row's pinned flag too (the parse-tier path arrives with an
        // unpinned local row; the badge needs pinned==true to render).
        if let idx = tasks.firstIndex(where: { $0.id == taskId }), tasks[idx].pinned != true {
            tasks[idx] = Self.withPinned(tasks[idx])
        }
        do {
            _ = try await transport.pinTask(id: taskId)
            if let tier, tier != "satellite" {
                _ = try await transport.setTaskFocusTier(id: taskId, tier: tier)
            }
            if isActive { transientNotice = "Pinned · \(tierLabel(for: landed))" }
            scheduleTierRefresh()
        } catch {
            taskTiers[taskId] = nil
            AppLog.warn("tasks", "quick-add pin failed", ["taskId": taskId, "error": error.localizedDescription])
        }
    }
}
