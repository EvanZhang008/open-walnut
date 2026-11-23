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

/// The drawer's org view: the CEO on top, then one row per VP, as plain as the web Org list: the
/// avatar, the name and one red dot when its threads (or asks) wait on the user (2026-11-22, the
/// user: "just show name of vp icon, read dot for thread"). Its state, line and counts are in the
/// VoiceOver label (`accessibilityText`, from `ChatOrgModel`). A tap opens that node's chat.
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

    /// The row's red dot: on the CEO's and a VP's own row its threads for him, else what it asks of
    /// him (as on the web's `rowDot`). A count of 0 draws nothing.
    static func hasDot(_ row: ChatOrgModel.Row) -> Bool {
        if let t = row.threadsBadge { return t > 0 }
        return row.needs > 0
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

    /// At the accessibility sizes a name wraps instead of being cut.
    private var lines: Int { typeSize.isAccessibilitySize ? 3 : 1 }

    var body: some View {
        HStack(spacing: 10) {
            avatar
            // Only the name: no line under it, no count, no time and no state mark (2026-11-22, the
            // user: "We need to be super simple"); VoiceOver reads the rest (accessibility label).
            Text(verbatim: row.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(lines)
            Spacer(minLength: 4)
            if ChatDrawerOrgList.hasDot(row) {
                Circle()
                    .fill(UserStatePill.color(.needs))
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
    }

    /// The node's Org avatar when the server draws one (`OrgAvatar`), else its initials.
    private var avatar: some View {
        let ceo = row.kind == .ceo
        return OrgAvatar(taskId: row.contactId, side: 34) {
            Text(verbatim: ceo ? "C" : ChatOrgModel.initials(row.name))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(ceo ? Theme.onTint : .white)
                .frame(width: 34, height: 34)
                .background(ceo ? Theme.accent : Self.color(ChatOrgModel.avatarColor(row.name)), in: Circle())
        }
    }

    static func color(_ rgb: Int) -> Color {
        Color(red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
    }
}
