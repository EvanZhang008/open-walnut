import SwiftUI

/// Folder row: SF Symbol folder + name + recursive note count + chevron.
struct FolderRow: View {
    let node: NoteTreeNode
    @Environment(NotesStore.self) private var notes

    var body: some View {
        NavigationLink(value: NotesRoute.folder(node.path)) {
            HStack(spacing: 12) {
                Image(systemName: "folder")
                    .foregroundStyle(Theme.tint)
                    .font(.body)
                Text(node.name)
                    .lineLimit(1)
                Spacer()
                Text("\(NotesStore.noteCount(in: node))")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
        }
    }
}

/// Note row — Apple Notes list cell: title, then date + grey preview line.
/// Swipe: pin/unpin (orange leading), delete (red trailing).
struct NoteRow: View {
    let node: NoteTreeNode
    var onDelete: () -> Void

    @Environment(NotesStore.self) private var notes

    private var title: String {
        node.name.replacingOccurrences(of: ".md", with: "")
    }

    var body: some View {
        NavigationLink(value: NotesRoute.note(node.path)) {
            NoteCellContent(path: node.path, title: title)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            PinSwipeButton(path: node.path)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive, action: onDelete) {
                Label("Delete", systemImage: "trash")
            }
            .tint(Theme.danger)
        }
    }
}

/// Pinned-section row — same cell, path may live anywhere in the vault.
struct PinnedNoteRow: View {
    let path: String
    var onDelete: () -> Void

    @Environment(NotesStore.self) private var notes

    private var title: String {
        (path.components(separatedBy: "/").last ?? path)
            .replacingOccurrences(of: ".md", with: "")
    }

    var body: some View {
        NavigationLink(value: NotesRoute.note(path)) {
            NoteCellContent(path: path, title: title)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            PinSwipeButton(path: path)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive, action: onDelete) {
                Label("Delete", systemImage: "trash")
            }
            .tint(Theme.danger)
        }
    }
}

/// Shared two-line cell body: title + (relative date · preview) second line.
/// Metadata loads lazily as the row appears.
struct NoteCellContent: View {
    let path: String
    let title: String

    @Environment(NotesStore.self) private var notes

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .fontWeight(.medium)
                .lineLimit(1)
            HStack(spacing: 6) {
                if let meta = notes.rowMeta[path] {
                    if let date = meta.updatedAt {
                        Text(Self.shortDate(date))
                            .foregroundStyle(.secondary)
                    }
                    Text(meta.preview.isEmpty ? "No additional text" : meta.preview)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                } else {
                    Text(" ") // reserve the line so rows don't jump when meta lands
                }
            }
            .font(.subheadline)
        }
        .task(id: path) {
            await notes.ensureRowMeta(for: path)
        }
    }

    static func shortDate(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if Calendar.current.isDateInYesterday(date) {
            return "Yesterday"
        }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

/// Orange pin/unpin swipe action with haptic.
struct PinSwipeButton: View {
    let path: String
    @Environment(NotesStore.self) private var notes

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            Task { await notes.togglePin(path) }
        } label: {
            Label(
                notes.isPinned(path) ? "Unpin" : "Pin",
                systemImage: notes.isPinned(path) ? "pin.slash.fill" : "pin.fill"
            )
        }
        .tint(.orange)
    }
}
