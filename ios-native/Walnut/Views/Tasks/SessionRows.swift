import SwiftUI

/// One session row in the Tasks panel's Sessions tab — status dot, title,
/// host/model chips, relative activity time. Read-only (v1 projection).
struct SessionRowView: View {
    let session: WalnutSession

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            statusDot
                .padding(.top, 5)

            VStack(alignment: .leading, spacing: 3) {
                // Task name IS the row — give it two lines so long names show as
                // much as possible. No grey preview subtitle (it stole a line
                // from the name and read as clutter).
                HStack(alignment: .top, spacing: 5) {
                    if session.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.tint)
                            .padding(.top, 3)
                    }
                    Text(session.rowTitle)
                        .font(.body.weight(.medium))
                        .lineLimit(2)
                    if session.forkDepth > 0 {
                        HStack(spacing: 2) {
                            Image(systemName: "arrow.triangle.branch")
                                .font(.system(size: 9, weight: .semibold))
                            if session.forkDepth > 1 {
                                Text("\(session.forkDepth)")
                                    .font(.caption2.weight(.semibold))
                            }
                        }
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Color(.tertiarySystemFill), in: Capsule())
                    }
                }
                HStack(spacing: 6) {
                    chip(session.isLocal ? "Mac" : session.host,
                         icon: session.isLocal ? "laptopcomputer" : "server.rack")
                    if let model = session.model {
                        chip(WalnutSession.shortModelName(model), icon: nil)
                    }
                    if let when = session.lastActiveValue {
                        Text(when.formatted(.relative(presentation: .named)))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    private var statusDot: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 9, height: 9)
    }

    private var statusColor: Color {
        switch session.statusKind {
        case .running: return Theme.success
        case .idle: return Theme.warning
        case .error: return Theme.danger
        case .stopped, .unknown: return Color(.systemGray3)
        }
    }

    private func chip(_ text: String, icon: String?) -> some View {
        HStack(spacing: 3) {
            if let icon {
                Image(systemName: icon).font(.system(size: 9))
            }
            Text(text).font(.caption2)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color(.tertiarySystemFill), in: Capsule())
        .foregroundStyle(.secondary)
    }

}

/// Session metadata — Details / Task / About, presented from the conversation
/// page's info button. The live transcript now lives on SessionConversationView;
/// this sheet is the "what is this session" reference. `processStatus` is passed
/// in so the sheet reflects the conversation's live status, not the stale
/// projection value the row was rendered with.
struct SessionInfoSheet: View {
    let session: WalnutSession
    let processStatus: String

    var body: some View {
        NavigationStack {
            List {
                Section {
                    SessionRowView(session: session)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }

                Section("Details") {
                    row("Status", processStatus.capitalized)
                    row("Machine", session.isLocal ? "Mac (primary)" : session.host)
                    if let model = session.model { row("Model", model) }
                    if let mode = session.mode { row("Mode", mode.capitalized) }
                    row("Messages", "\(session.messageCount)")
                    if let started = WalnutTask.parseISO(session.startedAt) {
                        row("Started", started.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let active = session.lastActiveValue {
                        row("Last active", active.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let cwd = session.cwd {
                        row("Directory", cwd)
                    }
                }

                if let taskTitle = session.taskTitle {
                    Section("Task") {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(taskTitle)
                            // One grouping layer now: the project, or Inbox.
                            let project = session.project ?? ""
                            Text(project.isEmpty ? "Inbox" : project)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if let description = session.description, !description.isEmpty {
                    Section("About") {
                        Text(description)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Session")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
                .lineLimit(3)
                .font(.callout)
        }
    }
}
