import SwiftUI

/// Which list the Chat drawer shows under New chat: the org (the CEO and each VP, the default)
/// or the agents with their recent chats. The user's pick is kept across launches.
enum ChatDrawerView: String, CaseIterable, Identifiable {
    case org, chats
    var id: String { rawValue }
    var label: String {
        switch self {
        case .org: return "Org"
        case .chats: return "Chats"
        }
    }

    static let storageKey = "chat.drawer.view"
}

/// The drawer's org view: the CEO on top, then one row per VP, each with its live status the
/// way the web Org page shows it (`ChatOrgModel`). A tap opens that node's chat.
///
/// With Directors on (`DirectorsSettings.enabled`), each VP's Directors show in the layout the
/// user picked (`ChatDirectorsModel`): folded under the VP, or in a section after the VPs. A long
/// press on a VP offers New Director, on a Director Remove from Directors.
struct ChatDrawerOrgList: View {
    let rows: [ChatOrgModel.Row]
    /// nil while the first load runs; set when it failed and nothing is shown yet.
    let loadError: String?
    let loading: Bool
    let retry: () -> Void
    let open: (ChatOrgModel.Row) -> Void
    /// The org tree and the task list the Directors are read from (nil tree: none shown).
    var tree: OrgTreeWire? = nil
    var tasks: [WalnutTask] = []
    var directors: DirectorsSettings = DirectorsSettings()
    /// nil: no Director actions here (Directors off, or a host without them).
    var actions: ChatDirectorActions? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if rows.isEmpty {
                placeholder
            } else {
                let shown = showsDirectors ? tree : nil
                let folds: [String: ChatDirectorsModel.Fold] = shown.map { directors.layout == .fold
                    ? ChatDirectorsModel.folds(rows: rows, tree: $0, tasks: tasks, showProjects: directors.showProjects) : [:] } ?? [:]
                ForEach(rows) { row in
                    if row.kind == .vp, row.id == rows.first(where: { $0.kind == .vp })?.id {
                        heading("VPs")
                    }
                    Button { open(row) } label: { ChatOrgRowView(row: row) }
                        .buttonStyle(.plain)
                        .modifier(VPRowMenu(row: row, actions: showsDirectors ? actions : nil))
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Self.accessibilityText(row))
                        .accessibilityAddTraits(.isButton)
                        .accessibilityIdentifier("chat.drawer.org.\(row.id)")
                    if let fold = folds[row.id], let actions {
                        ChatDirectorFold(row: row, fold: fold, actions: actions)
                    }
                }
                if let shown, directors.layout == .sections, let actions {
                    let list = ChatDirectorsModel.sections(rows: rows, tree: shown, tasks: tasks)
                    if !list.isEmpty {
                        heading("Directors")
                            .accessibilityIdentifier("chat.drawer.directors.header")
                        ForEach(list) { d in
                            Button {
                                guard !actions.suppressed() else { return }
                                actions.open(d)
                            } label: { ChatDirectorSectionRow(director: d) }
                                .buttonStyle(.plain)
                                .contextMenu { ChatDirectorMenu(director: d, actions: actions) }
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel("\(d.title), Director, \(ChatDirectorsModel.sectionLine(d))")
                                .accessibilityAddTraits(.isButton)
                                .accessibilityIdentifier("chat.drawer.director.\(d.id)")
                        }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.drawer.orgList")
    }

    private var showsDirectors: Bool { directors.enabled && actions != nil }

    private func heading(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private var placeholder: some View {
        if let loadError, !loading {
            VStack(alignment: .leading, spacing: 6) {
                Text("Couldn't load the org")
                    .font(.subheadline)
                Text(verbatim: loadError)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                Button(action: retry) {
                    Text("Try again")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.tint)
                        .frame(minWidth: 88, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat.drawer.org.retry")
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
        } else {
            HStack(spacing: 8) {
                ProgressView()
                Text("Loading the org")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
        }
    }

    static func accessibilityText(_ row: ChatOrgModel.Row) -> String {
        var parts = [row.name]
        if row.kind == .vp { parts.append("VP") }
        if !row.ledProjects.isEmpty { parts.append("also leads \(row.ledProjects.joined(separator: ", "))") }
        parts.append(row.lineWatched ? "watched, \(row.line)" : row.line)
        if let t = row.threadsBadge {
            parts.append(ChatOrgModel.threadCountLabel(t))
        } else if row.needs > 0 {
            parts.append("\(row.needs) \(row.needs == 1 ? "needs" : "need") you")
        }
        return parts.joined(separator: ", ")
    }
}

/// A VP row's long press while Directors are on: New Director. No menu at all otherwise.
private struct VPRowMenu: ViewModifier {
    let row: ChatOrgModel.Row
    let actions: ChatDirectorActions?

    func body(content: Content) -> some View {
        if let actions, row.kind == .vp {
            content.contextMenu {
                Button {
                    actions.newDirector(row)
                } label: {
                    Label("New Director…", systemImage: "person.badge.plus")
                }
                .accessibilityIdentifier("chat.drawer.org.newDirector")
            }
        } else {
            content
        }
    }
}

struct ChatOrgRowView: View {
    let row: ChatOrgModel.Row
    @Environment(\.dynamicTypeSize) private var typeSize

    /// At the accessibility sizes a row wraps instead of cutting its state off.
    private var lines: Int { typeSize.isAccessibilitySize ? 3 : 1 }

    var body: some View {
        HStack(spacing: 10) {
            avatar
            VStack(alignment: .leading, spacing: 2) {
                // At the accessibility sizes the "+N" goes under the name, so a short name is
                // never broken mid-word to make room for it.
                let nameLayout = typeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                    : AnyLayout(HStackLayout(spacing: 6))
                nameLayout {
                    Text(verbatim: row.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(lines)
                        .layoutPriority(1)
                    if !row.ledProjects.isEmpty {
                        Text(verbatim: "+\(row.ledProjects.count)")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.15), in: Capsule())
                            .fixedSize()
                    }
                }
                // A watched thread named on the line wears the Threads card's eye.
                (row.lineWatched ? Text("\(Image(systemName: "eye.fill")) \(Text(verbatim: row.line))") : Text(verbatim: row.line))
                    .font(.caption)
                    .foregroundStyle(row.state == .needs ? UserStatePill.textColor(.needs) : .secondary)
                    .lineLimit(lines)
            }
            Spacer(minLength: 4)
            badge
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
    }

    private var avatar: some View {
        let ceo = row.kind == .ceo
        return Text(verbatim: ceo ? "C" : ChatOrgModel.initials(row.name))
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ceo ? Theme.onTint : .white)
            .frame(width: 34, height: 34)
            .background(ceo ? Theme.accent : Self.color(ChatOrgModel.avatarColor(row.name)), in: Circle())
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(row.state == .waiting ? Color(.systemGray) : UserStatePill.color(row.state))
                    .frame(width: 11, height: 11)
                    .overlay(Circle().stroke(Color(.secondarySystemBackground), lineWidth: 2))
                    .offset(x: 2, y: 2)
            }
    }

    static func color(_ rgb: Int) -> Color {
        Color(red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
    }

    @ViewBuilder
    private var badge: some View {
        // The CEO's and a VP's own row: its threads, red, else "0" in grey (as on the web).
        if let t = row.threadsBadge {
            count(t, color: t > 0 ? UserStatePill.color(.needs) : Color(.systemGray3))
        } else if row.needs > 0 {
            count(row.needs, color: UserStatePill.color(.needs))
        } else if row.kind == .vp, row.working > 0 {
            count(row.working, color: UserStatePill.color(.working))
        }
    }

    private func count(_ n: Int, color: Color) -> some View {
        Text(verbatim: "\(n)")
            .font(.caption.weight(.bold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .frame(minWidth: 22, minHeight: 20)
            .background(color, in: Capsule())
    }
}
