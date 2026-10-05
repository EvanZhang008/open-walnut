import SwiftUI

/// The Settings row that leads to the Places screen.
struct PlacesSettingsSection: View {
    @State private var store = PlacesStore.shared

    var body: some View {
        Section {
            NavigationLink {
                PlacesView()
            } label: {
                LabeledContent {
                    Text(rowValue)
                } label: {
                    Label("Places", systemImage: "mappin.and.ellipse")
                }
            }
            .accessibilityIdentifier("settings.places")
        }
        .onAppear { store.reload() }
    }

    private var rowValue: String {
        guard store.isEnabled else { return "Off" }
        return store.recording ? "On" : "Needs Always"
    }
}

/// Places: what Walnut records, where it goes, and the controls.
struct PlacesView: View {
    @State private var store = PlacesStore.shared
    @State private var confirmDelete = false

    var body: some View {
        List {
            if store.isEnabled {
                statusSection
                if !store.recent.isEmpty { recentSection }
                privacySection
                controlsSection
            } else {
                offSection
                privacySection
            }
        }
        .navigationTitle("Places")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.refresh() }
        .refreshable { await store.refresh() }
    }

    // MARK: - Off

    private var offSection: some View {
        Section {
            Text("Walnut can record the places you visit, so your AI can answer where you were and for how long.")
                .accessibilityIdentifier("places.explanation")
            Button {
                Task { await store.turnOn() }
            } label: {
                HStack {
                    Text(store.busy == .turningOn ? "Turning On…" : "Turn On Places")
                    Spacer()
                    if store.busy == .turningOn { ProgressView() }
                }
            }
            .disabled(store.busy != nil)
            .accessibilityIdentifier("places.turnOn")
        } footer: {
            Text("iOS tells Walnut about a visit only with location access set to Always, so iOS asks you for that next.")
        }
    }

    /// Said plainly on both screens: where the visits go, and from when.
    private var privacySection: some View {
        Section {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Only on your Mac").font(.subheadline.weight(.semibold))
                    Text("Your visits go to your own Mac and nowhere else. Walnut has no server of its own, and your Mac keeps them out of its sync and backups.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "lock.shield")
            }
            .accessibilityIdentifier("places.onlyYourMac")
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("From now on").font(.subheadline.weight(.semibold))
                    Text("Walnut records only while Places is on. Where you went before you turned it on is not included.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "clock")
            }
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Read when you ask").font(.subheadline.weight(.semibold))
                    Text("Your AI reads your visits only when you ask about places, and sends what it uses to the AI provider your Mac uses. Your iPhone names each place with Apple Maps.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "bubble.left.and.text.bubble.right")
            }
        } header: {
            Text("Your Data")
        }
    }

    // MARK: - On

    private var statusSection: some View {
        Section {
            Text(primaryLine)
                .accessibilityIdentifier("places.status")
            if !store.recording {
                Text(accessNote)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("places.accessNote")
                Button("Open Settings") { PlacesRecorder.shared.openSettings() }
                    .accessibilityIdentifier("places.openSettings")
            } else if store.preciseOff {
                Label("Precise Location is off for Walnut, so iOS may record fewer visits.", systemImage: "info.circle")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let count = store.macVisitCount {
                LabeledContent("Visits on your Mac", value: count.formatted())
                    .accessibilityIdentifier("places.macCount")
            }
            if let line = syncLine {
                Label(line, systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("places.syncLine")
            }
        }
    }

    private var recentSection: some View {
        Section {
            ForEach(store.recent) { visit in
                VStack(alignment: .leading, spacing: 2) {
                    Text(visit.name ?? "Unnamed place")
                    Text(Self.span(visit, latest: visit.id == store.recent.first?.id))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("places.visit")
            }
        } header: {
            Text("Recent Visits")
        } footer: {
            Text("This iPhone keeps the last two weeks. Your Mac keeps every visit.")
        }
    }

    private var controlsSection: some View {
        Section {
            Button("Turn Off Places") { store.turnOff() }
                .disabled(store.busy != nil)
                .accessibilityIdentifier("places.turnOff")
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                HStack {
                    Text(store.busy == .deleting ? "Deleting…" : "Delete Places on Mac")
                    Spacer()
                    if store.busy == .deleting { ProgressView() }
                }
            }
            .disabled(store.busy != nil)
            .accessibilityIdentifier("places.deleteOnMac")
            .confirmationDialog(
                "Delete your places on your Mac?",
                isPresented: $confirmDelete,
                titleVisibility: .visible
            ) {
                Button("Delete Places", role: .destructive) {
                    Task { await store.deleteOnMac() }
                }
            } message: {
                Text("Walnut removes every visit it keeps on your Mac and on this iPhone, and turns Places off.")
            }
            if let message = store.errorMessage {
                Text(message).font(.footnote).foregroundStyle(.red)
            }
        } footer: {
            Text("Turning Places off stops recording. The visits already on your Mac stay until you delete them.")
        }
    }

    // MARK: - Copy

    private var primaryLine: String {
        store.recording ? "Recording the places you visit" : "Not recording yet"
    }

    private var accessNote: String {
        switch store.access {
        case .restricted:
            return "Location is restricted on this iPhone, so iOS records no visits for Walnut."
        default:
            return "iOS records visits for Walnut only with location access set to Always. In Settings, tap Location, then Always."
        }
    }

    private var syncLine: String? {
        switch store.lastOutcome {
        case .macUnreachable?:
            return store.unsent > 0 ? "Your Mac can't be reached right now. Walnut sends \(store.unsent == 1 ? "the visit" : "\(store.unsent) visits") as soon as it can." : nil
        case .macTooOld?:
            return "Your Mac needs a newer Walnut to keep places. Visits wait here until then."
        case .unauthorized?:
            return "Your Mac did not accept this iPhone. Pair it again in Settings."
        default:
            if store.recording, store.recent.isEmpty {
                return "iOS records a visit once you have stayed somewhere for a while."
            }
            return nil
        }
    }

    private static let timeFormat: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()

    /// A departure iOS never reported reads "since" only on the latest visit.
    static func span(_ visit: PlaceVisitRecord, latest: Bool) -> String {
        let zone = TimeZone(identifier: visit.timeZoneId) ?? .current
        let fmt = timeFormat
        fmt.timeZone = zone
        let day: String = {
            let date = visit.arrival ?? visit.departure ?? visit.recordedAt
            var cal = Calendar.current
            cal.timeZone = zone
            if cal.isDateInToday(date) { return "Today" }
            if cal.isDateInYesterday(date) { return "Yesterday" }
            return date.formatted(.dateTime.weekday(.wide).month().day())
        }()
        switch (visit.arrival, visit.departure) {
        case let (a?, d?): return "\(day), \(fmt.string(from: a)) to \(fmt.string(from: d))"
        case let (a?, nil): return latest ? "\(day), since \(fmt.string(from: a))" : "\(day), arrived \(fmt.string(from: a))"
        case let (nil, d?): return "\(day), left \(fmt.string(from: d))"
        default: return day
        }
    }
}
