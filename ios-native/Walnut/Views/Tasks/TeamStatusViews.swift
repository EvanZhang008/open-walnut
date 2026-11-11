import SwiftUI

/// The one user status of a task at the top of its detail sheet: the state, what the user
/// must do (Needs you) or on whom it waits (Waiting), and the session's own now / next
/// line with its time. The same words the web Board shows (`src/core/user-status.ts`).
struct TaskStatusCard: View {
    let task: WalnutTask
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let state = TeamStatusModel.state(of: task)
        let s = state == .done ? nil : task.userStatus
        // The checked line already says when the session last said it: one time, not two.
        let checked = state == .needs && TeamStatusModel.checkedLine(s) != nil
        VStack(alignment: .leading, spacing: 6) {
            // Stacked at the largest sizes, so "Updated" is never broken into syllables.
            let header = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 8))
            header {
                UserStatePill(state: state, stuck: s?.kind == "stuck")
                if let at = s?.at, !at.isEmpty, !checked {
                    TimelineView(.periodic(from: .now, by: 30)) { ctx in
                        Text("Updated \(WalnutTask.parseISO(at).map { RelativeTime.short(date: $0, relativeTo: ctx.date.addingTimeInterval(AppClock.demoOffset)) } ?? "")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if s?.stale == true {
                    Text("No update for a day")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Theme.warning.opacity(0.22), in: RoundedRectangle(cornerRadius: 4))
                }
            }
            // What it needs from the user, its category word first ("Decide: ...", "Can close:
            // The result is ready"): the whole sentence here, where it is read.
            if state == .needs, let need = TeamStatusModel.needLine(s) {
                // The ask is the session's own words: the shared inline renderer and its links.
                (Text("\(need.category.label): ").bold().foregroundColor(NeedLineView.color(need.category))
                    + Text(MarkdownParser.inline(need.text)))
                    .font(.subheadline)
                    .handlingFilePathLinks(task: task, field: .needs)
                    .accessibilityIdentifier(TeamStatusModel.isToRead(s) ? "task.userStatus.read" : "task.userStatus.ask")
                if !TeamStatusModel.isToRead(s) { CheckedCaption(status: s, font: .caption, id: "task.userStatus.checked") }
            }
            // A turn just ended and its report is still coming: no placeholder words.
            if state == .waiting, s?.transient != true {
                Text(MarkdownParser.inline(TeamStatusModel.waitingLine(s)))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(s?.kind == "stuck" ? UserStatePill.stuckText : .primary)
                    .handlingFilePathLinks(task: task, field: .waiting)
            }
            // The session's own now / next / not-done words: the shared inline renderer
            // and its links, as the ask above.
            if let now = s?.now, !now.isEmpty {
                Text(MarkdownParser.inline(now)).font(.subheadline)
                    .handlingFilePathLinks(task: task, field: .now)
            }
            if let next = s?.next, !next.isEmpty, state != .needs {
                (Text("Next: ").foregroundColor(.secondary) + Text(MarkdownParser.inline(next)))
                    .font(.subheadline)
                    .handlingFilePathLinks(task: task, field: .next)
            }
            if let report = task.resultReport, report.isPartial {
                // Its latest result left things not done: the whole list, here where it is read.
                (Text("Partial. Not done: ").bold()
                    + Text(MarkdownParser.inline((report.notDone ?? []).joined(separator: "; "))))
                    .font(.subheadline)
                    .handlingFilePathLinks(task: task, field: .partial)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Each line above has its own handler: its words may come from an older session than
        // the task runs now, so a path in them opens from where they were written.
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("task.userStatus")
    }
}

/// Under a session's own "needs you": when it was last checked, or that it is not verified.
/// Ticks by itself, so "Checked 2m ago" never stays "now" (user-status.ts checkedLine).
struct CheckedCaption: View {
    let status: WalnutUserStatus?
    let font: Font
    let id: String

    var body: some View {
        // Whether there is a line does not depend on the time: decided outside, so no empty slot.
        if TeamStatusModel.checkedLine(status) != nil {
            TimelineView(.periodic(from: .now, by: 30)) { ctx in
                if let line = TeamStatusModel.checkedLine(status, now: ctx.date.addingTimeInterval(AppClock.demoOffset)) {
                    Text(line.text)
                        .font(font.weight(line.unverified ? .semibold : .regular))
                        .foregroundStyle(line.unverified ? UserStatePill.textColor(.needs) : .secondary)
                        .accessibilityIdentifier(id)
                }
            }
        }
    }
}

struct UserStatePill: View {
    let state: UserState
    var stuck = false

    /// Nonisolated: the timeline's layout actor colors a pill's dot with it.
    nonisolated static func color(_ s: UserState) -> Color {
        switch s {
        // To read is drawn as Needs you, never in a colour of its own.
        case .needs, .read: return Color(red: 0.88, green: 0.38, blue: 0.10)
        case .working: return Color(red: 0.18, green: 0.44, blue: 0.94)
        case .waiting: return .secondary
        case .done: return Theme.success
        }
    }

    /// The same states as words, readable on both backgrounds (the tints above are for dots).
    static func textColor(_ s: UserState) -> Color {
        switch s {
        case .needs, .read: return Theme.needsText
        case .working: return Theme.workingText
        case .waiting: return .primary
        case .done: return Theme.doneText
        }
    }

    static let stuckText = Theme.stuckText

    @ScaledMetric(relativeTo: .caption) private var dot: CGFloat = 7

    var body: some View {
        let tint = stuck ? Theme.warning : Self.color(state)
        HStack(spacing: 4) {
            if !stuck { Circle().fill(tint).frame(width: dot, height: dot) }
            // Stuck keeps the state's own name, in the warning colour (its words say why).
            Text(state.label)
                .lineLimit(1)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(stuck ? Self.stuckText : Self.textColor(state))
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(tint.opacity(0.15), in: Capsule())
        // Never squeezed into a broken word ("Need/s you"): the title beside it gives way instead.
        .fixedSize()
    }
}

/// A lead's team in its detail sheet, the web Board's Status view on the phone: a brief
/// that names what needs the user, the four state chips that filter (To read rows are under
/// Needs you), and one row per task.
/// Shown only for a task with a team (a subtask at least).
struct TeamStatusSection: View {
    let ownerId: String
    /// Open a team task's conversation. The task sheet presents it from its root: a sheet raised
    /// from inside its scroll content is rebuilt when a text field in it takes focus.
    var onOpenTask: (_ id: String, _ title: String?) -> Void
    @Environment(TasksStore.self) private var tasks
    /// The state chip picked (nil = All open), kept across a relaunch (`ViewMemory`).
    @AppStorage(ViewMemory.key("team", "filter"), store: AppPrefs.defaults) private var filterRaw = ""
    private var filter: TeamStatusChip? {
        get { TeamStatusChip(rawValue: filterRaw) }
        nonmutating set { filterRaw = newValue?.rawValue ?? "" }
    }
    @State private var teamBusy = false
    @State private var teamError: String?
    @State private var confirmStop = false

    var body: some View {
        let board = TeamStatusModel.build(ownerId: ownerId, tasks: tasks.tasks, includeOwner: false)
        if board.hasTeam {
            let stopped = tasks.tasks.first(where: { $0.id == ownerId })?.teamStop
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Team")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    teamMenu(stopped: stopped != nil)
                }
                if stopped != nil {
                    Text("Team stopped: its triggers and wake clocks are off; a task resumes on its next message.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("task.team.stopped")
                }
                if let teamError {
                    Text(teamError).font(.caption).foregroundStyle(.red)
                }
                brief(board)
                chips(board)
                    // A thumb that lands just below a chip filters, it does not open the first row.
                    .padding(.bottom, 6)
                let rows = filter.map { $0.rows(board) } ?? board.open
                if rows.isEmpty {
                    Text(Self.emptyText(filter))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(spacing: 0) {
                        ForEach(rows) { row in
                            Button { onOpenTask(row.task.id, AskProjectName.displayTitle(row.task.title, project: row.task.project, orgRole: row.task.orgRole)) } label: { TeamStatusRowView(row: row, flat: filter != nil) }
                                .buttonStyle(.plain)
                                // On the button, not its label: the row keeps its own id, and
                                // `.contain` keeps the ids inside (.checked, .due, .live, .partial).
                                .accessibilityElement(children: .contain)
                                .accessibilityIdentifier("task.team.row")
                            Divider()
                        }
                    }
                }
            }
            // `.contain` keeps the ids inside (task.team.menu, .due, .live, .partial) reachable.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("task.team")
            // A stop or a resume from anywhere settles what the last failure said.
            .onChange(of: stopped?.at) { teamError = nil }
            .confirmationDialog("Stop the whole team?", isPresented: $confirmStop, titleVisibility: .visible) {
                Button("Stop the team", role: .destructive) { run(stop: true) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Every working task in it stops, and its triggers and wake clocks go off until you resume it.")
            }
        }
    }

    /// Stop the whole team in one step, or resume it (server `src/core/sessions/team-stop.ts`).
    private func teamMenu(stopped: Bool) -> some View {
        Menu {
            if stopped {
                Button { run(stop: false) } label: { Label("Resume the team", systemImage: "play.fill") }
            } else {
                Button(role: .destructive) { confirmStop = true } label: { Label("Stop the team", systemImage: "stop.fill") }
            }
        } label: {
            Image(systemName: stopped ? "pause.circle.fill" : "ellipsis.circle")
                .font(.body)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .disabled(teamBusy)
        .accessibilityLabel(stopped ? "Team stopped, resume" : "Team actions")
        .accessibilityIdentifier("task.team.menu")
    }

    private func run(stop: Bool) {
        teamBusy = true
        teamError = nil
        let id = ownerId
        Task {
            do {
                _ = stop ? try await tasks.api.teamStop(id: id) : try await tasks.api.teamResume(id: id)
            } catch {
                teamError = Self.teamErrorText(error, stop: stop)
            }
            teamBusy = false
        }
    }

    /// A companion answers 501: a team stop runs on the Mac, which the phone reaches only directly.
    static func teamErrorText(_ error: Error, stop: Bool) -> String {
        if case .server(let status, _, _, _, _)? = error as? APIError, status == 501 {
            return "A team stop runs on your Mac: connect to it directly (same network or Tailscale) and try again."
        }
        return (stop ? "Could not stop the team: " : "Could not resume the team: ") + error.localizedDescription
    }

    static func emptyText(_ filter: TeamStatusChip?) -> String {
        switch filter {
        case nil: return "No open tasks on this team."
        case .needs: return "Nothing needs you right now."
        case .working: return "Nothing is working right now."
        case .waiting: return "Nothing is waiting right now."
        case .notStarted: return "Every task on this team has started."
        case .done: return "Nothing was done in the last \(TeamStatusModel.doneWindowDays) days."
        }
    }

    private func brief(_ b: TeamStatusBoard) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if b.needs.isEmpty {
                Text("Nothing needs you.")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(UserStatePill.textColor(.done))
            } else {
                (Text("\(b.needs.count) \(b.needs.count == 1 ? "needs" : "need") you: ").bold()
                    .foregroundColor(UserStatePill.textColor(.needs))
                    + Text(Self.briefWords(b)))
                    .font(.subheadline)
                    // Every file link in it carries its own task's writer.
                    .handlingTaggedFilePathLinks()
            }
        }
        .accessibilityIdentifier("task.team.brief")
    }

    static func briefWords(_ b: TeamStatusBoard) -> AttributedString {
        var out = AttributedString()
        for (i, r) in b.needs.enumerated() {
            let ask = TeamStatusModel.clause(r.status?.ask ?? "")
            let title = TeamStatusModel.clause(r.task.title)
            if i > 0 { out += AttributedString("; ") }
            // The title's writer is not recorded; the ask's is its Needs you writer.
            out += FilePreviewLink.tagging(MarkdownParser.inline(title), source: .unknown)
            if !ask.isEmpty {
                out += AttributedString(" (")
                    + FilePreviewLink.tagging(MarkdownParser.inline(ask), source: .forTaskText(r.task, .needs))
                    + AttributedString(")")
            }
        }
        return out + AttributedString(".")
    }

    private func chips(_ b: TeamStatusBoard) -> some View {
        // Wrapped onto a second line, never scrolled off the screen's edge.
        OrgChipFlow(spacing: 0) {
            chip("All open \(b.open.count)", on: filter == nil) { filter = nil }
            ForEach(TeamStatusChip.allCases, id: \.self) { c in
                chip("\(c.count(b)) \(c.label)", on: filter == c, dot: c.dot) { filter = c }
            }
        }
    }

    private func chip(_ text: String, on: Bool, dot: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let dot { Circle().fill(dot).frame(width: 7, height: 7) }
                Text(text)
            }
            .font(.caption.weight(.medium))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .overlay(Capsule().stroke(on ? Color.primary : Color.secondary.opacity(0.35), lineWidth: on ? 1.5 : 1))
            // The capsule stays small; the whole 48pt band around it takes the tap.
            .padding(.horizontal, 2)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

struct TeamStatusRowView: View {
    let row: TeamStatusRow
    /// A filter is on: a row whose leader the filter hides keeps no indent, so it never hangs off nothing.
    var flat = false
    /// Off where every row of the list is in one state, which the list already names (the
    /// work card's lists): the pill would only repeat it, and the time says what it is of.
    var showsPill = true
    /// What the task says about itself, under a row with no ask of its own (the work card's
    /// Completed list: its result). Nil keeps the row as it was.
    var detail: String? = nil
    /// Which of the task's texts `detail` is, so a path in it opens from where it was written;
    /// nil opens nothing.
    var detailField: LinkSource.TaskTextField? = nil
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // With no pill to read it against, the time says what it is the time of.
        let time = RowTime(date: TeamStatusModel.rowTime(row), verb: showsPill ? nil : Self.timeVerb(row))
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 3) {
                    // No room for three things on one line at these sizes: the title gets its own.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) {
                            if showsPill { UserStatePill(state: row.state, stuck: row.isStuck) }
                            Spacer(minLength: 4)
                            time
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            if showsPill { UserStatePill(state: row.state, stuck: row.isStuck) }
                            time
                        }
                    }
                    Text(AskProjectName.displayTitle(row.task.title, project: row.task.project, orgRole: row.task.orgRole))
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(3)
                    details
                }
            } else {
                // A dot, not the pill: the title gets the row's width (2026-11-04 review: a
                // "Waiting / snoozed" pill took a third of it). The label still reads its state.
                // The lines under the title start where the title does, right of the dot.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "circle.fill")
                        .font(.subheadline)
                        .imageScale(.small)
                        .foregroundStyle(row.isStuck ? UserStatePill.stuckText : UserStatePill.color(row.state))
                        .accessibilityLabel(row.state.label)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(AskProjectName.displayTitle(row.task.title, project: row.task.project, orgRole: row.task.orgRole))
                                .font(.subheadline.weight(.semibold))
                                .lineLimit(2)
                            Spacer(minLength: 4)
                            time
                        }
                        details
                    }
                }
            }
        }
        .padding(.vertical, 8)
        // A worker's worker sits under its leader.
        .padding(.leading, flat ? 0 : CGFloat(max(0, row.depth - 1)) * 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// One line under the title, what the user reads at a glance: what it needs from him,
    /// else what it does now, else on whom it waits (2026-11-04, the user on the phone's
    /// team list: too long; no command lines, Partial lists or Next lines here, the task's
    /// own page has them).
    @ViewBuilder
    private var details: some View {
        let s = row.status
        if row.state == .needs, let need = TeamStatusModel.needLine(s) {
            NeedLineView(need: need, toRead: row.isToRead, font: .footnote, id: "task.team.need", task: row.task)
        } else if let detail, !detail.isEmpty {
            Text(MarkdownParser.inline(detail))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .handlingFilePathLinks(source: detailField.map { LinkSource.forTaskText(row.task, $0) } ?? LinkSource.unknown)
                .accessibilityIdentifier("task.team.detail")
        } else if let line = OrgNodeTasksModel.line(row.task) {
            Text(MarkdownParser.inline(line))
                .font(.footnote)
                .foregroundStyle(row.isStuck ? UserStatePill.stuckText : .secondary)
                .lineLimit(1)
                .handlingFilePathLinks(source: OrgNodeTasksModel.lineSource(row.task))
        }
        if let due = s?.due {
            Text(due.state == "overdue" ? "Overdue: was due \(TeamStatusModel.dueText(due.at))" : "Due \(TeamStatusModel.dueText(due.at))")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Capsule().fill((due.state == "overdue" ? Color.red : Color.orange).opacity(0.18)))
                .accessibilityIdentifier("task.team.due")
        }
    }
}

/// A Needs you row's third line: its category word in bold and its colour, then what it needs
/// from the user (its ask, or what there is to read) muted, ONE line truncated with an ellipsis,
/// never wrapping. A To read row leads it with a small document mark; neither wears Waiting's
/// marks.
struct NeedLineView: View {
    let need: TeamStatusModel.NeedLine
    let toRead: Bool
    let font: Font
    let id: String
    var task: WalnutTask? = nil

    /// The category word's colour: Decide red, Review orange, Take a look blue, Can close green.
    static func color(_ c: NeedCategory) -> Color {
        switch c {
        case .decide: return Theme.decideText
        case .review: return Theme.reviewText
        case .look: return Theme.workingText
        case .close: return Theme.doneText
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            if toRead {
                Image(systemName: "doc.text")
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            (Text("\(need.category.label): ").bold().foregroundColor(Self.color(need.category))
                + Text(MarkdownParser.inline(need.text)).foregroundColor(.secondary))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .font(font)
        // Its words are the task's Needs you line, from that line's own writer.
        .handlingFilePathLinks(source: task.map { LinkSource.forTaskText($0, .needs) } ?? LinkSource.unknown)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(id)
    }
}

extension TeamStatusRowView {
    /// What `TeamStatusModel.rowTime` is the time of, for this row.
    static func timeVerb(_ row: TeamStatusRow) -> String {
        switch row.state {
        case .done: return "Finished"
        case .working where row.task.liveActivity?.turnStartedAt != nil: return "Started"
        case .needs: return "Asked"
        default: return "Updated"
        }
    }
}

/// A row's time, ticking (30 s), on the AppClock. `verb`: "Started 3 hrs ago".
private struct RowTime: View {
    let date: Date
    var verb: String? = nil

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            let ago = RelativeTime.short(date: date, relativeTo: ctx.date.addingTimeInterval(AppClock.demoOffset))
            Text(verb.map { "\($0) \(ago == "now" ? "just now" : ago)" } ?? ago)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

/// The chips over a team's rows, in order: each shown group, with Not started after Waiting /
/// snoozed (the web's `STATUS_CHIPS`). The raw values are the kept filter's words, so a filter an
/// older build kept ("waiting", "needs") still reads.
enum TeamStatusChip: String, CaseIterable {
    case needs, working, waiting, notStarted = "notstarted", done

    var label: String {
        switch self {
        case .needs: return UserState.needs.label
        case .working: return UserState.working.label
        case .waiting: return UserState.waiting.label
        case .notStarted: return TeamStatusModel.notStartedLabel
        case .done: return UserState.done.label
        }
    }

    /// A chip's rows: Waiting / snoozed leaves the not started ones to their own chip.
    func rows(_ b: TeamStatusBoard) -> [TeamStatusRow] {
        switch self {
        case .needs: return b.needs
        case .working: return b.working
        case .waiting: return b.waitingRows
        case .notStarted: return b.notStartedRows
        case .done: return b.done
        }
    }

    func count(_ b: TeamStatusBoard) -> Int { rows(b).count }

    /// Not started wears no state colour of its own: a plain grey dot.
    var dot: Color {
        switch self {
        case .needs: return UserStatePill.color(.needs)
        case .working: return UserStatePill.color(.working)
        case .waiting: return UserStatePill.color(.waiting)
        case .notStarted: return Color(.tertiaryLabel)
        case .done: return UserStatePill.color(.done)
        }
    }
}
