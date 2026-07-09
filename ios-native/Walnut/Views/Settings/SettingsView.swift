import SwiftUI

/// Settings tab — connection status card, pairing, disconnect, app version.
struct SettingsView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ChatStore.self) private var chat

    @State private var testing = false
    @State private var testResult: String?
    @State private var showDisconnectConfirm = false

    var body: some View {
        NavigationStack {
            List {
                serverSection
                actionsSection
                aboutSection
            }
            .navigationTitle("Settings")
            .refreshable {
                await connection.refreshStatus()
            }
            .confirmationDialog(
                "Disconnect from this server?",
                isPresented: $showDisconnectConfirm,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    chat.closeStream()
                    connection.disconnect()
                }
            } message: {
                Text("Removes the server URL and device token from this phone.")
            }
        }
    }

    private var serverSection: some View {
        Section("Server") {
            LabeledContent("Address", value: connection.serverURL.isEmpty ? "Not configured" : connection.serverURL)
            LabeledContent("Device", value: connection.deviceName.isEmpty ? "—" : connection.deviceName)
            LabeledContent("Token", value: "••••••••••••")
            LabeledContent("Status") {
                StatusBadge()
            }
            if let status = connection.status {
                LabeledContent("Server version", value: "v\(status.version)")
                if let lastSync = status.lastSyncAt {
                    LabeledContent("Last sync", value: ConversationListView.relativeTime(lastSync))
                }
            }
        }
    }

    private var actionsSection: some View {
        Section {
            Button {
                testConnection()
            } label: {
                HStack {
                    Label(testing ? "Testing…" : "Test Connection", systemImage: "waveform.path.ecg")
                    Spacer()
                    if testing { ProgressView() }
                }
            }
            .disabled(testing)
            if let testResult {
                Text(testResult)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Button(role: .destructive) {
                showDisconnectConfirm = true
            } label: {
                Label("Disconnect", systemImage: "rectangle.portrait.and.arrow.right")
                    .foregroundStyle(Theme.danger)
            }
            .accessibilityIdentifier("settings.disconnect")
        }
    }

    private var aboutSection: some View {
        Section {
            EmptyView()
        } footer: {
            VStack(spacing: 4) {
                Text("Walnut \(Self.appVersion)")
                Text("Your personal AI butler")
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 12)
        }
    }

    private static var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        return "v\(version)"
    }

    private func testConnection() {
        testing = true
        testResult = nil
        Task {
            await connection.refreshStatus()
            if let status = connection.status, connection.online {
                testResult = "Connected — \(status.mode.rawValue) · v\(status.version)"
            } else {
                testResult = "Could not reach the server"
            }
            testing = false
        }
    }
}
