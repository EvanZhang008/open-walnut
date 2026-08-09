import SwiftUI

/// Typed navigation targets inside the Settings stack.
enum SettingsRoute: Hashable {
    case routines
}

/// Settings tab — connection status card, server info (Wave 2 /v1/config),
/// routines management entry, pairing, disconnect, app version.
struct SettingsView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ChatStore.self) private var chat

    @State private var testing = false
    @State private var testResult: String?
    @State private var showDisconnectConfirm = false
    @State private var sendingDiagnostics = false
    @State private var diagnosticsResult: String?
    @AppStorage(VoiceRecorder.micRouteKey) private var micRoute = VoiceRecorder.MicRoute.automatic.rawValue

    /// Wave-2 server info (GET /v1/config projection + chat stats). Best-effort:
    /// an old server without the endpoints just hides the block.
    @State private var serverInfo: ServerConfigInfo?
    @State private var chatStats: ChatStats?

    var body: some View {
        NavigationStack {
            List {
                serverSection
                serverInfoSection
                automationSection
                voiceSection
                diagnosticsSection
                actionsSection
                aboutSection
            }
            .navigationTitle("Settings")
            .refreshable {
                await connection.refreshStatus()
                await loadServerInfo()
            }
            .task { await loadServerInfo() }
            .navigationDestination(for: SettingsRoute.self) { route in
                switch route {
                case .routines: RoutinesView()
                }
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

    /// Server info block from GET /v1/config — provider/model/hosts, plus the
    /// butler conversation size from GET /v1/chat/stats. Hidden entirely when
    /// the endpoint isn't there yet (older server).
    @ViewBuilder
    private var serverInfoSection: some View {
        if let serverInfo {
            Section("Server Info") {
                if let provider = serverInfo.config.provider?.type {
                    LabeledContent("Provider", value: providerLine(provider))
                }
                if let model = serverInfo.config.agent?.mainModel ?? serverInfo.config.provider?.model {
                    LabeledContent("Model", value: WalnutSession.shortModelName(model))
                }
                let hosts = serverInfo.enabledHostLabels
                if !hosts.isEmpty {
                    LabeledContent("Hosts", value: hosts.joined(separator: ", "))
                }
                if serverInfo.cloud == true {
                    LabeledContent("Mode", value: "Cloud companion")
                }
                if let uptime = serverInfo.memory?.uptimeSec {
                    LabeledContent("Uptime", value: Self.uptimeText(uptime))
                }
                if let stats = chatStats, let count = stats.apiMessageCount {
                    LabeledContent("Butler chat") {
                        Text(chatStatsLine(stats, count: count))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .accessibilityIdentifier("settings.serverInfo")
        }
    }

    private var automationSection: some View {
        Section("Automation") {
            NavigationLink(value: SettingsRoute.routines) {
                Label("Routines", systemImage: "calendar.badge.clock")
            }
            .accessibilityIdentifier("settings.routines")
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

    // MARK: - Server info helpers

    private func loadServerInfo() async {
        // Best-effort, independently: chat stats failing must not hide config.
        if let info = try? await WalnutAPI().serverConfig() {
            serverInfo = info
        }
        if let stats = try? await WalnutAPI().chatStats() {
            chatStats = stats
        }
    }

    private func providerLine(_ type: String) -> String {
        var line = type.capitalized
        if let region = serverInfo?.config.provider?.bedrockRegion {
            line += " · \(region)"
        }
        return line
    }

    private func chatStatsLine(_ stats: ChatStats, count: Int) -> String {
        var line = "\(count) messages"
        if let percent = stats.contextPercent {
            line += " · \(percent)% of context"
        }
        return line
    }

    static func uptimeText(_ seconds: Int) -> String {
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h \((seconds % 3600) / 60)m" }
        return "\(seconds / 86_400)d \((seconds % 86_400) / 3600)h"
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
