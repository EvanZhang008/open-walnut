import SwiftUI

/// Search results overlay for the Notes home — as-you-type (300ms debounce)
/// against /api/notes-v2/search; `<mark>` ranges get a walnut tint highlight.
struct NoteSearchView: View {
    let query: String
    var onOpen: (String) -> Void

    @Environment(NotesStore.self) private var notes

    @State private var results: [NoteSearchResult] = []
    @State private var searching = false
    @State private var searchedQuery = ""
    @State private var debounceTask: Task<Void, Never>?

    var body: some View {
        List {
            if searching && results.isEmpty {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Searching…")
                        .foregroundStyle(.secondary)
                }
            } else if results.isEmpty && searchedQuery == query {
                ContentUnavailableView.search(text: query)
                    .listRowBackground(Color.clear)
            }
            ForEach(results) { result in
                Button {
                    onOpen(result.path)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(result.title)
                            .fontWeight(.medium)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        if !result.snippet.isEmpty {
                            Text(Self.highlighted(result.snippet))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Text(result.path.replacingOccurrences(of: ".md", with: ""))
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .listStyle(.insetGrouped)
        .background(Color(.systemGroupedBackground))
        .onChange(of: query, initial: true) { _, newQuery in
            debounceTask?.cancel()
            let trimmed = newQuery.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else {
                results = []
                searchedQuery = ""
                return
            }
            debounceTask = Task {
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                searching = true
                let hits = await notes.search(query: trimmed)
                guard !Task.isCancelled else { return }
                results = hits
                searchedQuery = newQuery
                searching = false
            }
        }
    }

    /// Convert a snippet with `<mark>` tags into an AttributedString with a
    /// walnut-tint highlight on the marked ranges.
    static func highlighted(_ snippet: String) -> AttributedString {
        var output = AttributedString()
        var rest = Substring(snippet)
        while let open = rest.range(of: "<mark>") {
            output += AttributedString(String(rest[..<open.lowerBound]))
            rest = rest[open.upperBound...]
            let closeRange = rest.range(of: "</mark>")
            let marked = closeRange.map { rest[..<$0.lowerBound] } ?? rest
            var highlighted = AttributedString(String(marked))
            highlighted.backgroundColor = Theme.tint.opacity(0.28)
            highlighted.foregroundColor = .primary
            output += highlighted
            if let closeRange {
                rest = rest[closeRange.upperBound...]
            } else {
                rest = Substring("")
            }
        }
        output += AttributedString(String(rest))
        return output
    }
}
