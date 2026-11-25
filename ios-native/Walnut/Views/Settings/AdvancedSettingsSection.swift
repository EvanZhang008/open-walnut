import SwiftUI

/// Settings › Advanced: the developer switch "Show lines Walnut hides" (`ui.show_hidden_lines`,
/// the web's Settings › Advanced row). On, a reply that had lines hidden (its status lines) shows
/// them as one closed "Hidden by Walnut" row under it. The server resolves the value: unset, it is
/// on where Walnut runs from its own source checkout (a developer) and off everywhere else.
struct AdvancedSettingsSection: View {
    @State private var settings: ServerClientSettings
    @State private var failure: String?

    init(settings: ServerClientSettings = .shared) {
        _settings = State(initialValue: settings)
    }

    var body: some View {
        Section {
            Toggle(isOn: Binding(
                get: { settings.showHiddenLines },
                set: { on in write(on) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Show lines Walnut hides")
                    Text("Folded under each reply in a session chat.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("settings.showHiddenLines")
        } header: {
            Text("Advanced")
        } footer: {
            if let failure {
                Text(verbatim: failure).foregroundStyle(Theme.danger)
            } else {
                Text("On by default when Walnut runs from its source code.")
            }
        }
        .task { await settings.refreshIfStale() }
    }

    private func write(_ on: Bool) {
        failure = nil
        Task {
            do {
                try await settings.setShowHiddenLines(on)
            } catch {
                failure = "Couldn't save: \(error.localizedDescription)"
            }
        }
    }
}
