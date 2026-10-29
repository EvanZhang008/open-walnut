import SwiftUI

/// The one user status of a task at the top of its detail sheet: the state, what the user
/// must do (Needs you) or on whom it waits (Waiting), and the session's own now / next
/// line with its time. The same words the web Board shows (`src/core/user-status.ts`).
struct TaskStatusCard: View {
    let task: WalnutTask

    var body: some View {
        let state = TeamStatusModel.state(of: task)
        let s = state == .done ? nil : task.userStatus
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                UserStatePill(state: state, stuck: s?.kind == "stuck")
                if let at = s?.at, !at.isEmpty {
                    Text("Updated \(RelativeTime.short(at))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if s?.stale == true {
                    Text("No update for a day")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Theme.warning.opacity(0.22), in: RoundedRectangle(cornerRadius: 4))
                }
            }
            if state == .needs, let ask = s?.ask, !ask.isEmpty {
                (Text("You decide: ").bold().foregroundColor(UserStatePill.textColor(.needs)) + Text(ask))
                    .font(.subheadline)
            }
            if state == .waiting {
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
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("task.userStatus")
    }
}

struct UserStatePill: View {
    let state: UserState
    var stuck = false

    static func color(_ s: UserState) -> Color {
        switch s {
        case .needs: return Color(red: 0.88, green: 0.38, blue: 0.10)
        case .working: return Color(red: 0.18, green: 0.44, blue: 0.94)
        case .waiting: return .secondary
        case .done: return Theme.success
        }
    }

    /// The same states as words, readable on both backgrounds (the tints above are for dots).
    static func textColor(_ s: UserState) -> Color {
        switch s {
        case .needs: return Theme.needsText
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
            Text(stuck ? "Stuck" : state.label)
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
/// that names what needs the user, the four state chips that filter, and one row per task.
/// Shown only for a task with a team (a subtask at least).
struct TeamStatusSection: View {
    let ownerId: String
    @Environment(TasksStore.self) private var tasks
    @State private var filter: UserState? = nil
    @State private var opened: WalnutTask?
    @State private var teamBusy = false
    @State private var teamError: String?

    var body: some View {
        let board = TeamStatusModel.build(ownerId: ownerId, tasks: tasks.tasks)
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
                            Button { opened = row.task } label: { TeamStatusRowView(row: row) }
                                .buttonStyle(.plain)
                            Divider()
                        }
                    }
                }
            }
            .accessibilityIdentifier("task.team")
            .sheet(item: $opened) { t in
                TaskDetailSheet(task: t)
                    .presentationDetents([.medium, .large])
            }
        }
    }

    /// Stop the whole team in one step, or resume it (server `src/core/sessions/team-stop.ts`).
    private func teamMenu(stopped: Bool) -> some View {
        Menu {
            if stopped {
                Button { run(stop: false) } label: { Label("Resume the team", systemImage: "play.fill") }
            } else {
                Button(role: .destructive) { run(stop: true) } label: { Label("Stop the team", systemImage: "stop.fill") }
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
        case .needs: return "Nothing needs you right now."
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
            Text(TeamStatusModel.countsLine(b))
                .font(.subheadline)
        }
        .accessibilityIdentifier("task.team.brief")
    }

    private func chips(_ b: TeamStatusBoard) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                chip("All open \(b.open.count)", on: filter == nil) { filter = nil }
                ForEach(UserState.allCases, id: \.self) { s in
                    chip("\(b.counts[s]) \(s.label)", on: filter == s, dot: UserStatePill.color(s)) { filter = s }
                }
            }
            .padding(.horizontal, 2)
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
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

struct TeamStatusRowView: View {
    let row: TeamStatusRow
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let s = row.status
        let time = Text(RelativeTime.short(date: TeamStatusModel.rowTime(row)))
            .font(.caption2)
            .foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 3) {
            if typeSize.isAccessibilitySize {
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
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    UserStatePill(state: row.state, stuck: row.isStuck)
                    Text(row.task.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    time
                }
            }
            if row.depth == 0 {
                Text("Lead").font(.caption2).foregroundStyle(.secondary)
            }
            if row.state == .needs, let ask = s?.ask, !ask.isEmpty {
                (Text("You: ").bold().foregroundColor(UserStatePill.textColor(.needs)) + Text(ask))
                    .font(.footnote)
            } else if row.state == .waiting {
                Text(TeamStatusModel.waitingLine(s))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(row.isStuck ? UserStatePill.stuckText : .primary)
            }
            if let due = s?.due {
                Text(due.state == "overdue" ? "Overdue: was due \(TeamStatusModel.dueText(due.at))" : "Due \(TeamStatusModel.dueText(due.at))")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill((due.state == "overdue" ? Color.red : Color.orange).opacity(0.18)))
                    .accessibilityIdentifier("task.team.due")
            }
            if let report = row.task.resultReport, report.isPartial {
                // Its latest result left things not done: "Done" alone would overstate it.
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Partial")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.orange.opacity(0.2)))
                    Text("Not done: \((report.notDone ?? []).joined(separator: "; "))")
                        .font(.footnote)
                        .lineLimit(3)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("task.team.partial")
            }
            if row.state == .working, let live = row.task.liveActivity {
                // Read from its session by the server, never the model's words; the spans tick here.
                TimelineView(.periodic(from: .now, by: 15)) { ctx in
                    let line = LiveActivityFormat.line(live, now: ctx.date)
                    HStack(spacing: 5) {
                        Circle()
                            .fill(line.quiet ? Color.orange : UserStatePill.textColor(.working))
                            .frame(width: 6, height: 6)
                        Text(line.text)
                            .font(.footnote.weight(.medium).monospacedDigit())
                            .foregroundStyle(line.quiet ? Color.orange : Color.primary)
                            .lineLimit(2)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("task.team.live")
                }
            }
            if let now = s?.now, !now.isEmpty {
                Text(now).font(.footnote).foregroundStyle(.secondary)
            }
            if row.state != .needs, let next = s?.next, !next.isEmpty {
                Text("Next: \(next)").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityIdentifier("task.team.row")
    }
}
