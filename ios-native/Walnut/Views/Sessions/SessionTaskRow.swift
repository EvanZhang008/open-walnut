import SwiftUI

/// The session's linked-task row — a session IS a task, so every task
/// capability is reachable in place: tap → the full TaskDetailSheet
/// (status/priority/due/description/note/star/pin/delete), plus inline
/// one-tap quick controls (todo↔done status circle, pin toggle).
///
/// Resolution: the LIVE row from TasksStore when present (the events feed
/// updates it in place); otherwise a one-shot GET /v1/tasks/:id fallback for
/// rows the list projection dropped (e.g. long-done tasks).
struct SessionTaskRow: View {
    let taskId: String
    /// Session-projection fallbacks painted while the task row resolves.
    let fallbackTitle: String?
    let project: String?

    @Environment(TasksStore.self) private var store: TasksStore?
    private let api = WalnutAPI()

    /// GET /tasks/:id result for rows not in the list projection.
    @State private var fetched: WalnutTask?
    @State private var saving = false
    @State private var errorText: String?
    @State private var showDetail = false

    /// Live store row first, fetched fallback second.
    private var task: WalnutTask? {
        store?.tasks.first { $0.id == taskId } ?? fetched
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 12) {
                statusToggle
                Button {
                    showDetail = true
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(task?.title ?? fallbackTitle ?? "Task")
                            .foregroundStyle(.primary)
                            .strikethrough(task?.isDone == true, color: .secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        // One grouping layer: the project, or Inbox.
                        let projectName = task?.project ?? project ?? ""
                        Text(projectName.isEmpty ? "Inbox" : projectName)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("session.taskRow")
                if saving {
                    ProgressView().controlSize(.small)
                }
                pinToggle
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            if let errorText {
                Label(errorText, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
            }
        }
        .task { await resolve() }
        .sheet(isPresented: $showDetail) {
            // TaskDetailSheet needs the store in its environment; without a
            // resolved row it still works off a minimal id+title snapshot
            // (its own TaskDetailController fetches the full record).
            if let store {
                TaskDetailSheet(task: task ?? Self.placeholder(id: taskId, title: fallbackTitle))
                    .environment(store)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    // MARK: - Quick controls

    /// True when the row lives in the list store (optimistic writes land
    /// instantly there); false = fetched-fallback copy (needs the await).
    private var isLiveRow: Bool {
        store?.tasks.contains(where: { $0.id == taskId }) == true
    }

    /// One-tap todo↔done — optimistic through the store: for in-list rows the
    /// circle flips the moment it's tapped (no disabled window); only the
    /// fetched-fallback copy still gates on `saving` (it needs the PATCH
    /// response to update its snapshot).
    private var statusToggle: some View {
        Button {
            toggleDone()
        } label: {
            StatusCircle(status: task?.statusKind ?? .unknown)
                .font(.title3)
        }
        .buttonStyle(.plain)
        .disabled((saving && !isLiveRow) || task == nil || store == nil)
        .accessibilityIdentifier("session.task.statusToggle")
    }

    private var pinToggle: some View {
        Button {
            togglePin()
        } label: {
            HStack(spacing: 3) {
                Image(systemName: task?.pinned == true ? "pin.fill" : "pin")
                // WHERE it's pinned, not just that it is (focus tier label).
                if task?.pinned == true,
                   let store, let badge = task.flatMap({ store.tierBadge(for: $0) }) {
                    Text(badge).font(.caption2.weight(.semibold))
                }
            }
            .foregroundStyle(task?.pinned == true ? Theme.tint : Color.secondary)
        }
        .buttonStyle(.plain)
        .disabled((saving && !isLiveRow) || task == nil || store == nil)
        .accessibilityIdentifier("session.task.pinToggle")
    }

    private func toggleDone() {
        guard let store, let task else { return }
        guard isLiveRow || !saving else { return }
        saving = true
        errorText = nil
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            defer { saving = false }
            do {
                // updateTask is optimistic for in-list rows and falls through
                // to a plain PATCH for rows only this fallback copy knows.
                let next = task.statusKind == .done ? "todo" : "done"
                let updated = try await store.updateTask(id: task.id, edit: .init(status: next))
                if store.tasks.first(where: { $0.id == task.id }) == nil { fetched = updated }
            } catch {
                errorText = TaskDetailSheet.friendlyEditError(error)
            }
        }
    }

    private func togglePin() {
        guard let store, let task else { return }
        guard isLiveRow || !saving else { return }
        saving = true
        errorText = nil
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            defer { saving = false }
            let next = !(task.pinned == true)
            if let message = await store.setPinned(task, pinned: next) {
                errorText = message
            } else if store.tasks.first(where: { $0.id == task.id }) == nil {
                // Fallback rows aren't in the list — refetch the truth.
                await resolve(force: true)
            }
        }
    }

    // MARK: - Resolution

    private func resolve(force: Bool = false) async {
        guard force || task == nil else { return }
        guard let detail = try? await api.taskDetail(id: taskId) else { return }
        fetched = WalnutTask(detail: detail)
    }

    /// Minimal snapshot when nothing has resolved yet — TaskDetailSheet's own
    /// controller loads the full record over it.
    static func placeholder(id: String, title: String?) -> WalnutTask {
        WalnutTask(
            id: id, title: title ?? "Task", status: "todo", phase: "TODO",
            priority: "none", project: "", dueDate: nil, createdAt: nil,
            updatedAt: nil, completedAt: nil, starred: nil, pinned: nil,
            tags: nil, summary: nil
        )
    }
}

extension WalnutTask {
    /// Project the FULL detail record onto the slim list row shape (the detail
    /// payload deliberately omits the timestamp stamps — they stay nil).
    init(detail: TaskDetail) {
        self.init(
            id: detail.id, title: detail.title,
            status: detail.status ?? "todo", phase: detail.phase ?? "TODO",
            priority: detail.priority ?? "none", project: detail.project ?? "",
            dueDate: nil, createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: detail.starred, pinned: detail.pinned,
            tags: detail.tags, summary: detail.summary
        )
    }
}
