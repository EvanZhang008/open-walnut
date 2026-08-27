import SwiftUI

/// Quick task creation — todo-app grade: type a title, hit Add. Optional
/// project (pick an existing one or type a new name — the server auto-creates
/// it), priority, and due date. Works against the primary box AND the cloud
/// companion (2026-08: the replica creates locally and the task outbox syncs
/// back to the primary); the not_supported_cloud handling below only fires
/// against a pre-2026-08 cloud server and degrades to a clear error.
struct NewTaskSheet: View {
    /// Called with the created task right before dismissal.
    var onCreated: ((WalnutTask) -> Void)? = nil
    /// Sentence carried in from the quick-add row's expand affordance —
    /// pre-fills the NL field and fires the parse once on appear. The form
    /// stays fully manual regardless (parse failure changes nothing).
    var seedText: String = ""
    /// Where the sheet was opened FROM: a project section's header seeds the
    /// project, a pin-tier header seeds the tier. Every field stays editable —
    /// the seed is a starting point, never a lock.
    var seed: NewTaskSeed = NewTaskSeed(project: "", pin: .unspecified)

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
    /// Where on the pinned board the task is born. Seeded from wherever the
    /// sheet was opened; `.unspecified` = let the server decide (its default
    /// puts a person's task on the board in Satellite).
    @State private var pin: TaskPinChoice = .unspecified
    @State private var priority: Priority = .none
    @State private var hasDueDate = false
    @State private var dueDate = Calendar.current.startOfDay(for: Date()).addingTimeInterval(9 * 3600)
    @State private var creating = false
    @State private var createError: String?
    @FocusState private var titleFocused: Bool

    // NL quick-parse (Wave 2): a sentence like "remind me to file the report
    // at 9am tomorrow" backfills the form below — the AI fills, the human
    // confirms; the manual form always stays usable.
    @State private var nlText = ""
    @State private var parsing = false
    @State private var parseError: String?
    /// Set when the parse invented a new project name (badge in the form).
    @State private var parsedNewProject = false

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
                quickParseSection
                titleSection
                projectSection
                pinSection
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
            .onAppear {
                titleFocused = true
                // Opened from a group header (project section / pin tier): start
                // in that group. Guarded on "still untouched" so a re-appear
                // (keyboard, sheet detent change) can't stomp a manual edit.
                if project.isEmpty, !seed.project.isEmpty { project = seed.project }
                if pin == .unspecified, seed.pin != .unspecified { pin = seed.pin }
                // Seeded from the quick-add expand: mirror the sentence into
                // the title NOW (manual path intact) and parse in background.
                let sentence = seedText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !sentence.isEmpty, nlText.isEmpty {
                    nlText = sentence
                    title = sentence
                    Task { await parseNL() }
                }
            }
            // Custom tiers load asynchronously and are rare; fetch them so a
            // ct_* tier is pickable. Never gates the sheet — a failure leaves
            // the four built-ins, which is a working form.
            .task {
                if tasks.customTiers.isEmpty { await tasks.loadFocusTiers() }
            }
            .interactiveDismissDisabled(creating)
        }
    }

    // MARK: - Sections

    /// NL capture row: type a sentence → Parse → the form below fills in.
    /// Never blocks manual entry; a parse failure leaves the form untouched.
    private var quickParseSection: some View {
        Section {
            HStack(spacing: 8) {
                TextField("Describe it… \"file the report 9am tomorrow\"", text: $nlText, axis: .vertical)
                    .lineLimit(1...3)
                    .disabled(parsing)
                    .accessibilityIdentifier("newTask.nlText")
                Button {
                    Task { await parseNL() }
                } label: {
                    if parsing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "wand.and.stars")
                            .foregroundStyle(Theme.tint)
                    }
                }
                .disabled(parsing || nlText.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("newTask.parse")
            }
            if let parseError {
                Text(parseError)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
            }
        } header: {
            Text("Quick Add")
        } footer: {
            Text(parsedNewProject
                 ? "Parsed — \"\(project)\" is a new project and will be created."
                 : "AI fills the form below — review, then Add.")
        }
    }

    /// POST /v1/tasks/quick-parse — backfill title/project/priority/due date.
    /// The parse only OVERWRITES fields it produced; everything else stays.
    private func parseNL() async {
        let text = nlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !parsing else { return }
        parsing = true
        parseError = nil
        parsedNewProject = false
        defer { parsing = false }
        do {
            let parsed = try await tasks.quickParse(text)
            title = parsed.title
            if let p = parsed.project { project = p }
            parsedNewProject = parsed.projectIsNew == true
            if let raw = parsed.priority, let p = Priority(rawValue: raw) { priority = p }
            // The parse can name a pin tier ("focus this week"). It only FILLS
            // an untouched choice — a tier the human already picked (or the
            // header they added from) outranks the model, same rule as every
            // other field here. An unknown tier is dropped rather than sent:
            // the server would 400 the whole create over a suggestion.
            if pin == .unspecified, let tier = parsed.pinTier,
               TaskPinChoice.tier(tier).isResolvable(
                   builtinIds: TasksStore.builtinTiers.map(\.id),
                   customTierIds: tasks.customTiers.map(\.id)
               ) {
                pin = .tier(tier)
            }
            if let due = QuickParsedTask.parseLocalDate(parsed.dueDate) {
                hasDueDate = true
                dueDate = due
            }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            AppLog.info("tasks", "quick-parse filled form", ["textLen": String(text.count)])
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            parseError = "Couldn't parse that — fill the form manually or try rewording."
            AppLog.warn("tasks", "quick-parse failed", ["error": error.localizedDescription])
        }
    }

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

    /// Every place a task can be filed, in one list: off the board, the four
    /// built-in tiers, then any custom tier the box has registered.
    ///
    /// A LIST of rows rather than a Picker/segmented control on purpose: the
    /// tier set is DYNAMIC (custom `ct_*` tiers come from the server, and there
    /// can be several with real names), and a segmented control silently
    /// squeezes them into unreadable slivers while a menu Picker hides the
    /// choices behind a tap — the user's complaint was that the options were
    /// not there, so they are all visible. Same interaction as the project
    /// suggestion rows right above, so the sheet reads as one form.
    private var pinChoices: [(choice: TaskPinChoice, label: String, icon: String)] {
        var rows: [(TaskPinChoice, String, String)] = [
            (.notPinned, "Not pinned", "circle.dashed"),
        ]
        for tier in TasksStore.builtinTiers {
            rows.append((.tier(tier.id), tier.label, Self.tierIcon(tier.id)))
        }
        // Custom tiers are rare and load asynchronously; an empty/failed fetch
        // simply means this list is the four built-ins (never a blocked sheet).
        for tier in tasks.customTiers {
            rows.append((.tier(tier.id), tier.label, "square.stack.3d.up"))
        }
        return rows.map { (choice: $0.0, label: $0.1, icon: $0.2) }
    }

    private static func tierIcon(_ id: String) -> String {
        switch id {
        case "focus": return "scope"
        case "satellite": return "circle.circle"
        case "backlog": return "tray.full"
        case "wait": return "pause.circle"
        default: return "square.stack.3d.up"
        }
    }

    private var pinSection: some View {
        Section {
            ForEach(pinChoices, id: \.choice.key) { row in
                Button {
                    // Re-tapping the current choice returns to "let the server
                    // decide" — the same toggle-off the project rows have, so
                    // there is always a way back out of an accidental pick.
                    pin = (pin == row.choice) ? .unspecified : row.choice
                } label: {
                    HStack {
                        Image(systemName: row.icon)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 18)
                        Text(row.label)
                            .font(.subheadline)
                            .foregroundStyle(pin == row.choice ? Theme.tint : .primary)
                        Spacer()
                        if pin == row.choice {
                            Image(systemName: "checkmark")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.tint)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("newTask.pin.\(row.choice.key)")
            }
        } header: {
            Text("Pin")
        } footer: {
            Text(pin == .unspecified
                 ? "Default — lands on the pinned board in Satellite."
                 : (pin == .notPinned
                    ? "Stays off the pinned board."
                    : "Born in this tier, in one write."))
        }
        // The rows are individually addressable (a container identifier would
        // overwrite every descendant's and make the choices untappable by id).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("newTask.pinSection")
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
                dueDate: hasDueDate ? ISO8601DateFormatter().string(from: dueDate) : nil,
                pin: pin
            )
            AppLog.info("tasks", "created task", ["taskId": created.id, "pin": pin.key])
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
