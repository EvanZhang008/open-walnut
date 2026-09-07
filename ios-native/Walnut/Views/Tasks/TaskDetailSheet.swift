import SwiftUI

/// Task detail — every setting editable from ONE grouped properties list
/// (`TaskPropertiesList`) over PATCH /tasks/:id and the focus endpoints
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
    @State private var editingTitle = false
    @State private var titleDraft = ""
    @FocusState private var titleFocused: Bool
    /// Wave-1 detail plane: full-row readback + delete/field edits.
    @State private var detailController: TaskDetailController

    init(task: WalnutTask) {
        self.task = task
        _detailController = State(initialValue: TaskDetailController(taskId: task.id))
    }

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
                    properties
                    TaskMetaCaptions(task: current)
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
                    // Wave-1 detail plane: description/note readback with
                    // editing, blocked/children/parent relations, and the one
                    // destructive Delete row at the foot of the sheet.
                    TaskDetailExtras(controller: detailController) {
                        // Row already removed optimistically by the store —
                        // just close. (A refetch here could race the DELETE
                        // and resurrect the row from a stale projection.)
                        dismiss()
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .task { await detailController.load() }
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

    private var properties: some View {
        TaskPropertiesList(
            task: current,
            phaseCaption: phaseChipText,
            apply: { apply($0) },
            reportError: { editError = $0 },
            openDuePicker: {
                dueDraft = current.dueDateValue ?? Calendar.current.startOfDay(for: .now)
                showDuePicker = true
            }
        )
    }

    // MARK: - Edits

    /// Fire-and-forget: the store applies the edit to the row SYNCHRONOUSLY
    /// (optimistic) and rolls back on failure — so there is no spinner and no
    /// disabled window. `saving` is kept only as a tiny progress hint in the
    /// header; it never gates the controls (instant-first rule, 2026-08).
    private func apply(_ edit: TasksStore.TaskEdit) {
        editError = nil
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        saving = true
        Task {
            defer { saving = false }
            do {
                _ = try await tasks.updateTask(id: task.id, edit: edit)
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

    /// Status circle = one-tap todo↔done. The three-state choice used to hide in
    /// a long-press menu here; it is a visible segmented control in the
    /// properties list now, so this stays a plain button (one setting, one home).
    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                apply(.init(status: current.statusKind == .done ? "todo" : "done"))
            } label: {
                StatusCircle(status: current.statusKind)
                    .font(.title2)
                    .padding(.top, 2)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("task.statusToggle")
            titleView
            if saving { ProgressView().controlSize(.small) }
        }
    }

    /// Tap the title to rename it in place. Multi-line because task titles are
    /// sentences; committed on blur, and on the first newline the keyboard's
    /// return key inserts (a vertical-axis TextField does not fire onSubmit).
    @ViewBuilder
    private var titleView: some View {
        if editingTitle {
            TextField("Title", text: $titleDraft, axis: .vertical)
                .font(.title2.weight(.semibold))
                .focused($titleFocused)
                .submitLabel(.done)
                .onSubmit { commitTitle() }
                .onChange(of: titleDraft) { _, next in
                    if next.contains(where: \.isNewline) { commitTitle() }
                }
                .onChange(of: titleFocused) { _, focused in
                    if !focused { commitTitle() }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("task.title.edit")
        } else {
            Button {
                titleDraft = current.title
                editingTitle = true
                titleFocused = true
            } label: {
                Text(current.title)
                    .font(.title2.weight(.semibold))
                    .strikethrough(current.isDone, color: .secondary)
                    .foregroundStyle(current.isDone ? .secondary : .primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("task.title")
        }
    }

    /// Newlines fold to spaces: a title is one line of text, and the return key
    /// is what commits, so a stray break must never reach the server.
    private func commitTitle() {
        guard editingTitle else { return }
        editingTitle = false
        titleFocused = false
        let next = titleDraft
            .split(whereSeparator: \.isNewline)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        guard !next.isEmpty, next != current.title else { return }
        apply(.init(title: next))
    }

    private var duePickerSheet: some View {
        NavigationStack {
            // Order matters twice over. The DatePicker goes FIRST because the
            // toolbar is translucent and content lays out under it — a quick row
            // in that slot was drawn behind the title bar, while the picker's own
            // padding absorbs the overlap. And the quick row sits directly under
            // the calendar rather than pinned to the bottom edge, which left
            // ~700pt of dead space between the two at the large detent.
            VStack(spacing: 0) {
                DatePicker("Due date", selection: $dueDraft, displayedComponents: [.date])
                    .datePickerStyle(.graphical)
                    .padding()
                Divider()
                quickDueRow
                Spacer(minLength: 0)
            }
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
        // Large only. The graphical calendar alone already reached the bottom
        // edge of a medium detent (measured before the quick row existed), so
        // there is no room there for another 54pt of controls.
        .presentationDetents([.large])
    }

    /// The three dates people actually pick, plus a clear — one tap each, so the
    /// common case never goes through the calendar. "None" only appears when
    /// there IS a date to remove.
    private var quickDueRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TaskDueQuickChoice.allCases.filter {
                    $0 != .clear || current.dueDate != nil
                }) { choice in
                    Button {
                        showDuePicker = false
                        // "" = explicit clear, same convention as TaskEdit.
                        apply(.init(dueDate: choice.date(from: .now).map(Self.isoDay) ?? ""))
                    } label: {
                        Text(choice.label)
                            .font(.subheadline.weight(.medium))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .background(Theme.tintSoft, in: Capsule())
                            .foregroundStyle(Theme.tint)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("task.due.quick.\(choice.rawValue)")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }

    /// "YYYY-MM-DD" — the PATCH contract accepts a bare date.
    static func isoDay(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    // MARK: - Labels

    /// Phase enum → readable Title Case (e.g. AGENT_COMPLETE → Agent Complete).
    /// nil when the phase is just the status restated (TODO+todo showed
    /// "To Do"+"Todo" side by side — dogfood R15): only a phase that says
    /// something the status chip doesn't (AGENT_COMPLETE, or a mismatch like
    /// COMPLETE while status is still open) earns a second chip.
    private var phaseChipText: String? {
        let redundant: [String: TaskStatus] = [
            "TODO": .todo, "IN_PROGRESS": .inProgress, "COMPLETE": .done,
        ]
        if redundant[current.phase] == current.statusKind { return nil }
        return current.phase
            .split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }

    static func fullDate(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }
}
