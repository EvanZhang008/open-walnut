import SwiftUI

/// Settings › Org: how the Chat drawer shows Directors, the org's own settings (`PUT
/// /api/v1/org/settings`), so the web reads the same choice. Only while Directors are on.
struct DirectorsSettingsSection: View {
    @State private var store = DirectorsSettingsStore.shared
    @State private var failure: String?

    var body: some View {
        if store.value.enabled {
            Section {
                ForEach(DirectorsSettings.Layout.allCases) { layout in
                    Button {
                        guard layout != store.value.layout else { return }
                        write { try await store.update(layout: layout) }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(layout.label)
                                    .foregroundStyle(.primary)
                                Text(layout.detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            if layout == store.value.layout {
                                Image(systemName: "checkmark")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Theme.tint)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(layout == store.value.layout ? .isSelected : [])
                    .accessibilityIdentifier("settings.directors.layout.\(layout.rawValue)")
                }
                Toggle(isOn: Binding(
                    get: { store.value.showProjects },
                    set: { on in write { try await store.update(showProjects: on) } }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Show project names")
                        Text("Group each VP's Directors under small project headings.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("settings.directors.showProjects")
            } header: {
                Text("Org")
            } footer: {
                if let failure {
                    Text(verbatim: failure).foregroundStyle(Theme.danger)
                } else {
                    Text("How the Chat drawer shows the Directors under each VP.")
                }
            }
            .accessibilityIdentifier("settings.directors")
        }
    }

    private func write(_ change: @escaping () async throws -> Void) {
        failure = nil
        Task {
            do {
                try await change()
            } catch {
                failure = Self.failureText(error)
            }
        }
    }

    /// A companion answers 501: the org's settings change on the Mac.
    static func failureText(_ error: Error) -> String {
        if case .server(let status, _, _, _, _)? = error as? APIError, status == 501 {
            return "The org's settings change on your Mac: connect to it directly and try again."
        }
        return "Couldn't save: \(error.localizedDescription)"
    }
}
