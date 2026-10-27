import SwiftUI

/// Settings → Focus music: one Play / Stop, the volume, how the folder plays, the tracks
/// in the Rhythm folder on the Mac, and the focus block they go with. The sound lives in
/// `FocusMusicPlayer.shared`, so leaving this screen (or locking the phone) keeps it playing.
struct FocusMusicView: View {
    @State private var player = FocusMusicPlayer.shared
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        List {
            nowSection
            focusSection
            tracksSection
        }
        .navigationTitle("Focus music")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await player.refresh() }
        .task { await player.refresh() }
        .accessibilityIdentifier("focusMusic.screen")
    }

    private var nowSection: some View {
        Section {
            HStack(spacing: 14) {
                Button {
                    player.toggle()
                } label: {
                    Image(systemName: player.isOn ? "stop.fill" : "play.fill")
                        .font(.title2)
                        .frame(width: 52, height: 52)
                        .background(Circle().fill(player.isOn ? Color(uiColor: .secondarySystemFill) : Color.accentColor))
                        .foregroundStyle(player.isOn ? Color.accentColor : Color.white)
                }
                .buttonStyle(.plain)
                .disabled(!player.isOn && player.tracks.isEmpty)
                .accessibilityLabel(player.isOn ? "Stop the focus music" : "Play \(player.currentTrack?.title ?? "the focus music")")
                .accessibilityIdentifier("focusMusic.toggle")
                VStack(alignment: .leading, spacing: 2) {
                    Text(player.currentTrack?.title ?? "No music yet")
                        .font(.headline)
                        .lineLimit(2)
                    Text(stateText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("focusMusic.state")
                }
            }
            .padding(.vertical, 4)
            HStack(spacing: 10) {
                Image(systemName: "speaker.fill").foregroundStyle(.secondary).accessibilityHidden(true)
                Slider(value: Binding(get: { Double(player.volume) }, set: { player.setVolume(Float($0)) }), in: 0...1)
                    .accessibilityLabel("Volume")
                    .accessibilityIdentifier("focusMusic.volume")
                Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary).accessibilityHidden(true)
            }
            Picker("Plays", selection: Binding(get: { player.order }, set: { player.setOrder($0) })) {
                ForEach(FocusMusicOrder.allCases) { order in Text(order.label).tag(order) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("focusMusic.order")
            if let error = player.error {
                Text(error).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("focusMusic.error")
            }
        } footer: {
            Text("Keeps playing with the screen locked or in another app. Stop it here, or from the Lock Screen.")
        }
    }

    private var focusSection: some View {
        Section {
            let phase = player.focus?.focus.phase ?? "idle"
            LabeledContent("Focus block", value: Self.phaseText(player.focus))
                .accessibilityIdentifier("focusMusic.focusPhase")
            if phase == "focus" || phase == "break" {
                Button("Stop block", role: .destructive) { run { await player.stopFocusBlock() } }
                    .disabled(busy)
                    .accessibilityIdentifier("focusMusic.focusStop")
            } else {
                Button("Start a \(player.focus?.config?.focusMinutes ?? 25) min focus block") { run { await player.startFocusBlock() } }
                    .disabled(busy)
                    .accessibilityIdentifier("focusMusic.focusStart")
            }
            if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
        } footer: {
            Text((player.focus?.config?.musicWithFocus ?? true)
                 ? "Start also plays the music on this phone, and it stops when the block ends."
                 : "Music plays only when you press Play. Rhythm's settings on the Mac can change that.")
        }
    }

    private var tracksSection: some View {
        Section {
            if let loadError = player.loadError, player.listing == nil {
                Text(loadError).foregroundStyle(.red).accessibilityIdentifier("focusMusic.loadError")
            } else if let listing = player.listing, listing.tracks.isEmpty {
                Text(listing.error ?? "No music in the folder yet. Add m4a, mp3 or wav files on the Mac, then pull to refresh.")
                    .foregroundStyle(.secondary)
            } else if player.listing == nil {
                ProgressView()
            }
            ForEach(player.tracks) { track in
                Button {
                    player.select(track.id)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(track.title).foregroundStyle(.primary)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(track.bytes), countStyle: .file))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if track.id == player.currentTrack?.id {
                            Image(systemName: "checkmark").foregroundStyle(Color.accentColor).accessibilityHidden(true)
                        }
                    }
                }
                .accessibilityAddTraits(track.id == player.currentTrack?.id ? .isSelected : [])
                .accessibilityIdentifier("focusMusic.track")
            }
        } header: {
            Text("Tracks")
        } footer: {
            if let folder = player.listing?.folder {
                Text("From \(folder) on your Mac. Music added there shows up here.")
            }
        }
    }

    private var stateText: String {
        if player.starting { return "Starting…" }
        if !player.playing { return "Stopped" }
        return player.tiedToFocus ? "Playing, stops when the block ends" : "Playing"
    }

    static func phaseText(_ status: RhythmFocusStatus?) -> String {
        guard let status else { return "Unknown" }
        switch status.focus.phase {
        case "focus":
            guard let endsAt = status.focus.endsAt, let now = status.now, endsAt > now else { return "Running" }
            return "\(Int(ceil((endsAt - now) / 60_000))) min left"
        case "break": return "On a break"
        case "break_due": return "Block done"
        default: return "Not running"
        }
    }

    private func run(_ action: @escaping () async -> String) {
        busy = true
        Task {
            message = await action()
            busy = false
        }
    }
}
