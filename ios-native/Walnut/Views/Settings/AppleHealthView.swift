import SwiftUI
import UIKit

/// The Settings row that leads to the Apple Health screen.
struct AppleHealthSettingsSection: View {
    @State private var store = HealthSyncStore.shared

    var body: some View {
        Section {
            NavigationLink {
                AppleHealthView()
            } label: {
                LabeledContent {
                    Text(rowValue)
                } label: {
                    Label("Apple Health", systemImage: "heart.text.square")
                }
            }
            .accessibilityIdentifier("settings.appleHealth")
        } header: {
            Text("Apple Health")
        }
    }

    private var rowValue: String {
        guard store.isEnabled else { return "Off" }
        return store.macPaused == true ? "Paused" : "On"
    }
}

/// Apple Health: what Walnut reads, whether the Mac is current, and the controls.
struct AppleHealthView: View {
    @State private var store = HealthSyncStore.shared
    @State private var confirmDelete = false

    var body: some View {
        List {
            if store.isEnabled {
                syncSection
                controlsSection
                deleteSection
            } else {
                offSection
            }
        }
        .navigationTitle("Apple Health")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.refresh() }
        .refreshable { await store.refresh() }
    }

    // MARK: - Off

    private var offSection: some View {
        Section {
            Text("Walnut on this iPhone reads the Apple Health data you allow and keeps your Mac up to date, so your AI can use your sleep, heart, activity and everything else you allow. It goes only to your Mac, and from there to the AI provider your Mac uses.")
                .accessibilityIdentifier("health.explanation")
            Button {
                Task { await store.turnOn() }
            } label: {
                HStack {
                    Text(store.busy == .turningOn ? "Turning On…" : "Turn On Apple Health")
                    Spacer()
                    if store.busy == .turningOn { ProgressView() }
                }
            }
            .disabled(store.busy != nil)
            .accessibilityIdentifier("health.turnOn")
            if let message = store.errorMessage {
                Text(message).font(.footnote).foregroundStyle(.red)
            }
        } footer: {
            Text("You pick what Walnut may read on the next screen. You can pause, or delete the copy on your Mac, at any time.")
        }
    }

    // MARK: - On

    private var syncSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(primaryLine)
                    .accessibilityIdentifier("health.syncStatus")
                if showsHistoryProgress {
                    ProgressView(value: Double(store.progress.typesDone), total: Double(max(store.progress.typesTotal, 1)))
                        .accessibilityIdentifier("health.historyProgress")
                }
            }
            if let from = store.macDataFrom {
                LabeledContent("Mac has data from", value: from.formatted(date: .abbreviated, time: .omitted))
                    .accessibilityIdentifier("health.macCoverage")
            }
            ForEach(Array(statusLines.enumerated()), id: \.offset) { _, line in
                Label(line, systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let message = store.errorMessage {
                Text(message).font(.footnote).foregroundStyle(.red)
            }
            Button {
                store.syncNow()
            } label: {
                HStack {
                    Text("Sync Now")
                    Spacer()
                    if store.progress.running { ProgressView() }
                }
            }
            .disabled(store.progress.running || store.macPaused == true)
            .accessibilityIdentifier("health.syncNow")
        } header: {
            Text("Sync")
        } footer: {
            Text("Walnut keeps your Mac up to date by itself, in the background too.")
        }
    }

    private var controlsSection: some View {
        Section {
            Toggle("Pause", isOn: Binding(
                get: { store.macPaused == true },
                set: { paused in Task { await store.setPaused(paused) } }
            ))
            .disabled(store.busy != nil)
            .accessibilityIdentifier("health.pause")
            Button("Health Permissions") {
                Task { await store.openHealthPermissions() }
            }
            .accessibilityIdentifier("health.permissions")
        } footer: {
            Text("To change what Walnut may read, go to Settings, then Privacy & Security, then Health, then Walnut.")
        }
    }

    private var deleteSection: some View {
        Section {
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                HStack {
                    Text(store.busy == .deleting ? "Deleting…" : "Delete Health Data on Mac")
                    Spacer()
                    if store.busy == .deleting { ProgressView() }
                }
            }
            .disabled(store.busy != nil)
            .accessibilityIdentifier("health.deleteOnMac")
            // On the button itself, so the dialog's arrow points at what was tapped.
            .confirmationDialog(
                "Delete your Apple Health data on your Mac?",
                isPresented: $confirmDelete,
                titleVisibility: .visible
            ) {
                Button("Delete Health Data", role: .destructive) {
                    Task { await store.deleteDataOnMac() }
                }
            } message: {
                Text("Walnut removes every Apple Health record it keeps on your Mac and turns Apple Health off on this iPhone. Nothing is removed from the Health app.")
            }
        }
    }

    // MARK: - Copy

    private var showsHistoryProgress: Bool {
        store.progress.typesTotal > 0 && !store.progress.historyComplete && store.progress.lastSuccessAt == nil
    }

    private var primaryLine: String {
        let progress = store.progress
        if showsHistoryProgress {
            return "Syncing history: \(progress.typesDone) of \(progress.typesTotal) types"
        }
        if progress.running { return "Syncing…" }
        if let last = progress.lastSuccessAt {
            return "Last synced \(Self.relative(last))"
        }
        return "Not synced yet"
    }

    private var statusLines: [String] {
        var lines: [String] = []
        if store.macPaused == true {
            lines.append("Paused. Your Mac keeps what it has, and nothing new is synced until you turn Pause off.")
        }
        switch store.progress.lastOutcome {
        case .macUnreachable?:
            lines.append("Your Mac can't be reached right now. Walnut syncs as soon as it can.")
        case .locked?:
            lines.append("Your iPhone was locked, so Apple Health could not be read. Walnut syncs after you unlock it.")
        case .unauthorized?:
            lines.append("Your Mac did not accept this iPhone. Pair it again in Settings.")
        default:
            if store.macUnreachable {
                lines.append("Your Mac can't be reached right now. Walnut syncs as soon as it can.")
            }
        }
        if store.backgroundRefreshOff {
            lines.append("Background App Refresh is off for Walnut, so it syncs only while Walnut is open.")
        } else if store.lowPowerMode {
            lines.append("Low Power Mode is on, so Walnut syncs only while it is open.")
        }
        return lines
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    static func relative(_ date: Date) -> String {
        if abs(date.timeIntervalSinceNow) < 60 { return "just now" }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }
}
