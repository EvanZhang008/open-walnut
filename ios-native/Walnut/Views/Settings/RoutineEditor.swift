import SwiftUI

/// What the Edit and New Routine sheet edits (2026-11-04: the phone edits a routine's
/// name, schedule and what it sends, and creates one that runs in Walnut, as the
/// console does). Pure, so the rules and the bodies it sends are unit-tested.
///
/// The schedule is one of a few plain shapes (every N minutes or hours, every day,
/// weekdays or one weekday at a time). A stored cron that is none of them, or one in
/// another zone, stays editable as its expression. An edit sends only what changed,
/// and sends the executor and the check back whole: the server replaces each one.
struct RoutineDraft: Equatable {
    enum Repeat: String, CaseIterable, Identifiable {
        case minutes, hours, daily, weekdays, weekly, cron, once

        var id: String { rawValue }

        var label: String {
            switch self {
            // What a person would say, not a template ("Every N hours" read like one,
            // 2026-11-04 review); the row under it says how many.
            case .minutes: return "Every few minutes"
            case .hours: return "Every few hours"
            case .daily: return "Every day"
            case .weekdays: return "Weekdays"
            case .weekly: return "One day a week"
            case .cron: return "Cron expression"
            case .once: return "Once"
            }
        }
    }

    var name = ""
    var sends = ""
    var repeatKind: Repeat = .daily
    /// Minutes or hours, by `repeatKind`.
    var interval = 30
    var hour = 9
    var minute = 0
    /// 0 = Sunday, as cron counts.
    var weekday = 1
    var cronExpr = ""
    /// The stored cron's zone, kept for an expression edited as text.
    var cronTz: String?
    var checkRun = ""
    /// A trigger polls on an interval only (the server refuses a clock schedule for one).
    var isTrigger = false
    /// A routine with no executor (a legacy one) has nothing here to say what it sends.
    var canEditSends = true
    /// A new routine must say what it sends; a stored one only if it said something
    /// (one saved with nothing to send can still be renamed).
    var sendsRequired = true
    /// A one-time routine's moment, kept as it is (the phone does not move it).
    var onceAt: String?
    /// The task a session routine runs in (`config.target`): Edit's Task section.
    var target = ""
    /// Only a session routine runs in a task the person picks.
    var canEditTarget = false

    /// A new routine: every day at 9:00 AM, run in Walnut.
    static func new() -> RoutineDraft { RoutineDraft() }

    init() {}

    init(job: RoutineJob, calendar: Calendar = .current) {
        name = job.name
        sends = job.executor?.sends ?? ""
        canEditSends = job.executor != nil
        sendsRequired = !sends.isEmpty
        isTrigger = job.check != nil
        checkRun = job.check?.run ?? ""
        canEditTarget = job.executor?.type == "session"
        target = canEditTarget ? (RoutineGroups.currentTask(job) ?? "") : ""
        let s = job.schedule
        switch s.kind {
        case "every":
            let ms = s.everyMs ?? 1_800_000
            if ms >= 3_600_000, ms.truncatingRemainder(dividingBy: 3_600_000) == 0 {
                repeatKind = .hours
                interval = Int(ms / 3_600_000)
            } else {
                repeatKind = .minutes
                interval = max(1, Int((ms / 60_000).rounded()))
            }
        case "at":
            repeatKind = .once
            onceAt = s.at
        default:
            cronExpr = s.expr ?? ""
            cronTz = s.tz
            repeatKind = .cron
            let local = s.tz == nil || s.tz == "" || s.tz == calendar.timeZone.identifier
            let f = cronExpr.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
            if local, f.count == 5, let m = Int(f[0]), let h = Int(f[1]), (0...59).contains(m), (0...23).contains(h),
               f[2] == "*", f[3] == "*" {
                minute = m
                hour = h
                if f[4] == "*" { repeatKind = .daily }
                else if f[4] == "1-5" { repeatKind = .weekdays }
                else if let d = Int(f[4]), (0...6).contains(d) { repeatKind = .weekly; weekday = d }
            }
        }
    }

    /// The shapes the picker offers: a trigger's intervals, everyone's clock times,
    /// and the stored shape when it is one of the others (a cron as text, a one-time).
    func repeatOptions(original: RoutineDraft? = nil) -> [Repeat] {
        var out: [Repeat] = isTrigger ? [.minutes, .hours] : [.minutes, .hours, .daily, .weekdays, .weekly]
        let kept = original?.repeatKind ?? repeatKind
        if !out.contains(kept) { out.append(kept) }
        return out
    }

    /// The schedule this draft says, in the phone's zone for a clock time; nil while it is not valid.
    func schedule(calendar: Calendar = .current) -> RoutineJob.Schedule? {
        let tz = calendar.timeZone.identifier
        let at = "\(minute) \(hour) * *"
        switch repeatKind {
        case .minutes:
            guard interval >= 1 else { return nil }
            return .init(kind: "every", expr: nil, tz: nil, everyMs: Double(interval) * 60_000, at: nil)
        case .hours:
            guard interval >= 1 else { return nil }
            return .init(kind: "every", expr: nil, tz: nil, everyMs: Double(interval) * 3_600_000, at: nil)
        case .daily: return .init(kind: "cron", expr: "\(at) *", tz: tz, everyMs: nil, at: nil)
        case .weekdays: return .init(kind: "cron", expr: "\(at) 1-5", tz: tz, everyMs: nil, at: nil)
        case .weekly: return .init(kind: "cron", expr: "\(at) \(weekday)", tz: tz, everyMs: nil, at: nil)
        case .cron:
            let expr = cronExpr.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
            // Five fields, or six or seven (seconds, a year): the server's cron reads all three.
            guard (5...7).contains(expr.split(separator: " ").count) else { return nil }
            return .init(kind: "cron", expr: expr, tz: cronTz, everyMs: nil, at: nil)
        case .once:
            guard let onceAt else { return nil }
            return .init(kind: "at", expr: nil, tz: nil, everyMs: nil, at: onceAt)
        }
    }

    /// What still stops a save, in order; empty = Save is on.
    var problems: [String] {
        var out: [String] = []
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append("Give it a name.") }
        if (repeatKind == .minutes || repeatKind == .hours) && interval < 1 {
            out.append("The interval is at least 1 minute.")
        } else if schedule() == nil {
            out.append(repeatKind == .cron ? "A cron expression has five fields (six or seven with seconds or a year)." : "Pick when it runs.")
        }
        if isTrigger && checkRun.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append("A trigger needs its check command.")
        }
        if canEditSends && sendsRequired && sends.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append("Say what it sends.")
        }
        if canEditTarget && target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append("Pick the task it runs in.")
        }
        return out
    }

    var isValid: Bool { problems.isEmpty }

    /// POST /v1/routines: a routine that runs in Walnut (the home chat's executor).
    func createBody(calendar: Calendar = .current) -> [String: JSONValue] {
        var body: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "executor": .object([
                "type": .string("main-agent"),
                "config": .object(["instructions": .string(sends.trimmingCharacters(in: .whitespacesAndNewlines))]),
            ]),
        ]
        if let schedule = schedule(calendar: calendar) { body["schedule"] = Self.json(schedule) }
        return body
    }

    /// PATCH /v1/routines/:id: the name, and whatever else differs from the draft the sheet opened with.
    func patchBody(original job: RoutineJob, initial: RoutineDraft, calendar: Calendar = .current) -> [String: JSONValue] {
        var body: [String: JSONValue] = ["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines))]
        if let schedule = schedule(calendar: calendar), schedule != initial.schedule(calendar: calendar) {
            body["schedule"] = Self.json(schedule)
        }
        // The executor goes back whole (the server replaces it) when what it sends or
        // the task it runs in changed: the keys the phone does not show ride along.
        let said = sends.trimmingCharacters(in: .whitespacesAndNewlines)
        let sendsChanged = canEditSends && said != initial.sends.trimmingCharacters(in: .whitespacesAndNewlines)
        let task = target.trimmingCharacters(in: .whitespacesAndNewlines)
        let targetChanged = canEditTarget && !task.isEmpty && task != initial.target.trimmingCharacters(in: .whitespacesAndNewlines)
        if let executor = job.executor, sendsChanged || targetChanged {
            var config = executor.config ?? [:]
            if sendsChanged { config[executor.sendsKey] = .string(said) }
            if targetChanged { config["target"] = .string(task) }
            body["executor"] = .object(["type": .string(executor.type), "config": .object(config)])
        }
        let run = checkRun.trimmingCharacters(in: .whitespacesAndNewlines)
        if let check = job.check, run != initial.checkRun.trimmingCharacters(in: .whitespacesAndNewlines) {
            var next: [String: JSONValue] = ["run": .string(run)]
            if let host = check.host { next["host"] = .string(host) }
            if let cwd = check.cwd { next["cwd"] = .string(cwd) }
            if let timeout = check.timeoutSeconds { next["timeoutSeconds"] = .number(Double(timeout)) }
            if let cap = check.maxFiresPerDay { next["maxFiresPerDay"] = .number(Double(cap)) }
            body["check"] = .object(next)
        }
        return body
    }

    static func json(_ s: RoutineJob.Schedule) -> JSONValue {
        var out: [String: JSONValue] = ["kind": .string(s.kind)]
        if let expr = s.expr { out["expr"] = .string(expr) }
        if let tz = s.tz, !tz.isEmpty { out["tz"] = .string(tz) }
        if let everyMs = s.everyMs { out["everyMs"] = .number(everyMs) }
        if let at = s.at { out["at"] = .string(at) }
        return .object(out)
    }
}

/// The sheet: Edit (a routine) or New Routine (nil). Save stays off until the draft
/// is valid; a server refusal shows inline and keeps the sheet open; Cancel drops it.
struct RoutineEditorSheet: View {
    let job: RoutineJob?
    let onSaved: (RoutineJob) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: RoutineDraft
    @State private var saving = false
    @State private var errorMessage: String?
    /// The task it runs in, as the server names it (nil while unknown or looked up).
    @State private var currentTask: RoutineTaskChoice?
    @State private var taskLookup: TaskLookup = .loading
    @State private var taskQuery = ""
    /// Open tasks for the query; nil before the first answer.
    @State private var taskHits: [RoutineTaskChoice]?
    @State private var taskSearching = false
    @State private var taskSearchError: String?
    /// The task picked here, kept so the saved routine names it at once.
    @State private var pickedTask: RoutineTaskChoice?
    /// The search for another task is open (after "Change task", or with no task yet):
    /// until then the section is the current task and one row, so the sheet's first
    /// screen still shows the schedule and what it sends (QA: eight tasks pushed them down).
    @State private var changingTask = false
    @FocusState private var searchFocused: Bool
    /// Cancel or a swipe down with unsaved changes asks first (2026-11-04, QA: a swipe
    /// dropped them without a word).
    @State private var confirmDiscard = false
    private let initial: RoutineDraft
    private let api = WalnutAPI()

    private enum TaskLookup: Equatable { case loading, found, missing, failed }

    init(job: RoutineJob?, onSaved: @escaping (RoutineJob) -> Void) {
        self.job = job
        self.onSaved = onSaved
        let start = job.map { RoutineDraft(job: $0) } ?? .new()
        initial = start
        _draft = State(initialValue: start)
        // The routine already names its task: shown at once, its state looked up.
        if let owner = job?.owner, owner.taskId == start.target, !owner.taskId.isEmpty {
            _currentTask = State(initialValue: RoutineTaskChoice(id: owner.taskId, title: owner.title ?? owner.taskId, project: owner.project))
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Theme.dangerText)
                            .accessibilityIdentifier("routines.editor.error")
                    }
                }
                Section("Name") {
                    TextField("Morning briefing", text: $draft.name)
                        .accessibilityIdentifier("routines.editor.name")
                }
                if draft.canEditTarget { taskSection }
                scheduleSection
                if draft.isTrigger {
                    Section {
                        TextField("sh ~/check.sh", text: $draft.checkRun, axis: .vertical)
                            .font(.body.monospaced())
                            .lineLimit(1...6)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("routines.editor.check")
                    } header: {
                        Text("Check command")
                    } footer: {
                        Text("Runs on \(hostName) each time; it fires when the command says so.")
                    }
                }
                if draft.canEditSends {
                    Section {
                        TextField("What should Walnut be told?", text: $draft.sends, axis: .vertical)
                            .lineLimit(4...12)
                            .accessibilityIdentifier("routines.editor.sends")
                    } header: {
                        Text(draft.isTrigger ? "What it sends when it fires" : "What it sends when it runs")
                    } footer: {
                        VStack(alignment: .leading, spacing: 4) {
                            if job == nil { Text("Runs in Home Chat: these instructions go to Walnut's own chat.") }
                            if !draft.problems.isEmpty {
                                Text(draft.problems.joined(separator: " "))
                                    .accessibilityIdentifier("routines.editor.problems")
                            }
                        }
                    }
                }
            }
            .task(id: draft.target) { await lookUpTask() }
            .task(id: TaskSearchKey(open: changingTask || needsATask, query: taskQuery)) { await searchTasks() }
            .navigationTitle(job == nil ? "New Routine" : "Edit Routine")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(saving || dirty)
            .background(SheetDismissAttempt {
                guard dirty, !saving else { return }
                // After the sheet has settled back: a dialog asked for while the drag's
                // transition is still ending is never shown.
                confirmDiscard = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { confirmDiscard = true }
            })
            // An alert, not a confirmation dialog: on iOS 26 the dialog is a popover that
            // drops its cancel button, so "Keep Editing" was only a tap outside (QA).
            .alert("Discard changes?", isPresented: $confirmDiscard) {
                Button("Keep Editing", role: .cancel) {}
                    .accessibilityIdentifier("routines.editor.keepEditing")
                Button("Discard Changes", role: .destructive) { dismiss() }
                    .accessibilityIdentifier("routines.editor.discard")
            } message: {
                Text(job == nil ? "This routine is not created yet." : "Your edits to this routine are not saved.")
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { if dirty { confirmDiscard = true } else { dismiss() } }
                        .disabled(saving)
                        .accessibilityIdentifier("routines.editor.cancel")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if saving {
                        ProgressView()
                    } else {
                        Button(job == nil ? "Create" : "Save") { Task { await save() } }
                            .fontWeight(.semibold)
                            .disabled(!draft.isValid)
                            .accessibilityIdentifier("routines.editor.save")
                    }
                }
            }
        }
    }

    // MARK: - Task (a session routine's)

    /// No task to run in yet (none chosen, or its id finds nothing): the search shows at once.
    private var needsATask: Bool {
        draft.target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || taskLookup == .missing
    }

    private struct TaskSearchKey: Equatable {
        let open: Bool
        let query: String
    }

    @ViewBuilder
    private var taskSection: some View {
        let choices = (taskHits ?? []).filter { $0.id != draft.target }
        let q = taskQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let searching = changingTask || needsATask
        Section {
            currentTaskRow
            if !searching {
                Button {
                    changingTask = true
                    // Once the field is there to take the focus.
                    DispatchQueue.main.async { searchFocused = true }
                } label: {
                    Text("Change task")
                        .foregroundStyle(RoutinesView.actionText)
                        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("routines.editor.changeTask")
            }
            if searching {
                TextField("Find an open task by its title", text: $taskQuery)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .focused($searchFocused)
                    .accessibilityIdentifier("routines.editor.taskSearch")
                ForEach(choices) { hit in
                    Button {
                        pick(hit)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(hit.title)
                                .foregroundStyle(Color.primary)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(hit.place)
                                .font(.footnote)
                                .foregroundStyle(Theme.secondaryOnCard)
                        }
                        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .combine)
                    .accessibilityHint("Runs the routine in this task")
                    .accessibilityIdentifier("routines.editor.taskHit.\(hit.id)")
                }
                if let taskSearchError {
                    Text(taskSearchError)
                        .font(.footnote)
                        .foregroundStyle(Theme.dangerText)
                        .accessibilityIdentifier("routines.editor.taskSearchError")
                } else if taskHits != nil, choices.isEmpty, !taskSearching {
                    Text(q.isEmpty ? "No open tasks." : "No open task has that in its title.")
                        .font(.footnote)
                        .foregroundStyle(Theme.secondaryOnCard)
                        .accessibilityIdentifier("routines.editor.taskNone")
                }
            }
        } header: {
            Text("Task")
        } footer: {
            Text(draft.isTrigger ? "It tells this task's session when its check fires." : "It runs in this task's session.")
        }
    }

    /// The task it runs in now: its title and project, and plainly when it is complete.
    @ViewBuilder
    private var currentTaskRow: some View {
        let id = draft.target.trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(alignment: .leading, spacing: 2) {
            if let task = currentTask, task.id == id {
                Text(task.title)
                    .font(.body.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if task.isComplete {
                    (Text(task.place).foregroundStyle(Theme.secondaryOnCard)
                     + Text(" · complete: change it to an open task").foregroundStyle(Theme.dangerText))
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(task.place)
                        .font(.footnote)
                        .foregroundStyle(Theme.secondaryOnCard)
                }
            } else if id.isEmpty {
                Text("No task chosen yet: pick one below.")
                    .foregroundStyle(Theme.secondaryOnCard)
            } else if taskLookup == .missing {
                Text("No task has the id \(id): pick one below.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.dangerText)
                    .fixedSize(horizontal: false, vertical: true)
            } else if taskLookup == .failed {
                Text("Could not look up its task (\(id)).")
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondaryOnCard)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Looking up the task…").foregroundStyle(Theme.secondaryOnCard)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("routines.editor.taskCurrent")
    }

    private func pick(_ hit: RoutineTaskChoice) {
        pickedTask = hit
        currentTask = hit
        taskLookup = .found
        draft.target = hit.id
        searchFocused = false
        taskQuery = ""
        changingTask = false
        UISelectionFeedbackGenerator().selectionChanged()
    }

    /// The current task's state (complete or open), by its id.
    private func lookUpTask() async {
        guard draft.canEditTarget else { return }
        let id = draft.target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { return }
        if pickedTask?.id == id { taskLookup = .found; return }
        taskLookup = .loading
        do {
            let found = try await api.routineTaskChoice(id: id)
            guard !Task.isCancelled else { return }
            if let found { currentTask = found; taskLookup = .found } else { taskLookup = .missing }
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            taskLookup = .failed
        }
    }

    /// Open tasks whose title holds the query, a moment after the typing stops; the
    /// latest edited ones while it is empty.
    private func searchTasks() async {
        guard draft.canEditTarget, changingTask || needsATask else { return }
        let q = taskQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty {
            try? await Task.sleep(for: .milliseconds(250))
            if Task.isCancelled { return }
        }
        taskSearching = true
        do {
            let found = try await api.routineTaskChoices(query: q)
            guard !Task.isCancelled else { return }
            taskHits = found
            taskSearchError = nil
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            guard !Task.isCancelled else { return }
            taskHits = []
            taskSearchError = "Could not search the tasks: \(RoutinesView.friendlyError(error))"
        }
        taskSearching = false
    }

    /// The draft differs from what the sheet opened with.
    private var dirty: Bool { draft != initial }

    private var hostName: String {
        guard let host = job?.check?.host, !host.isEmpty, host != "__local__" else { return "this computer" }
        return host
    }

    @ViewBuilder
    private var scheduleSection: some View {
        Section {
            Picker("Repeats", selection: $draft.repeatKind) {
                ForEach(draft.repeatOptions(original: initial)) { option in
                    Text(option == .once ? onceLabel : option.label).tag(option)
                }
            }
            .accessibilityIdentifier("routines.editor.repeat")
            switch draft.repeatKind {
            case .minutes, .hours:
                HStack(spacing: 8) {
                    Text("Every")
                    TextField("30", text: intervalText)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.center)
                        .frame(minWidth: 44, maxWidth: 80)
                        .padding(.vertical, 4)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 6))
                        .accessibilityLabel(draft.repeatKind == .minutes ? "Minutes" : "Hours")
                        .accessibilityIdentifier("routines.editor.interval")
                    Text(draft.repeatKind == .minutes ? (draft.interval == 1 ? "minute" : "minutes") : (draft.interval == 1 ? "hour" : "hours"))
                    Spacer(minLength: 0)
                    Stepper("", value: $draft.interval, in: 1...(draft.repeatKind == .minutes ? 1440 : 168))
                        .labelsHidden()
                }
            case .daily, .weekdays, .weekly:
                if draft.repeatKind == .weekly {
                    Picker("Day", selection: $draft.weekday) {
                        ForEach(0..<7, id: \.self) { Text(RoutineGroups.dayNames[$0]).tag($0) }
                    }
                    .accessibilityIdentifier("routines.editor.weekday")
                }
                DatePicker("At", selection: timeBinding, displayedComponents: .hourAndMinute)
                    .accessibilityIdentifier("routines.editor.time")
            case .cron:
                TextField("minute hour day month weekday", text: $draft.cronExpr)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("routines.editor.cron")
            case .once:
                EmptyView()
            }
        } header: {
            Text("Schedule")
        } footer: {
            if let schedule = draft.schedule() {
                Text(RoutineGroups.cadence(schedule, raw: true))
                    .accessibilityIdentifier("routines.editor.cadence")
            }
        }
    }

    private var onceLabel: String {
        guard let at = draft.onceAt, let date = WalnutTask.parseISO(at) else { return "Once" }
        return "Once at \(date.formatted(date: .abbreviated, time: .shortened))"
    }

    /// The interval as typed, so Save follows each keystroke (a value-formatted field
    /// only commits when editing ends). Digits only; empty reads as 0, which is refused.
    private var intervalText: Binding<String> {
        Binding(
            get: { draft.interval > 0 ? String(draft.interval) : "" },
            set: { text in draft.interval = Int(String(text.filter { $0.isASCII && $0.isNumber }.prefix(5))) ?? 0 }
        )
    }

    private var timeBinding: Binding<Date> {
        Binding(
            get: { Calendar.current.date(bySettingHour: draft.hour, minute: draft.minute, second: 0, of: Date()) ?? Date() },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                draft.hour = parts.hour ?? draft.hour
                draft.minute = parts.minute ?? draft.minute
            }
        )
    }

    private func save() async {
        guard draft.isValid, !saving else { return }
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            var saved: RoutineJob
            if let job {
                saved = try await api.updateRoutine(id: job.id, draft.patchBody(original: job, initial: initial))
                // An older server answers without the new task's name: the pick names it.
                if let picked = pickedTask, picked.id == draft.target, saved.owner?.taskId != picked.id {
                    saved.owner = RoutineJob.Owner(taskId: picked.id, title: picked.title, project: picked.project ?? "")
                }
                AppLog.info("routines", "edited routine", ["routineId": job.id])
            } else {
                saved = try await api.createRoutine(draft.createBody())
                AppLog.info("routines", "created routine", ["routineId": saved.id])
            }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            onSaved(saved)
            dismiss()
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            errorMessage = RoutinesView.friendlyError(error)
        }
    }
}

/// Calls `onAttempt` when the person swipes down a sheet whose dismissal is held
/// (`interactiveDismissDisabled`), so the sheet can ask instead of doing nothing.
/// SwiftUI has no hook for it: this wraps the sheet's presentation delegate and passes
/// every other call on to SwiftUI's own.
struct SheetDismissAttempt: UIViewRepresentable {
    let onAttempt: () -> Void

    func makeUIView(context: Context) -> Probe {
        let probe = Probe()
        probe.isUserInteractionEnabled = false
        probe.onAttempt = onAttempt
        return probe
    }

    func updateUIView(_ probe: Probe, context: Context) {
        probe.onAttempt = onAttempt
        probe.attach()
        // Again once SwiftUI has applied this update (it may set its own delegate anew).
        DispatchQueue.main.async { probe.attach() }
    }

    final class Probe: UIView {
        var onAttempt: (() -> Void)?
        private var relay: Relay?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            attach()
            DispatchQueue.main.async { [weak self] in self?.attach() }
        }

        /// The sheet's presentation controller: the root of this view's controllers.
        func attach() {
            guard window != nil else { return }
            var responder: UIResponder? = self
            var controller: UIViewController?
            while let next = responder {
                if let vc = next as? UIViewController { controller = vc; break }
                responder = next.next
            }
            while let parent = controller?.parent { controller = parent }
            guard let presentation = controller?.presentationController else { return }
            if let relay, presentation.delegate === relay { return }
            let next = Relay(original: presentation.delegate) { [weak self] in self?.onAttempt?() }
            relay = next
            presentation.delegate = next
        }
    }

    /// Our delegate in front of SwiftUI's: the attempt comes to us, everything goes on to it.
    final class Relay: NSObject, UIAdaptivePresentationControllerDelegate {
        /// Weak, as UIKit holds it: SwiftUI keeps its own delegate alive (a strong one here
        /// would hold the sheet's controller through the probe in its own view).
        weak var original: UIAdaptivePresentationControllerDelegate?
        let attempt: () -> Void

        init(original: UIAdaptivePresentationControllerDelegate?, attempt: @escaping () -> Void) {
            self.original = original
            self.attempt = attempt
        }

        func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) {
            attempt()
            original?.presentationControllerDidAttemptToDismiss?(presentationController)
        }

        override func responds(to selector: Selector!) -> Bool {
            super.responds(to: selector) || (original?.responds(to: selector) ?? false)
        }

        override func forwardingTarget(for selector: Selector!) -> Any? {
            original?.responds(to: selector) == true ? original : super.forwardingTarget(for: selector)
        }
    }
}
