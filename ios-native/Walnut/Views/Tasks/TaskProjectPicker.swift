import SwiftUI

/// Pick (or create) the project a task is filed under.
///
/// Replaces the detail sheet's inline text field, which required knowing the
/// project's exact spelling and offered no list at all. Creating is kept because
/// the old field could do it: an unknown name auto-creates the registry row
/// server-side, so the search text doubles as the new-project name.
struct TaskProjectPicker: View {
    /// "" = Inbox.
    let current: String
    let onPick: (String) -> Void

    @Environment(TasksStore.self) private var tasks
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            // A vault has dozens of projects and the list is alphabetical, so the
            // current one is usually off screen. Scrolled to on appear: opening a
            // picker that does not show what is selected is the same "where am I"
            // problem the chips had.
            ScrollViewReader { scroll in
                List {
                    Section {
                        row(name: "", label: NewTaskSeed.inboxHeader, icon: "tray")
                    }
                    Section {
                        ForEach(matches, id: \.self) { name in
                            row(name: name, label: name, icon: "folder")
                        }
                        if let newName {
                            Button {
                                pick(newName)
                            } label: {
                                Label("Create \"\(newName)\"", systemImage: "plus.circle")
                                    .font(.body)
                                    .foregroundStyle(Theme.tint)
                            }
                            .accessibilityIdentifier("task.project.create")
                        }
                    } header: {
                        Text(matches.isEmpty && newName == nil ? "No projects yet" : "Projects")
                    }
                }
                .onAppear {
                    guard !current.isEmpty else { return }
                    scroll.scrollTo(current, anchor: .center)
                }
            }
            .searchable(text: $query, prompt: "Search or new project name")
            .navigationTitle("Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .accessibilityIdentifier("task.project.picker")
    }

    private func row(name: String, label: String, icon: String) -> some View {
        Button {
            pick(name)
        } label: {
            HStack {
                Image(systemName: icon)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(label)
                    .font(.body)
                    .foregroundStyle(name == current ? Theme.tint : .primary)
                    .lineLimit(1)
                Spacer()
                if name == current {
                    Image(systemName: "checkmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.tint)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func pick(_ name: String) {
        onPick(name)
        dismiss()
    }

    /// Every project the phone knows about. Tasks name the ones in the loaded
    /// projection; folders name the rest, including projects whose tasks are all
    /// out of the current window (an empty project is still a place to file to).
    /// The task's own project is always included so the checkmark has a row.
    private var projectNames: [String] {
        var seen = Set<String>()
        for task in tasks.tasks where !task.project.isEmpty { seen.insert(task.project) }
        for folder in tasks.taskFolders where !folder.project.isEmpty { seen.insert(folder.project) }
        if !current.isEmpty { seen.insert(current) }
        return seen.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    private var matches: [String] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return projectNames }
        return projectNames.filter { $0.localizedCaseInsensitiveContains(trimmed) }
    }

    /// The search text as a NEW project name, when it is not already one.
    private var newName: String? {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty,
              !projectNames.contains(where: { $0.localizedCaseInsensitiveCompare(trimmed) == .orderedSame }),
              trimmed.localizedCaseInsensitiveCompare(NewTaskSeed.inboxHeader) != .orderedSame
        else { return nil }
        return trimmed
    }
}
