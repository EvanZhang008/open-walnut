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
                (Text("\(need.category.label): ").bold().foregroundColor(NeedLineView.color(need.category)) + Text(need.text))
                    .font(.subheadline)
                    .accessibilityIdentifier(TeamStatusModel.isToRead(s) ? "task.userStatus.read" : "task.userStatus.ask")
                if !TeamStatusModel.isToRead(s) { CheckedCaption(status: s, font: .caption, id: "task.userStatus.checked") }
            }
            // A turn just ended and its report is still coming: no placeholder words.
            if state == .waiting, s?.transient != true {
                Text(TeamStatusModel.waitingLine(s))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(s?.kind == "stuck" ? UserStatePill.stuckText : .primary)
            }
            if let now = s?.now, !now.isEmpty {
                Text(now).font(.subheadline)
            }
            if let next = s?.next, !next.isEmpty, state != .needs {
                (Text("Next: ").foregroundColor(.secondary) + Text(next))
                    .font(.subheadline)
            }
            if let report = task.resultReport, report.isPartial {
                // Its latest result left things not done: the whole list, here where it is read.
                (Text("Partial. Not done: ").bold() + Text((report.notDone ?? []).joined(separator: "; ")))
                    .font(.subheadline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
    @Environment(TasksStore.self) private var tasks
    @State private var filter: UserState? = nil
    @State private var opened: WalnutTask?
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
                let rows = filter.map { board.rows($0) } ?? board.open
                if rows.isEmpty {
                    Text(Self.emptyText(filter))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(spacing: 0) {
                        ForEach(rows) { row in
                            Button { opened = row.task } label: { TeamStatusRowView(row: row, flat: filter != nil) }
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
            // A team row opens that task's conversation (its task page only when it has none).
            .sheet(item: $opened) { t in
                TaskSessionSheet(target: TaskOpenTarget(id: t.id, title: t.title))
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
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

    static func emptyText(_ filter: UserState?) -> String {
        switch filter {
        case nil: return "No open tasks on this team."
        case .needs, .read: return "Nothing needs you right now."
        case .working: return "Nothing is working right now."
        case .waiting: return "Nothing is waiting right now."
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
                let lines = b.needs.map { r -> String in
                    let ask = TeamStatusModel.clause(r.status?.ask ?? "")
                    let title = TeamStatusModel.clause(r.task.title)
                    return ask.isEmpty ? title : "\(title) (\(ask))"
                }
                (Text("\(b.needs.count) \(b.needs.count == 1 ? "needs" : "need") you: ").bold()
                    .foregroundColor(UserStatePill.textColor(.needs))
                    + Text(lines.joined(separator: "; ") + "."))
                    .font(.subheadline)
            }
        }
        .accessibilityIdentifier("task.team.brief")
    }

    private func chips(_ b: TeamStatusBoard) -> some View {
        // Wrapped onto a second line, never scrolled off the screen's edge.
        OrgChipFlow(spacing: 0) {
            chip("All open \(b.open.count)", on: filter == nil) { filter = nil }
            ForEach(UserState.groups, id: \.self) { s in
                chip("\(b.counts[s]) \(s.label)", on: filter == s, dot: UserStatePill.color(s)) { filter = s }
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
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let time = RowTime(date: TeamStatusModel.rowTime(row))
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 3) {
                    // No room for three things on one line at these sizes: the title gets its own.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) {
                            UserStatePill(state: row.state, stuck: row.isStuck)
                            Spacer(minLength: 4)
                            time
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            UserStatePill(state: row.state, stuck: row.isStuck)
                            time
                        }
                    }
                    Text(row.task.title)
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
                            Text(row.task.title)
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
            NeedLineView(need: need, toRead: row.isToRead, font: .footnote, id: "task.team.need")
        } else if let line = OrgNodeTasksModel.line(row.task) {
            Text(line)
                .font(.footnote)
                .foregroundStyle(row.isStuck ? UserStatePill.stuckText : .secondary)
                .lineLimit(1)
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
                + Text(need.text).foregroundColor(.secondary))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .font(font)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(id)
    }
}

/// A row's time, ticking (30 s), on the AppClock.
private struct RowTime: View {
    let date: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            Text(RelativeTime.short(date: date, relativeTo: ctx.date.addingTimeInterval(AppClock.demoOffset)))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
