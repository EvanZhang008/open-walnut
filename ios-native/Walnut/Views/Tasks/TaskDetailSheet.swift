import SwiftUI

/// Task detail — status/priority/due/project editing over PATCH /tasks/:id
/// (optimistic apply + rollback on failure), plus the task's sessions
/// (tap → conversation). Presented as a medium/large sheet.
struct TaskDetailSheet: View {
    /// Snapshot passed by the list row. The body renders the LIVE row from the
    /// store when present (the events feed updates it in place), falling back
    /// to this snapshot for rows not in the current list.
    let task: WalnutTask
    @Environment(\.dismiss) private var dismiss
    @Environment(TasksStore.self) private var tasks

    /// Explicit path so a freshly created session can push programmatically.
    @State private var navPath: [WalnutSession] = []
    @State private var showNewSession = false
    @State private var saving = false
    @State private var editError: String?
    @State private var showDuePicker = false
    @State private var dueDraft = Date()
    @State private var editingProject = false
    @State private var projectDraft = ""

    /// Live row (feed-updated) when available, else the presented snapshot.
    private var current: WalnutTask {
        tasks.tasks.first(where: { $0.id == task.id }) ?? task
    }

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
                    if let editError {
                        Label(editError, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.danger)
                    }
                    chips
                    metadata
                    sessionsBlock
                    if let summary = current.summary, !summary.isEmpty {
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
                NewSessionSheet(task: current) { session in
                    navPath.append(session)
                }
                .presentationDetents([.medium, .large])
            }
            .sheet(isPresented: $showDuePicker) { duePickerSheet }
        }
    }

    // MARK: - Edits

    private func apply(_ edit: TasksStore.TaskEdit) {
        guard !saving else { return }
        saving = true
        editError = nil
        Task {
            defer { saving = false }
            do {
                _ = try await tasks.updateTask(id: task.id, edit: edit)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } catch {
                editError = Self.friendlyEditError(error)
            }
        }
    }

    /// Actionable text for the edit failure banner.
    static func friendlyEditError(_ error: Error) -> String {
        guard let apiError = error as? APIError else { return error.localizedDescription }
        switch apiError.code {
        case "conflict": return "Couldn't save — this task is managed by a sync source. \(apiError.localizedDescription)"
        case "not_found": return "This task no longer exists on the server."
        default: return apiError.localizedDescription
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
                Button {
                    showNewSession = true
                } label: {
                    Label("New Session", systemImage: "plus.circle.fill")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.tint)
                }
                .accessibilityIdentifier("task.newSession")
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

    /// Tappable status circle: todo↔done one-tap toggle; long-press for the
    /// three-state menu (In Progress is the deliberate third option).
    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Menu {
                statusMenuItems
            } label: {
                StatusCircle(status: current.statusKind)
                    .font(.title2)
                    .padding(.top, 2)
            } primaryAction: {
                apply(.init(status: current.statusKind == .done ? "todo" : "done"))
            }
            .accessibilityIdentifier("task.statusToggle")
            .disabled(saving)
            Text(current.title)
                .font(.title2.weight(.semibold))
                .strikethrough(current.isDone, color: .secondary)
                .foregroundStyle(current.isDone ? .secondary : .primary)
            Spacer()
            if saving { ProgressView().controlSize(.small) }
        }
    }

    @ViewBuilder
    private var statusMenuItems: some View {
        Button {
            apply(.init(status: "todo"))
        } label: { Label("To Do", systemImage: "circle") }
        Button {
            apply(.init(status: "in_progress"))
        } label: { Label("In Progress", systemImage: "circle.lefthalf.filled") }
        Button {
            apply(.init(status: "done"))
        } label: { Label("Done", systemImage: "checkmark.circle.fill") }
    }

    private var chips: some View {
        HStack(spacing: 8) {
            Chip(text: statusLabel, color: statusColor)
            Chip(text: phaseLabel, color: .secondary)
            priorityMenu
            if current.pinned == true {
                Chip(text: "Pinned", color: Theme.tint, systemImage: "pin.fill")
            }
            if current.starred == true {
                Chip(text: "Starred", color: Theme.warning, systemImage: "star.fill")
            }
        }
    }

    /// Priority is a tappable chip → menu of the four levels.
    private var priorityMenu: some View {
        Menu {
            ForEach(Self.priorities, id: \.value) { p in
                Button {
                    apply(.init(priority: p.value))
                } label: {
                    if current.priority == p.value {
                        Label(p.label, systemImage: "checkmark")
                    } else {
                        Text(p.label)
                    }
                }
            }
        } label: {
            Chip(
                text: priorityLabel,
                color: priorityColor,
                systemImage: current.priorityKind == .none || current.priorityKind == .unknown
                    ? "flag" : "flag.fill"
            )
        }
        .accessibilityIdentifier("task.priority")
        .disabled(saving)
    }

    static let priorities: [(value: String, label: String)] = [
        ("immediate", "Immediate"), ("important", "Important"),
        ("backlog", "Backlog"), ("none", "None"),
    ]

    private var metadata: some View {
        VStack(alignment: .leading, spacing: 10) {
            projectRow
            dueRow
            if let created = current.createdAtValue {
                MetaRow(label: "Created", value: Self.fullDate(created))
            }
            if let updated = current.updatedAtValue {
                MetaRow(label: "Updated", value: Self.fullDate(updated))
            }
            if let completed = current.completedAtValue {
                MetaRow(label: "Completed", value: Self.fullDate(completed))
            }
            if let tags = current.tags, !tags.isEmpty {
                MetaRow(label: "Tags", value: tags.joined(separator: ", "))
            }
        }
    }

    /// Project: value tap → inline text field (a new name auto-creates the
    /// project server-side; empty = Inbox).
    @ViewBuilder
    private var projectRow: some View {
        if editingProject {
            HStack(alignment: .top) {
                Text("Project")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(width: 90, alignment: .leading)
                TextField("Inbox", text: $projectDraft)
                    .font(.subheadline)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit {
                        editingProject = false
                        let next = projectDraft.trimmingCharacters(in: .whitespaces)
                        if next != current.project { apply(.init(project: next)) }
                    }
                    .accessibilityIdentifier("task.projectField")
                Button("Cancel") { editingProject = false }
                    .font(.caption)
            }
        } else {
            Button {
                projectDraft = current.project
                editingProject = true
            } label: {
                MetaRow(
                    label: "Project",
                    value: current.project.isEmpty ? "Inbox" : current.project,
                    valueColor: Theme.tint
                )
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("task.project")
            .disabled(saving)
        }
    }

    /// Due date: tap → DatePicker sheet; clear button when set.
    private var dueRow: some View {
        HStack(alignment: .top, spacing: 8) {
            Button {
                dueDraft = current.dueDateValue ?? Calendar.current.startOfDay(for: .now)
                showDuePicker = true
            } label: {
                MetaRow(
                    label: "Due",
                    value: current.dueDateValue.map(Self.fullDate) ?? "Add date",
                    valueColor: current.isOverdue ? Theme.danger : Theme.tint
                )
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("task.due")
            .disabled(saving)
            if current.dueDate != nil {
                Button {
                    apply(.init(dueDate: "")) // "" = explicit clear
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .accessibilityIdentifier("task.dueClear")
                .disabled(saving)
            }
        }
    }

    private var duePickerSheet: some View {
        NavigationStack {
            DatePicker("Due date", selection: $dueDraft, displayedComponents: [.date])
                .datePickerStyle(.graphical)
                .padding()
                .navigationTitle("Due Date")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Cancel") { showDuePicker = false }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Set") {
                            showDuePicker = false
                            apply(.init(dueDate: Self.isoDay(dueDraft)))
                        }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("task.dueSet")
                    }
                }
        }
        .presentationDetents([.medium])
    }

    /// "YYYY-MM-DD" — the PATCH contract accepts a bare date.
    static func isoDay(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    // MARK: - Labels

    private var statusLabel: String {
        switch current.statusKind {
        case .todo: return "To Do"
        case .inProgress: return "In Progress"
        case .done: return "Done"
        case .unknown: return current.status
        }
    }

    private var statusColor: Color {
        switch current.statusKind {
        case .done: return Theme.success
        case .inProgress: return Theme.warning
        default: return .secondary
        }
    }

    /// Phase enum → readable Title Case (e.g. AWAIT_HUMAN_ACTION → Await Human Action).
    private var phaseLabel: String {
        current.phase
            .split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }

    private var priorityLabel: String {
        switch current.priorityKind {
        case .immediate: return "Immediate"
        case .important: return "Important"
        case .backlog: return "Backlog"
        case .none, .unknown: return "Priority"
        }
    }

    private var priorityColor: Color {
        switch current.priorityKind {
        case .immediate: return Theme.danger
        case .important: return Theme.warning
        default: return .secondary
        }
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
