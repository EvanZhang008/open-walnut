import SwiftUI

/// The sheet a tap on empty calendar space opens: a title field, the slot the
/// user tapped (editable), and a project pick. Deliberately NOT the full
/// NewTaskSheet — a calendar tap already answered "when", so asking again would
/// undo the gesture; this is the one-field version with the date pre-answered.
///
/// Dogfood R18: before this, the Day / Multi-Day / List views had no create
/// entry at all, and tapping empty space did nothing. A calendar you can't put
/// anything into is a viewer, not a calendar.
struct CalendarCreateSheet: View {
    let draft: CalendarCreate.Draft
    let calendar: Calendar
    /// Project the day's context suggests (the filter's single selected
    /// project, when there is exactly one) — otherwise Inbox.
    var suggestedProject: String = ""
    /// Handed the created task so the caller can relax a filter that would
    /// hide it and flash the new row.
    var onCreated: ((WalnutTask) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @Environment(TasksStore.self) private var tasks

    @State private var title = ""
    @State private var project = ""
    @State private var start: Date
    @State private var end: Date
    @State private var isAllDay: Bool
    @State private var creating = false
    @State private var createError: String?
    @FocusState private var titleFocused: Bool

    init(
        draft: CalendarCreate.Draft, calendar: Calendar,
        suggestedProject: String = "", onCreated: ((WalnutTask) -> Void)? = nil
    ) {
        self.draft = draft
        self.calendar = calendar
        self.suggestedProject = suggestedProject
        self.onCreated = onCreated
        // Seed the pickers from the tapped slot. An all-day draft still needs
        // sane clock values in case the user flips the toggle ON to a time.
        let seedStart = draft.start ?? calendar.date(
            bySettingHour: 9, minute: 0, second: 0, of: draft.day
        ) ?? draft.day
        _start = State(initialValue: seedStart)
        _end = State(initialValue: draft.end
            ?? seedStart.addingTimeInterval(CalendarCreate.defaultDurationMinutes * 60))
        _isAllDay = State(initialValue: draft.isAllDay)
        // Deliberately NOT seeded into `project`: a pre-filled TextField with
        // the caret at the end silently CONCATENATES what the user types
        // ("EKS Harbor Team" + "Home Lab" = "EKS Harbor TeamHome Lab" — caught
        // in dogfood R18 verification). The suggestion is offered as a tappable
        // row instead, so the field starts empty and typing means what it says.
        _project = State(initialValue: "")
    }

    private var canCreate: Bool {
        !creating && !title.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Existing project names, A→Z (Inbox is the empty default, not a row).
    private var knownProjects: [String] {
        var seen = Set<String>()
        for t in tasks.tasks where !t.project.isEmpty { seen.insert(t.project) }
        return seen.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What are you doing?", text: $title)
                        .focused($titleFocused)
                        .submitLabel(.done)
                        .onSubmit { if canCreate { Task { await create() } } }
                        .accessibilityIdentifier("calendar.create.title")
                } header: {
                    Text(CalendarCreate.label(for: draft, calendar: calendar))
                }

                Section {
                    Toggle("All-day", isOn: $isAllDay.animation())
                        .accessibilityIdentifier("calendar.create.allDay")
                    if isAllDay {
                        DatePicker("Day", selection: $start, displayedComponents: [.date])
                            .accessibilityIdentifier("calendar.create.day")
                    } else {
                        DatePicker("Starts", selection: $start, displayedComponents: [.date, .hourAndMinute])
                            .accessibilityIdentifier("calendar.create.starts")
                        DatePicker("Ends", selection: $end, in: start..., displayedComponents: [.date, .hourAndMinute])
                            .accessibilityIdentifier("calendar.create.ends")
                    }
                } footer: {
                    Text(isAllDay
                         ? "An all-day task rides the band above the hours — no fake clock time."
                         : "A timed task becomes a block you can see and tap on the day.")
                }

                Section {
                    TextField("Inbox (default)", text: $project)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("calendar.create.project")
                    // The filtered-to project, one tap away — it leads the
                    // suggestions instead of pre-filling the field.
                    if !suggestedProject.isEmpty, !knownProjects.contains(suggestedProject) {
                        projectRow(suggestedProject)
                    }
                    ForEach(knownProjects.prefix(6), id: \.self) { name in
                        projectRow(name)
                    }
                } header: {
                    Text("Project")
                } footer: {
                    Text("A new name creates the project.")
                }

                if let createError {
                    Section {
                        Label(createError, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("New on Calendar")
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
                            .accessibilityIdentifier("calendar.create.add")
                    }
                }
            }
            .onAppear { titleFocused = true }
            .interactiveDismissDisabled(creating)
        }
        .accessibilityIdentifier("calendar.createSheet")
    }

    /// One tappable project suggestion — tapping REPLACES the field (never
    /// appends), tapping the chosen one again clears it back to Inbox.
    private func projectRow(_ name: String) -> some View {
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
        .accessibilityIdentifier("calendar.create.projectPick.\(name)")
    }

    // MARK: - Create

    private func create() async {
        // Same double-tap guard as the other create sheets: this flag is the
        // only thing between one tap and two tasks.
        guard !creating else { return }
        creating = true
        createError = nil
        defer { creating = false }

        // Build the wire values from the CURRENT picker state (the user may
        // have adjusted the tapped slot) through the same pure helpers the
        // tests pin, so an edited slot can't take a different code path.
        let effective: CalendarCreate.Draft = isAllDay
            ? CalendarCreate.allDayDraft(day: start, calendar: calendar)
            : CalendarCreate.Draft(
                day: calendar.startOfDay(for: start),
                start: start,
                end: end > start ? end : nil
            )
        let wire = CalendarCreate.wireDates(for: effective, calendar: calendar)

        do {
            let created = try await tasks.createTask(
                title: title.trimmingCharacters(in: .whitespaces),
                project: project.trimmingCharacters(in: .whitespaces),
                dueDate: wire.dueDate,
                startDate: wire.startDate,
                endDate: wire.endDate
            )
            AppLog.info("tasks", "created task from calendar", [
                "taskId": created.id,
                "allDay": String(isAllDay),
            ])
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
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
