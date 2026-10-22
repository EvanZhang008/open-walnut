import SwiftUI

struct InboxItemTaskSelector: View {
    let key: InboxItemStore.Key
    let item: InboxEmailItem
    let actionId: String
    var onOpenTask: (String, String?) -> Void
    var onContinue: (InboxTaskCandidate) -> Void
    private let store = InboxItemStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var page: InboxTaskPage?
    @State private var candidates: [InboxTaskCandidate] = []
    @State private var loading = false
    @State private var error: String?
    @State private var preview: InboxTaskCandidate?
    @State private var openedTask: InboxTaskDestination?
    @State private var searchGeneration = 0
    @FocusState private var searchFocused: Bool
    @State private var acceptingInput = true
    private var footer: some View {
        let enabled = !loading && error == nil && store.draft(key).selected?.canAttach == true
        return VStack(alignment: .leading, spacing: 6) {
            if let selected = store.draft(key).selected {
                Text("Selected task: \(InboxEmailItem.safe(selected.title))").font(.body)
                Text("\(selected.projectLabel) · \(selected.phaseLabel)").font(.caption)
                if !selected.canAttach {
                    Text("This task is completed. Open it to review or choose an open task.").font(.caption)
                    Button("Open task") { openedTask = InboxTaskDestination(id: selected.id, title: selected.title) }.frame(minHeight: 44)
                    Button("Choose another task") {
                        var draft = store.draft(key); draft.selected = nil; draft.input.selectedTaskId = nil
                        store.setDraft(draft, key: key)
                    }.frame(minHeight: 44)
                }
            }
            Button("Continue") {
                if let selected = store.draft(key).selected, selected.canAttach {
                    acceptingInput = false; searchFocused = false; onContinue(selected)
                }
            }.buttonStyle(InboxItemPrimaryButtonStyle()).frame(minHeight: 44)
                .disabled(!enabled)
                .accessibilityIdentifier("inbox.item.tasks.continue")
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.bar)
    }
    private func load(offset: Int = 0) async {
        searchGeneration += 1; let generation = searchGeneration; let askedQuery = query.wrappedValue
        loading = true; error = nil
        if offset == 0 { candidates = [] }
        do {
            let response = try await store.taskPage(key, query: askedQuery, offset: offset)
            guard generation == searchGeneration, query.wrappedValue == askedQuery, !Task.isCancelled else { return }
            page = response; candidates = offset == 0 ? response.tasks : candidates + response.tasks
            loading = false
        } catch {
            guard generation == searchGeneration, query.wrappedValue == askedQuery, !Task.isCancelled else { return }
            self.error = "Could not load tasks"; loading = false
        }
    }
    private var query: Binding<String> {
        Binding(get: { store.draft(key).query }, set: { value in
            guard acceptingInput else { return }
            store.setTaskQuery(value, key: key, actionId: actionId)
        })
    }
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 8) {
                Text("Search tasks").font(.caption)
                TextField("Search by title, project, or full task ID", text: query)
                    .textFieldStyle(.roundedBorder).focused($searchFocused)
                    .accessibilityIdentifier("inbox.item.tasks.search")
                if loading { Text("Loading tasks…").font(.caption) }
                if let error {
                    Text(error).font(.caption)
                    Button("Try again") { Task { await load() } }.frame(minHeight: 44)
                }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(candidates) { candidate in
                                VStack(alignment: .leading, spacing: 4) {
                                    Button {
                                        var draft = store.draft(key); draft.selected = candidate
                                        draft.input.selectedTaskId = candidate.id; draft.listAnchor = candidate.id
                                        store.setDraft(draft, key: key)
                                    } label: {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(InboxEmailItem.safe(candidate.title)).font(.body)
                                            Text("\(candidate.projectLabel) · \(candidate.phaseLabel)").font(.caption)
                                            Text(store.draft(key).selected?.id == candidate.id ? "Selected task" : "Select task").font(.caption)
                                        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                    }.buttonStyle(.bordered).accessibilityIdentifier("inbox.item.tasks.select.\(candidate.id)")
                                    Button("Preview task") {
                                        var draft = store.draft(key); draft.listAnchor = candidate.id
                                        store.setDraft(draft, key: key); preview = candidate
                                    }.frame(minHeight: 44).accessibilityIdentifier("inbox.item.tasks.preview.\(candidate.id)")
                                    DisclosureGroup("Task ID") { Text(candidate.id).textSelection(.enabled) }.font(.caption)
                                }.id(candidate.id)
                            }
                            if !loading && error == nil && candidates.isEmpty {
                                Text("No matching tasks"); Text("Try another search").font(.caption)
                            }
                            if let page, page.hasMore {
                                Button("Load more") { Task { await load(offset: candidates.count) } }.frame(minHeight: 44).disabled(loading)
                                Text("Showing \(candidates.count) of \(page.total). Refine your search.").font(.caption)
                            }
                        }.padding(.bottom, 12)
                    }.onChange(of: candidates) { _, _ in
                        if let anchor = store.draft(key).listAnchor { proxy.scrollTo(anchor, anchor: .top) }
                    }
                }
            }.padding(16)
            .navigationTitle("Choose a task").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .safeAreaInset(edge: .bottom) { footer }
            .task(id: query.wrappedValue) {
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                await load()
            }
            .onAppear { acceptingInput = true; searchFocused = true }
            .onDisappear { acceptingInput = false }
            .sheet(item: $openedTask) { destination in InboxItemReadOnlyTaskSheet(key: key, destination: destination).presentationDetents([.large]) }
            .navigationDestination(item: $preview) { candidate in
                InboxItemTaskPreview(key: key, candidate: candidate, onOpenTask: onOpenTask)
            }
        }
    }
}
