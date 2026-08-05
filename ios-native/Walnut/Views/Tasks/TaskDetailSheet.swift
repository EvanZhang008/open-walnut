import SwiftUI

/// Read-only task detail — title, status/phase chips, project, priority,
/// dates, summary, and the task's sessions (tap → conversation).
/// Presented as a medium/large sheet.
struct TaskDetailSheet: View {
    let task: WalnutTask
    @Environment(\.dismiss) private var dismiss
    @Environment(TasksStore.self) private var tasks
    @Environment(ConnectionStore.self) private var connection

    /// Explicit path so a freshly created session can push programmatically.
    @State private var navPath: [WalnutSession] = []
    @State private var showNewSession = false

    /// Every task can be (or spawn) a session — surface them here so the
    /// conversation is one tap from the task, newest first.
    private var taskSessions: [WalnutSession] {
        tasks.sessions
            .filter { $0.taskId == task.id }
            .sorted(by: WalnutSession.recencySort)
    }

    var body: some View {
        NavigationStack(path: $navPath) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    chips
                    metadata
                    sessionsBlock
                    if let summary = task.summary, !summary.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Summary")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(summary)
                                .font(.body)
                                .foregroundStyle(.primary)
                        }
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            // Conversations push inside the sheet's own stack.
            .navigationDestination(for: WalnutSession.self) { session in
                SessionConversationView(session: session)
            }
            .sheet(isPresented: $showNewSession) {
                NewSessionSheet(task: task) { session in
                    navPath.append(session)
                }
                .presentationDetents([.medium, .large])
            }
        }
    }

    // Always rendered (no isEmpty gate): the header hosts the New Session
    // button — the only per-task create entry — which must be reachable on
    // tasks with zero sessions too.
    private var sessionsBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Sessions")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                // Hidden on a REPLICA — creation is a primary-box capability.
                if connection.status?.mode != .replica {
                    Button {
                        showNewSession = true
                    } label: {
                        Label("New Session", systemImage: "plus.circle.fill")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Theme.tint)
                    }
                    .accessibilityIdentifier("task.newSession")
                }
            }
            VStack(spacing: 0) {
                ForEach(taskSessions.prefix(5)) { session in
                    NavigationLink(value: session) {
                        HStack {
                            SessionRowView(session: session)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if session.id != taskSessions.prefix(5).last?.id {
                        Divider()
                    }
                }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            StatusCircle(status: task.statusKind)
                .font(.title2)
                .padding(.top, 2)
            Text(task.title)
                .font(.title2.weight(.semibold))
                .strikethrough(task.isDone, color: .secondary)
                .foregroundStyle(task.isDone ? .secondary : .primary)
        }
    }

    private var chips: some View {
        HStack(spacing: 8) {
            Chip(text: statusLabel, color: statusColor)
            Chip(text: phaseLabel, color: .secondary)
            if task.priorityKind == .immediate || task.priorityKind == .important {
                Chip(text: priorityLabel, color: priorityColor, systemImage: "flag.fill")
            }
            if task.pinned == true {
                Chip(text: "Pinned", color: Theme.tint, systemImage: "pin.fill")
            }
            if task.starred == true {
                Chip(text: "Starred", color: Theme.warning, systemImage: "star.fill")
            }
        }
    }

    private var metadata: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Always shown: "Inbox" is a real, meaningful placement, not a gap.
            MetaRow(label: "Project", value: task.project.isEmpty ? "Inbox" : task.project)
            if let due = task.dueDateValue {
                MetaRow(label: "Due", value: Self.fullDate(due),
                        valueColor: task.isOverdue ? Theme.danger : .primary)
            }
            if let created = task.createdAtValue {
                MetaRow(label: "Created", value: Self.fullDate(created))
            }
            if let updated = task.updatedAtValue {
                MetaRow(label: "Updated", value: Self.fullDate(updated))
            }
            if let completed = task.completedAtValue {
                MetaRow(label: "Completed", value: Self.fullDate(completed))
            }
            if let tags = task.tags, !tags.isEmpty {
                MetaRow(label: "Tags", value: tags.joined(separator: ", "))
            }
        }
    }

    // MARK: - Labels

    private var statusLabel: String {
        switch task.statusKind {
        case .todo: return "To Do"
        case .inProgress: return "In Progress"
        case .done: return "Done"
        case .unknown: return task.status
        }
    }

    private var statusColor: Color {
        switch task.statusKind {
        case .done: return Theme.success
        case .inProgress: return Theme.warning
        default: return .secondary
        }
    }

    /// Phase enum → readable Title Case (e.g. AWAIT_HUMAN_ACTION → Await Human Action).
    private var phaseLabel: String {
        task.phase
            .split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }

    private var priorityLabel: String {
        task.priorityKind == .immediate ? "Immediate" : "Important"
    }

    private var priorityColor: Color {
        task.priorityKind == .immediate ? Theme.danger : Theme.warning
    }

    static func fullDate(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }
}

/// Small pill chip with an optional leading SF Symbol.
private struct Chip: View {
    let text: String
    let color: Color
    var systemImage: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage).font(.caption2)
            }
            Text(text).font(.caption.weight(.medium))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(color.opacity(0.15), in: Capsule())
        .foregroundStyle(color == .secondary ? Color.secondary : color)
    }
}

/// A label + value line for the metadata block.
private struct MetaRow: View {
    let label: String
    let value: String
    var valueColor: Color = .primary

    var body: some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 90, alignment: .leading)
            Text(value)
                .font(.subheadline)
                .foregroundStyle(valueColor)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
