import SwiftUI

/// Settings tab — connection status card, pairing, disconnect, app version.
struct SettingsView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ChatStore.self) private var chat

    @State private var testing = false
    @State private var testResult: String?
    @State private var showDisconnectConfirm = false
    @State private var sendingDiagnostics = false
    @State private var diagnosticsResult: String?
    @AppStorage(VoiceRecorder.micRouteKey) private var micRoute = VoiceRecorder.MicRoute.automatic.rawValue

    var body: some View {
        NavigationStack {
            List {
                serverSection
                voiceSection
                diagnosticsSection
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

    private var voiceSection: some View {
        Section {
            Picker("Microphone", selection: $micRoute) {
                Text("Automatic").tag(VoiceRecorder.MicRoute.automatic.rawValue)
                Text("iPhone Mic Only").tag(VoiceRecorder.MicRoute.builtInMic.rawValue)
            }
            .accessibilityIdentifier("settings.micRoute")
        } header: {
            Text("Voice Input")
        } footer: {
            Text(micRoute == VoiceRecorder.MicRoute.builtInMic.rawValue
                ? "Recording always uses the iPhone's built-in microphone, even when AirPods or a headset are connected."
                : "Recording follows the system's audio routing — AirPods or a headset mic are used when connected.")
        }
    }

    /// Manual lever for the moment the user says "it just happened". The app
    /// uploads on its own every 45s, but a user who watched something go wrong
    /// wants it off the device NOW — and a visible pending-bytes number is also
    /// the only way to tell "nothing was captured" from "capture worked, upload
    /// is stuck".
    private var diagnosticsSection: some View {
        Section {
            Button {
                sendDiagnostics()
            } label: {
                HStack {
                    Label(sendingDiagnostics ? "Sending…" : "Send Diagnostics Now",
                          systemImage: "arrow.up.doc")
                    Spacer()
                    if sendingDiagnostics { ProgressView() }
                }
            }
            .disabled(sendingDiagnostics)
            .accessibilityIdentifier("settings.sendDiagnostics")
            if let diagnosticsResult {
                Text(diagnosticsResult)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("settings.diagnosticsResult")
            }
        } header: {
            Text("Diagnostics")
        } footer: {
            Text("Walnut records what the app does (screens, sends, streams, errors) and uploads it to your own server so problems can be diagnosed without asking you to reproduce them. Nothing leaves this phone except to the server you paired with.")
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

    private func sendDiagnostics() {
        sendingDiagnostics = true
        diagnosticsResult = nil
        // Mark the moment in the log itself: a user tapping this is a strong
        // signal that whatever they just saw is the thing worth looking at.
        Breadcrumbs.note("diagnostics-requested")
        AppLog.warn("diagnostics", "user requested a diagnostics upload")
        Task {
            let outcome = await AppLog.shared.sendDiagnosticsNow()
            diagnosticsResult = Self.describe(outcome)
            sendingDiagnostics = false
        }
    }

    /// Honest about the three outcomes: nothing to send, sent everything, or
    /// sent some and the rest is still queued (offline / server down).
    private static func describe(_ outcome: (uploaded: Int, drained: Bool)) -> String {
        if outcome.uploaded == 0 {
            return outcome.drained
                ? "Nothing pending — already up to date."
                : "Could not reach the server. Logs are saved and will upload automatically."
        }
        let lines = "\(outcome.uploaded) line\(outcome.uploaded == 1 ? "" : "s")"
        return outcome.drained
            ? "Sent \(lines)."
            : "Sent \(lines); more still queued and will retry."
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
