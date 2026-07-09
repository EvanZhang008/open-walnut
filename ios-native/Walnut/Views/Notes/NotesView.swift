import SwiftUI

/// Notes tab — folder tree as an expandable indented list (folders first),
/// pull-to-refresh, create note (+), swipe-to-delete with confirm.
struct NotesView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(NotesStore.self) private var notes

    @State private var expanded: Set<String> = []
    @State private var showCreate = false
    @State private var newNotePath = ""
    @State private var deleteCandidate: String?
    @State private var navigateTo: String?

    /// Flattened visible rows honoring expansion state; attachments hidden.
    private var rows: [(node: NoteTreeNode, depth: Int)] {
        flatten(sorted(notes.tree), depth: 0)
    }

    var body: some View {
        NavigationStack {
            Group {
                if rows.isEmpty && !notes.loadingTree {
                    ContentUnavailableView(
                        "No notes yet",
                        systemImage: "doc.text",
                        description: Text("Tap + to write your first note.")
                    )
                } else {
                    list
                }
            }
            .navigationTitle("Notes")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        newNotePath = ""
                        showCreate = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .accessibilityIdentifier("notes.create")
                }
            }
            .navigationDestination(item: $navigateTo) { path in
                NoteEditorView(path: path)
            }
            .alert("New Note", isPresented: $showCreate) {
                TextField("Name (use / for folders)", text: $newNotePath)
                    .autocorrectionDisabled()
                Button("Create") { createNote() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("e.g. Ideas/Trip")
            }
            .alert(
                "Delete Note",
                isPresented: .init(
                    get: { deleteCandidate != nil },
                    set: { if !$0 { deleteCandidate = nil } }
                )
            ) {
                Button("Delete", role: .destructive) {
                    if let path = deleteCandidate {
                        Task { await notes.remove(path: path) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Delete \"\(deleteCandidate ?? "")\"? Git history keeps a copy.")
            }
        }
    }

    private var list: some View {
        List {
            if !connection.online {
                OfflineBanner(text: "Offline — notes are read-only from cache")
                    .listRowInsets(EdgeInsets())
            }
            ForEach(rows, id: \.node.path) { row in
                if row.node.type == .folder {
                    folderRow(row.node, depth: row.depth)
                } else {
                    noteRow(row.node, depth: row.depth)
                }
            }
        }
        .listStyle(.plain)
        .redacted(reason: notes.loadingTree && notes.tree.isEmpty ? .placeholder : [])
        .refreshable {
            await notes.refreshTree()
        }
    }

    private func folderRow(_ node: NoteTreeNode, depth: Int) -> some View {
        Button {
            withAnimation(.snappy(duration: 0.2)) {
                if expanded.contains(node.path) {
                    expanded.remove(node.path)
                } else {
                    expanded.insert(node.path)
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(expanded.contains(node.path) ? 90 : 0))
                Image(systemName: expanded.contains(node.path) ? "folder.fill" : "folder")
                    .foregroundStyle(Theme.tint)
                Text(node.name)
                    .fontWeight(.medium)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.leading, CGFloat(depth) * 20)
        }
        .foregroundStyle(.primary)
    }

    private func noteRow(_ node: NoteTreeNode, depth: Int) -> some View {
        Button {
            navigateTo = node.path
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "doc.text")
                    .foregroundStyle(.secondary)
                Text(node.name.replacingOccurrences(of: ".md", with: ""))
                    .lineLimit(1)
                Spacer()
            }
            .padding(.leading, CGFloat(depth) * 20 + 18)
        }
        .foregroundStyle(.primary)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                deleteCandidate = node.path
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func createNote() {
        var path = newNotePath.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.lowercased().hasSuffix(".md") { path = String(path.dropLast(3)) }
        guard !path.isEmpty else { return }
        Task {
            if await notes.create(path: path) {
                navigateTo = path
            }
        }
    }

    // MARK: - Tree helpers

    /// Folders first, then files, both alphabetical (matches the web UI).
    private func sorted(_ nodes: [NoteTreeNode]) -> [NoteTreeNode] {
        nodes.sorted { a, b in
            if a.type != b.type { return a.type == .folder }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    private func flatten(_ nodes: [NoteTreeNode], depth: Int) -> [(node: NoteTreeNode, depth: Int)] {
        var result: [(NoteTreeNode, Int)] = []
        for node in nodes {
            if node.type == .file && node.isAttachment { continue }
            result.append((node, depth))
            if node.type == .folder, expanded.contains(node.path), let children = node.children {
                result.append(contentsOf: flatten(sorted(children), depth: depth + 1))
            }
        }
        return result
    }
}
