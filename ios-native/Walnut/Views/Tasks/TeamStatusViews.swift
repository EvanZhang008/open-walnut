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
                (Text("You decide: ").bold().foregroundColor(UserStatePill.color(.needs)) + Text(ask))
                    .font(.subheadline)
            }
            if state == .waiting {
                Text(TeamStatusModel.waitingLine(s))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(s?.kind == "stuck" ? Theme.warning : .primary)
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

    var body: some View {
        let tint = stuck ? Theme.warning : Self.color(state)
        HStack(spacing: 4) {
            if !stuck { Circle().fill(tint).frame(width: 7, height: 7) }
            Text(stuck ? "Stuck" : state.label)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(state == .waiting && !stuck ? Color.primary : tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(tint.opacity(0.15), in: Capsule())
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

    var body: some View {
        let board = TeamStatusModel.build(ownerId: ownerId, tasks: tasks.tasks)
        if board.hasTeam {
            VStack(alignment: .leading, spacing: 10) {
                Text("Team")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                brief(board)
                chips(board)
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
                    .foregroundStyle(Theme.success)
            } else {
                let lines = b.needs.map { r -> String in
                    let ask = r.status?.ask ?? ""
                    return ask.isEmpty ? r.task.title : "\(r.task.title) (\(ask))"
                }
                (Text("\(b.needs.count) \(b.needs.count == 1 ? "needs" : "need") you: ").bold()
                    .foregroundColor(UserStatePill.color(.needs))
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
            HStack(spacing: 6) {
                chip("All open \(b.open.count)", on: filter == nil) { filter = nil }
                ForEach(UserState.allCases, id: \.self) { s in
                    chip("\(b.counts[s]) \(s.label)", on: filter == s, dot: UserStatePill.color(s)) { filter = s }
                }
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
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .overlay(Capsule().stroke(on ? Color.primary : Color.secondary.opacity(0.35), lineWidth: on ? 1.5 : 1))
        }
        .buttonStyle(.plain)
    }
}

struct TeamStatusRowView: View {
    let row: TeamStatusRow

    var body: some View {
        let s = row.status
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                UserStatePill(state: row.state, stuck: row.isStuck)
                Text(row.task.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 4)
                Text(RelativeTime.short(date: TeamStatusModel.rowTime(row)))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if row.depth == 0 {
                Text("Lead").font(.caption2).foregroundStyle(.secondary)
            }
            if row.state == .needs, let ask = s?.ask, !ask.isEmpty {
                (Text("You: ").bold().foregroundColor(UserStatePill.color(.needs)) + Text(ask))
                    .font(.footnote)
            } else if row.state == .waiting {
                Text(TeamStatusModel.waitingLine(s))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(row.isStuck ? Theme.warning : .primary)
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
