import SwiftUI

/// Server-side global search results (GET /v1/search — tasks/memory/sessions)
/// rendered as an extra List section under the local matches while the user
/// types in the Tasks search field. Debounced 350ms. On a cloud REPLICA the
/// endpoint answers 501 not_supported_cloud → a one-line degradation notice
/// (notes search elsewhere still works there).
struct GlobalSearchSection: View {
    let query: String
    /// Open a task hit (the parent resolves the id against its store).
    var onOpenTask: (String) -> Void

    @State private var results: [GlobalSearchResult] = []
    @State private var searching = false
    /// Non-nil = show the degraded/unavailable line instead of results.
    @State private var unavailableNotice: String?
    @State private var debounceTask: Task<Void, Never>?
    @State private var searchedQuery = ""

    private let api = WalnutAPI()

    var body: some View {
        Section {
            if let unavailableNotice {
                Label(unavailableNotice, systemImage: "icloud.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if searching && results.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Searching server…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if results.isEmpty && searchedQuery == query {
                Text("No server-side matches.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(results) { result in
                    resultRow(result)
                }
            }
        } header: {
            Text("Server Search")
        }
        .onChange(of: query, initial: true) { _, newQuery in
            schedule(newQuery)
        }
        .onDisappear { debounceTask?.cancel() }
    }

    @ViewBuilder
    private func resultRow(_ result: GlobalSearchResult) -> some View {
        let row = VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: Self.icon(for: result.type))
                    .font(.caption)
                    .foregroundStyle(Self.color(for: result.type))
                Text(result.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            }
            if let snippet = result.snippet, !snippet.isEmpty {
                Text(snippet)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 2)

        if result.type == "task", let id = result.resultId {
            Button { onOpenTask(id) } label: { row }
                .buttonStyle(.plain)
                .accessibilityIdentifier("search.result.\(id)")
        } else {
            // Memory/session hits have no dedicated phone surface yet —
            // render read-only (title + snippet carries the answer).
            row
        }
    }

    private func schedule(_ newQuery: String) {
        debounceTask?.cancel()
        let trimmed = newQuery.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else {
            results = []
            searchedQuery = ""
            return
        }
        debounceTask = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            searching = true
            defer { searching = false }
            do {
                let hits = try await api.globalSearch(query: trimmed, limit: 15)
                guard !Task.isCancelled else { return }
                results = hits
                searchedQuery = newQuery
                unavailableNotice = nil
            } catch let error as APIError where error.isNotSupportedCloud {
                unavailableNotice = "Global search needs your Mac online — notes search still works."
            } catch let error as APIError where error.isCancelled {
                return
            } catch {
                // Old server (404) or transient failure — hide quietly; local
                // search results above still work.
                results = []
                searchedQuery = newQuery
            }
        }
    }

    static func icon(for type: String) -> String {
        switch type {
        case "task": return "checkmark.circle"
        case "session": return "terminal"
        case "memory": return "brain"
        default: return "doc.text.magnifyingglass"
        }
    }

    static func color(for type: String) -> Color {
        switch type {
        case "task": return Theme.tint
        case "session": return .indigo
        case "memory": return .purple
        default: return .secondary
        }
    }
}
