import SwiftUI

/// What the drawer's Director rows can do, handed down from the org list.
struct ChatDirectorActions {
    /// Open a Director's chat (the drawer's org-node open).
    let open: (ChatDirectorsModel.Director) -> Void
    /// Long-press: Remove from Directors.
    let remove: (ChatDirectorsModel.Director) -> Void
    /// A VP's "New Director" (its row's long-press, and the fold's last row).
    let newDirector: (ChatOrgModel.Row) -> Void
    /// While a drawer drag is tracked, no row acts (`ChatDrawer.suppressTaps`).
    let suppressed: () -> Bool
}

/// The fold layout: under a VP row, "▸ N directors", folded until he opens it, kept per VP
/// across launches (`ViewMemory`). Opened: its Directors (one level: the first leaders under the VP),
/// under small project headings when he shows project names, then "New Director".
struct ChatDirectorFold: View {
    let row: ChatOrgModel.Row
    let fold: ChatDirectorsModel.Fold
    let actions: ChatDirectorActions
    @AppStorage private var isOpen: Bool
    @Environment(\.walnutPalette) private var palette

    init(row: ChatOrgModel.Row, fold: ChatDirectorsModel.Fold, actions: ChatDirectorActions) {
        self.row = row
        self.fold = fold
        self.actions = actions
        _isOpen = AppStorage(wrappedValue: false, Self.storageKey(row.id), store: AppPrefs.defaults)
    }

    static func storageKey(_ vpRowId: String) -> String {
        ViewMemory.key("chatDrawer", "directorsOpen", id: vpRowId)
    }

    /// Lines up with the VP's name: the row's 20pt inset, its 34pt avatar and the 10pt gap.
    static let nameInset: CGFloat = 64

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard !actions.suppressed() else { return }
                withAnimation(.easeInOut(duration: 0.2)) { isOpen.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                    Text(verbatim: ChatDirectorsModel.countLabel(fold.count))
                        .font(.footnote)
                }
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .padding(.leading, Self.nameInset)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(ChatDirectorsModel.countLabel(fold.count)) under \(row.name)")
            .accessibilityValue(isOpen ? "open" : "folded")
            .accessibilityIdentifier("chat.drawer.directors.fold.\(row.id)")
            if isOpen {
                ForEach(fold.groups) { group in
                    // A heading only when it tells two projects apart, as on the web's fold.
                    if fold.groups.count > 1, let project = group.project {
                        Text(verbatim: project)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.leading, Self.nameInset + 4)
                            .padding(.top, 6)
                            .padding(.bottom, 2)
                            .accessibilityAddTraits(.isHeader)
                    }
                    ForEach(group.directors) { d in
                        Button {
                            guard !actions.suppressed() else { return }
                            actions.open(d)
                        } label: { ChatDirectorFoldRow(director: d) }
                            .buttonStyle(.plain)
                            .contextMenu { ChatDirectorMenu(director: d, actions: actions) }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("\(d.title), Director, \(d.stateText.isEmpty ? d.state.label : d.stateText)")
                            .accessibilityAddTraits(.isButton)
                            .accessibilityIdentifier("chat.drawer.director.\(d.id)")
                    }
                }
                Button {
                    guard !actions.suppressed() else { return }
                    actions.newDirector(row)
                } label: {
                    Label("New Director", systemImage: "plus")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(palette.tint)
                        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                        .padding(.leading, Self.nameInset + 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat.drawer.directors.new.\(row.id)")
            }
        }
    }
}

/// One Director in an opened fold, drawn as the org list's own plain row (`ChatOrgRowView`): its Org
/// avatar, its title on one line and the list's red dot only when it waits on the user; no state dot
/// (2026-11-25, as the web's fold row `DirectorListRow`; the user's "super simple" rows, 2026-11-22).
/// VoiceOver still reads its state (the fold's accessibility label).
struct ChatDirectorFoldRow: View {
    let director: ChatDirectorsModel.Director
    @Environment(\.dynamicTypeSize) private var typeSize

    /// The list's red dot: only a Director that asks (To read counts, as on every surface).
    static func hasDot(_ d: ChatDirectorsModel.Director) -> Bool { d.state.shown == .needs }

    var body: some View {
        HStack(spacing: 8) {
            ChatDirectorAvatar(director: director, side: 22)
            Text(verbatim: director.title)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
            Spacer(minLength: 4)
            if Self.hasDot(director) { ChatOrgNeedsDot() }
        }
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
        .padding(.leading, ChatDirectorFold.nameInset + 6)
        // The red dot lines up with a VP row's (12 + 8 from the edge).
        .padding(.trailing, 20)
        .contentShape(Rectangle())
    }
}

/// The sections layout: one Director as a first-level row the size of a VP's, its Org avatar a
/// little smaller than a VP's, "<VP> · <state>" under its title.
struct ChatDirectorSectionRow: View {
    let director: ChatDirectorsModel.Director
    @Environment(\.dynamicTypeSize) private var typeSize

    private var lines: Int { typeSize.isAccessibilitySize ? 3 : 1 }

    var body: some View {
        HStack(spacing: 10) {
            ChatDirectorAvatar(director: director, side: 28)
                // Centred where a VP's 34pt avatar is.
                .frame(width: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: director.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(lines)
                HStack(spacing: 5) {
                    ChatDirectorDot(state: director.state)
                    Text(verbatim: ChatDirectorsModel.sectionLine(director))
                        .font(.caption)
                        .foregroundStyle(director.state.shown == .needs ? UserStatePill.textColor(.needs) : .secondary)
                        .lineLimit(lines)
                }
            }
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
    }
}

/// A Director's Org avatar: the picture the server gives it (every Director wears one, as the CEO and
/// the VPs do: src/core/org/avatars/avatar-assign.ts), drawn by the same `OrgAvatar` as a VP row; until
/// it loads, a round mark in its VP's colour with its VP's initial.
struct ChatDirectorAvatar: View {
    let director: ChatDirectorsModel.Director
    let side: CGFloat

    var body: some View {
        OrgAvatar(taskId: director.id, side: side) {
            Text(verbatim: ChatDirectorsModel.vpInitial(director.vpName))
                .font(Theme.Glyph.sm.font(.semibold))
                .foregroundStyle(.white)
                .frame(width: side, height: side)
                .background(ChatOrgRowView.color(ChatOrgModel.avatarColor(director.vpName)).opacity(0.85), in: Circle())
        }
        .accessibilityHidden(true)
    }
}

struct ChatDirectorDot: View {
    let state: UserState

    var body: some View {
        Circle()
            .fill(UserStatePill.color(state.shown))
            .frame(width: 7, height: 7)
    }
}

/// A Director's long-press menu.
struct ChatDirectorMenu: View {
    let director: ChatDirectorsModel.Director
    let actions: ChatDirectorActions

    var body: some View {
        Button {
            actions.open(director)
        } label: {
            Label("Open Chat", systemImage: "bubble.left")
        }
        Divider()
        Button(role: .destructive) {
            actions.remove(director)
        } label: {
            Label("Remove from Directors", systemImage: "person.badge.minus")
        }
        .accessibilityIdentifier("chat.drawer.director.remove")
    }
}

/// The New Director sheet's question: a name, and which project when the VP leads several.
struct NewDirectorTarget: Identifiable, Equatable {
    /// The VP row it is asked from.
    let vpRowId: String
    let vpName: String
    /// The VP's projects, its own first; never empty.
    let projects: [String]
    var id: String { vpRowId }

    init?(row: ChatOrgModel.Row) {
        var seen = Set<String>()
        let projects = ([row.project] + row.ledProjects)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert(ChatOrgModel.projectKey($0)).inserted }
        guard row.kind == .vp, !projects.isEmpty else { return nil }
        vpRowId = row.id
        vpName = row.name
        self.projects = projects
    }

    /// The prompt's words, kept per VP while he is away (`PromptDraft`); also its mic surface.
    static let draftPrefix = "director-new:"
    var draftKey: String { Self.draftPrefix + vpRowId }
}

/// The New Director sheet: the app's dictated prompt with a project picker under it when needed.
struct NewDirectorPrompt: View {
    let target: NewDirectorTarget
    let onCancel: () -> Void
    let onConfirm: (_ title: String, _ project: String) -> Void
    @State private var project: String

    init(target: NewDirectorTarget, onCancel: @escaping () -> Void, onConfirm: @escaping (_ title: String, _ project: String) -> Void) {
        self.target = target
        self.onCancel = onCancel
        self.onConfirm = onConfirm
        _project = State(initialValue: target.projects[0])
    }

    var body: some View {
        DictatedTextPrompt(
            title: "New Director",
            message: "A new task in \(project), a Director under \(target.vpName). Its first message starts it.",
            placeholder: "Name", text: PromptDraft.binding(target.draftKey, prefix: NewDirectorTarget.draftPrefix),
            surface: target.draftKey, box: "director-new",
            confirmTitle: "Create", identifier: "chat.newDirector",
            accessory: target.projects.count > 1 ? AnyView(projectPicker) : nil,
            onCancel: onCancel,
            onConfirm: { onConfirm($0, project) }
        )
    }

    private var projectPicker: some View {
        Picker("Project", selection: $project) {
            ForEach(target.projects, id: \.self) { Text(verbatim: $0).tag($0) }
        }
        .accessibilityIdentifier("chat.newDirector.project")
    }
}
