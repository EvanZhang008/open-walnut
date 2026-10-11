import SwiftUI
import UIKit

/// Typed navigation targets inside the Settings stack.
enum SettingsRoute: Hashable {
    case routines
    case connectionRoutes
}

/// Settings tab — connection status card, server info (Wave 2 /v1/config),
/// routines management entry, pairing, disconnect, app version.
struct SettingsView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ChatStore.self) private var chat
    /// Read only to state the navigation bar's appearance (`toolbarColorScheme`).
    @Environment(\.colorScheme) private var colorScheme

    @State private var testing = false
    @State private var testResult: String?
    @State private var showDisconnectConfirm = false
    @State private var sendingDiagnostics = false
    @State private var diagnosticsResult: String?
    @AppStorage(VoiceRecorder.micRouteKey, store: AppPrefs.defaults) private var micRoute = VoiceRecorder.MicRoute.automatic.rawValue
    /// Default is `always` — "send them all", the behavior the user asked for.
    @AppStorage(PushRegistration.modeKey, store: AppPrefs.defaults) private var notificationMode = PushRegistration.Mode.always.rawValue
    @State private var push = PushRegistration.shared

    /// Wave-2 server info (GET /v1/config projection + chat stats). Best-effort:
    /// an old server without the endpoints just hides the block.
    @State private var serverInfo: ServerConfigInfo?
    @State private var chatStats: ChatStats?

    var body: some View {
        NavigationStack {
            List {
                DemoSettingsSection()
                serverSection
                serverInfoSection
                automationSection
                // The demo has no server: no notification registration, nothing to
                // upload diagnostics to, no connection to test and nothing to
                // disconnect from. Leave demo (in the Demo section) is its way out.
                if !inDemo {
                    notificationsSection
                }
                AppleHealthSettingsSection()
                PlacesSettingsSection()
                voiceSection
                if !inDemo {
                    diagnosticsSection
                    actionsSection
                }
                aboutSection
            }
            .navigationTitle("Settings")
            // iOS 26 draws no bar background, so section headers read through under
            // the title once scrolled, worst at AX5 (App Store gate, 2026-10-05): the
            // page runs up behind the bar, as the board's does (once the large title
            // has scrolled away, so "Settings" shows at rest), and the bar's colour
            // scheme is stated.
            .barPage(Color(uiColor: .systemGroupedBackground), largeTitle: true)
            .toolbarColorScheme(colorScheme, for: .navigationBar)
            .refreshable {
                await connection.refreshStatus()
                await loadServerInfo()
            }
            .task { await loadServerInfo() }
            // Re-read the iOS permission state every time Settings opens: the
            // user may have changed it in iOS Settings since, and a stale
            // "granted" would hide the one row that explains the silence.
            .task { await push.refreshAuthorization() }
            .navigationDestination(for: SettingsRoute.self) { route in
                switch route {
                case .routines: RoutinesView()
                case .connectionRoutes: ConnectionRoutesView()
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
                Text(Self.disconnectMessage)
            }
        }
    }

    /// What Disconnect does, said before it does it. The last sentence is the
    /// one limit: Disconnect asks the server to stop notifying this phone, and a
    /// server that cannot be reached at that moment never hears it. The app keeps
    /// no credential to try again later, by design, so revoking the phone on the
    /// server is what removes the registration.
    static let disconnectMessage = "Removes the server address and device token, and erases what Walnut keeps on this phone: drafts, unsent messages, downloaded images, voice recordings and logs. If the server can't be reached right now, it keeps this phone's notification registration until you revoke the phone in the Devices section of your Walnut console's Settings."

    /// The Address row's value. The demo is not a server, so its placeholder
    /// address is never shown as one.
    static func addressText(_ serverURL: String) -> String {
        if serverURL.isEmpty { return "Not configured" }
        return DemoMode.isDemoURL(serverURL) ? DemoMode.addressLabel : serverURL
    }

    /// The Token row: a paired server's device token, masked. The demo has no
    /// token (App Store gate, 2026-10-09: a masked row for a token that does not
    /// exist), so it shows none.
    static func showsTokenRow(serverURL: String) -> Bool {
        !DemoMode.isDemoURL(serverURL)
    }

    /// Paired with the demo: there is no server, so no server status or version.
    private var inDemo: Bool { DemoMode.isDemoURL(connection.serverURL) }

    private var serverSection: some View {
        Section("Server") {
            if connection.serverURL.isEmpty || DemoMode.isDemoURL(connection.serverURL) {
                LabeledContent("Address", value: Self.addressText(connection.serverURL))
            } else {
                NavigationLink(value: SettingsRoute.connectionRoutes) {
                    ConnectionRouteSummary()
                }
                .accessibilityIdentifier("settings.connectionRoute")
            }
            LabeledContent("Device", value: connection.deviceName.isEmpty ? "Not set" : connection.deviceName)
            if Self.showsTokenRow(serverURL: connection.serverURL) {
                LabeledContent("Token", value: "••••••••••••")
            }
            if inDemo {
                LabeledContent("Status", value: DemoMode.statusLabel)
                    .accessibilityIdentifier("settings.status")
            } else {
                LabeledContent("Status") {
                    StatusBadge()
                }
                .accessibilityIdentifier("settings.status")
            }
            if let status = connection.status, !inDemo {
                LabeledContent("Server version", value: "v\(status.version)")
                if let lastSync = status.lastSyncAt {
                    LabeledContent("Last sync", value: RelativeTime.short(lastSync))
                }
            }
        }
    }

    /// Server info block from GET /v1/config — provider/model/hosts, plus the
    /// Personal AI conversation size from GET /v1/chat/stats. Hidden entirely when
    /// the endpoint isn't there yet (older server).
    @ViewBuilder
    private var serverInfoSection: some View {
        if let serverInfo {
            Section(inDemo ? "Sample Setup" : "Server Info") {
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
                if let uptime = serverInfo.memory?.uptimeSec, !inDemo {
                    LabeledContent("Uptime", value: Self.uptimeText(uptime))
                }
                if let stats = chatStats, let count = stats.apiMessageCount {
                    LabeledContent("Personal AI chat") {
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

    /// Inbox letter notifications: the mode, plus an honest read on whether a
    /// notification could actually arrive right now.
    ///
    /// Both failure states are shown rather than left to silence, because "no
    /// notification arrived" has two very different causes the user can only act
    /// on if they're named: iOS permission was denied (fixable in Settings), or
    /// the server has no APNs key yet (fixable on the server).
    private var notificationsSection: some View {
        Section {
            Picker("Letter Notifications", selection: $notificationMode) {
                ForEach(PushRegistration.Mode.allCases) { mode in
                    Text(mode.label).tag(mode.rawValue)
                }
            }
            .accessibilityIdentifier("settings.notificationMode")
            .onChange(of: notificationMode) { _, raw in
                let mode = PushRegistration.Mode(rawValue: raw) ?? .always
                PushRegistration.shared.modeChanged(to: mode)
            }
            if push.authorization == .denied {
                Button("Open iOS Notification Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .accessibilityIdentifier("settings.notificationPermission")
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text(notificationsFooter)
        }
    }

    private var notificationsFooter: String {
        if push.authorization == .denied {
            return "Notifications are turned off for Walnut in iOS Settings, so no letter can reach you here."
        }
        if push.serverDeliverable == false {
            return "This phone is registered, but your Walnut server has no APNs key configured yet, so it can't send notifications. See docs/reference/ios-push-notifications.md."
        }
        let mode = PushRegistration.Mode(rawValue: notificationMode) ?? .always
        return mode.blurb
    }

    private var voiceSection: some View {
        Section {
            Picker("Microphone", selection: $micRoute) {
                Text("Automatic").tag(VoiceRecorder.MicRoute.automatic.rawValue)
                Text("iPhone Mic Only").tag(VoiceRecorder.MicRoute.builtInMic.rawValue)
            }
            .accessibilityIdentifier("settings.micRoute")
            // Not a control — a pointer. The Home-screen shortcut works (proven
            // end to end), but iOS puts it behind a long-press, which nothing in
            // the app ever mentions, so a user can own the feature for months
            // without meeting it. One static row next to the voice setting is
            // the whole fix: no nag, no modal, no onboarding step, and it sits
            // exactly where someone tuning voice input will look.
            Label {
                Text("Long-press the Walnut icon on your Home Screen and pick **Voice to Walnut** to start talking straight away.")
            } icon: {
                Image(systemName: "mic.badge.plus")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("settings.voiceQuickActionHint")
        } header: {
            Text("Voice Input")
        } footer: {
            Text(micRoute == VoiceRecorder.MicRoute.builtInMic.rawValue
                ? "Recording always uses the iPhone's built-in microphone, even when AirPods or a headset are connected."
                : "Recording follows the system's audio routing: AirPods or a headset mic are used when connected.")
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
            // Opens in Safari (see `PrivacyPolicy`), in the demo too.
            Link(destination: PrivacyPolicy.url) {
                Label(PrivacyPolicy.title, systemImage: "hand.raised")
            }
            .accessibilityIdentifier("settings.privacyPolicy")
        } header: {
            Text("About")
        } footer: {
            VStack(spacing: 4) {
                Text("Walnut \(Self.appVersion)")
                Text("Your Personal AI")
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
                ? "Nothing pending, already up to date."
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
                testResult = "Connected: \(status.mode.rawValue) · v\(status.version)"
            } else {
                testResult = "Could not reach the server"
            }
            testing = false
        }
    }
}
