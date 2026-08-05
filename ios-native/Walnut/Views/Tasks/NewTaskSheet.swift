import SwiftUI

/// Quick task creation — todo-app grade: type a title, hit Add. Optional
/// project (pick an existing one or type a new name — the server auto-creates
/// it), priority, and due date. Mirrors NewSessionSheet's structure: the
/// entry point is hidden on a REPLICA (task writes run on the primary box),
/// and the sheet degrades to a clear error if it ever hits the 503.
struct NewTaskSheet: View {
    /// Called with the created task right before dismissal.
    var onCreated: ((WalnutTask) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @Environment(TasksStore.self) private var tasks

    /// Wire values are the frozen priority contract. "none" is itself a valid
    /// wire value (VALID_PRIORITIES on the server) and is sent explicitly —
    /// omitting the field would make the server apply its config default,
    /// so a user-picked "None" would silently become something else.
    enum Priority: String, CaseIterable, Identifiable {
        case none, backlog, important, immediate
        var id: String { rawValue }
        var label: String {
            switch self {
            case .none: return "None"
            case .backlog: return "Backlog"
            case .important: return "Important"
            case .immediate: return "Immediate"
            }
        }
    }

    @State private var title = ""
    @State private var project = ""
    @State private var priority: Priority = .none
    @State private var hasDueDate = false
    @State private var dueDate = Calendar.current.startOfDay(for: Date()).addingTimeInterval(9 * 3600)
    @State private var creating = false
    @State private var createError: String?
    @FocusState private var titleFocused: Bool

    /// Existing project names from the loaded task list, A→Z (Inbox excluded —
    /// it's the empty default, not a pickable name).
    private var knownProjects: [String] {
        var seen = Set<String>()
        for t in tasks.tasks where !t.project.isEmpty { seen.insert(t.project) }
        return seen.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    private var canCreate: Bool {
        !creating && !title.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                titleSection
                projectSection
                prioritySection
                dueDateSection
                if let createError {
                    Section {
                        Label(createError, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.disabled(creating)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if creating {
                        ProgressView()
                    } else {
                        Button("Add") { Task { await create() } }
                            .fontWeight(.semibold)
                            .disabled(!canCreate)
                            .accessibilityIdentifier("newTask.add")
                    }
                }
            }
            .onAppear { titleFocused = true }
            .interactiveDismissDisabled(creating)
        }
    }

    // MARK: - Sections

    private var titleSection: some View {
        Section {
            TextField("What needs doing?", text: $title)
                .focused($titleFocused)
                .submitLabel(.done)
                // Keyboard "done" on a filled title = Add (one-hand quick add).
                .onSubmit { if canCreate { Task { await create() } } }
                .accessibilityIdentifier("newTask.title")
        }
    }

    private var projectSection: some View {
        Section {
            TextField("Inbox (default)", text: $project)
                .autocorrectionDisabled()
                .accessibilityIdentifier("newTask.project")
            // Suggestion rows, same interaction as NewSessionSheet's paths.
            ForEach(knownProjects.prefix(6), id: \.self) { name in
                Button {
                    project = (project == name) ? "" : name
                } label: {
                    HStack {
                        Image(systemName: "folder")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(name)
                            .font(.subheadline)
                            .lineLimit(1)
                            .foregroundStyle(project == name ? Theme.tint : .primary)
                        Spacer()
                        if project == name {
                            Image(systemName: "checkmark")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.tint)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        } header: {
            Text("Project")
        } footer: {
            Text("A new name creates the project.")
        }
    }

    private var prioritySection: some View {
        Section("Priority") {
            Picker("Priority", selection: $priority) {
                ForEach(Priority.allCases) { p in
                    Text(p.label).tag(p)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("newTask.priority")
        }
    }

    private var dueDateSection: some View {
        Section {
            Toggle("Due date", isOn: $hasDueDate.animation())
                .accessibilityIdentifier("newTask.dueToggle")
            if hasDueDate {
                DatePicker(
                    "Due",
                    selection: $dueDate,
                    displayedComponents: [.date, .hourAndMinute]
                )
                .accessibilityIdentifier("newTask.dueDate")
            }
        }
    }

    // MARK: - Actions

    private func create() async {
        // Same double-tap guard as NewSessionSheet: the flag is the only thing
        // between one tap and two tasks when two Tasks enqueue in one frame.
        guard !creating else { return }
        creating = true
        createError = nil
        defer { creating = false }
        do {
            let created = try await tasks.createTask(
                title: title.trimmingCharacters(in: .whitespaces),
                project: project.trimmingCharacters(in: .whitespaces),
                priority: priority.rawValue,
                dueDate: hasDueDate ? ISO8601DateFormatter().string(from: dueDate) : nil
            )
            AppLog.info("tasks", "created task", ["taskId": created.id])
            onCreated?(created)
            dismiss()
        } catch let APIError.server(_, code, msg, _, _) {
            createError = code == "not_supported_cloud"
                ? "Tasks can only be created when the app talks to your primary box directly."
                : msg
        } catch {
            createError = error.localizedDescription
        }
    }
}
