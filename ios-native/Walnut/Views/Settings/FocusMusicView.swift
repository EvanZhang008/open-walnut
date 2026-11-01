import SwiftUI

/// Settings → Focus music: one Play / Stop, the volume, how the folder plays, the tracks
/// in the Rhythm folder on the Mac, and the focus block they go with. The sound lives in
/// `FocusMusicPlayer.shared`, so leaving this screen (or locking the phone) keeps it playing.
struct FocusMusicView: View {
    @State private var player = FocusMusicPlayer.shared
    @State private var message: String?
    @State private var busy = false
    @State private var focusMinutes = 25
    @State private var breakMinutes = 5
    @State private var lengthsTouched = false
    /// The block's phase when the message was written: the message stays until the phase moves on.
    @State private var messagePhase: String?
    @State private var retrying = false
    @State private var retryFailed = false

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
        // While the screen shows, follow the block: a block or break ends (or starts elsewhere) without a tap here.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(FocusMusicPlayer.nextCheckSeconds(player.focus) * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await player.refreshFocus()
            }
        }
        .accessibilityIdentifier("focusMusic.screen")
    }

    private var nowSection: some View {
        Section {
            HStack(spacing: 14) {
                Button {
                    player.toggle()
                } label: {
                    // A fixed size: the glyph must stay inside its fixed circle at every text size.
                    Image(systemName: player.isOn ? "stop.fill" : "play.fill")
                        .font(.system(size: 22, weight: .regular))
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
            // The minutes left count down by the local clock between reads.
            TimelineView(.periodic(from: .now, by: 15)) { context in
                LabeledContent("Focus block", value: Self.phaseText(player.focus, now: player.serverNow(at: context.date)))
            }
            .accessibilityIdentifier("focusMusic.focusPhase")
            if phase == "focus" {
                Button("Stop block", role: .destructive) { run { await player.stopFocusBlock() } }
                    .disabled(busy)
                    .accessibilityIdentifier("focusMusic.focusStop")
            } else if phase == "break" || phase == "break_due" {
                Button("End break") { run { await player.endBreak() } }
                    .disabled(busy)
                    .accessibilityIdentifier("focusMusic.focusStop")
            } else if player.focus == nil {
                // Until the status (and its remembered lengths) arrives, Start would send 25 and 5.
                Text("No answer from your Walnut yet. Start shows once it answers.")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("focusMusic.focusLoading")
                Button(retrying ? "Trying…" : "Try again") {
                    retrying = true
                    retryFailed = false
                    Task {
                        retryFailed = !(await player.refreshFocus())
                        retrying = false
                    }
                }
                .disabled(retrying)
                .accessibilityIdentifier("focusMusic.focusRetry")
                if retryFailed {
                    Text("Still no answer from your Walnut. Check that the Mac is on and reachable.")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("focusMusic.focusRetryFailed")
                }
            } else {
                // One text per stepper, so large type wraps between words, never inside one.
                Stepper(value: focusMinutesBinding, in: 5...180, step: 5) {
                    Text("Focus: \(focusMinutes) min")
                }
                .accessibilityIdentifier("focusMusic.focusMinutes")
                Stepper(value: breakMinutesBinding, in: 1...60) {
                    Text("Break: \(breakMinutes) min")
                }
                .accessibilityIdentifier("focusMusic.breakMinutes")
                Picker("Music", selection: Binding(get: { player.startChoice }, set: { player.setStartChoice($0) })) {
                    Text("No music").tag(FocusStartChoice.none)
                    ForEach(player.tracks) { track in Text(track.title).tag(FocusStartChoice.track(track.id)) }
                    if let spotify = player.listing?.spotify, spotify.available {
                        ForEach(spotify.playlists) { one in Text("\(one.name) (Spotify on the Mac)").tag(FocusStartChoice.spotify(one.uri)) }
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("focusMusic.startMusic")
                Text(Self.playsText(player.startChoice, listing: player.listing))
                    .font(.subheadline)
                    .accessibilityIdentifier("focusMusic.startPlays")
                Button("Start \(focusMinutes) min focus, \(Self.thenText(player.focus, breakMinutes: breakMinutes, now: player.serverNow()))") {
                    let minutes = focusMinutes, pause = breakMinutes, picked = lengthsTouched
                    // Only a pick made here becomes the next default; untouched, they are the defaults already.
                    run { await player.startFocusBlock(minutes: minutes, breakMinutes: pause, remember: picked) }
                }
                .disabled(busy)
                .accessibilityIdentifier("focusMusic.focusStart")
            }
            if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
        } footer: {
            Text("Your pick of lengths is kept for the next block on every device; the music pick is this phone's own.")
        }
        // The remembered lengths arrive with the status; a pick made here is not overwritten.
        .onAppear { seedLengths(player.focus?.config) }
        .onChange(of: player.focus?.config) { _, config in seedLengths(config) }
        // A block or break that ended (here or elsewhere) takes the last action's words with it.
        .onChange(of: player.focus?.focus.phase) { _, phase in if !busy, phase != messagePhase { message = nil } }
    }

    private func seedLengths(_ config: RhythmFocusStatus.Config?) {
        guard !lengthsTouched, let config else { return }
        if let focus = config.focusMinutes { focusMinutes = min(180, max(5, focus)) }
        if let pause = config.breakMinutes { breakMinutes = min(60, max(1, pause)) }
    }

    private var focusMinutesBinding: Binding<Int> {
        Binding(get: { focusMinutes }, set: { focusMinutes = $0; lengthsTouched = true })
    }

    private var breakMinutesBinding: Binding<Int> {
        Binding(get: { breakMinutes }, set: { breakMinutes = $0; lengthsTouched = true })
    }

    /// Twin of the web Start form's line: say plainly what Start plays, and where.
    static func playsText(_ choice: FocusStartChoice, listing: RhythmMusicListing?) -> String {
        switch choice {
        case .none:
            return "Start plays no music."
        case .track(let id):
            let title = listing?.tracks.first { $0.id == id }?.title ?? "the focus music"
            return "Start plays \(title) on this phone, until the block ends."
        case .spotify(let uri):
            let name = listing?.spotify?.playlists.first { $0.uri == uri }?.name ?? "the playlist"
            return "Start plays \(name) in Spotify on your Mac, until the block ends."
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

    /// Two hours idle and the next block starts a fresh cycle (Rhythm's CYCLE_RESET_MS).
    static let cycleResetMs: Double = 2 * 60 * 60_000

    /// "then a 5 min break", or the long break when this Start's block earns it.
    static func thenText(_ status: RhythmFocusStatus?, breakMinutes: Int, now: Double?) -> String {
        guard let status, let every = status.config?.longBreakEvery, every > 0, let long = status.config?.longBreakMinutes else {
            return "then a \(breakMinutes) min break"
        }
        let kept: Bool
        if let ended = status.focus.lastRun?.endedAt, let now { kept = now - ended <= cycleResetMs } else { kept = false }
        let completed = kept ? (status.focus.completedInCycle ?? 0) : 0
        return (completed + 1) % every == 0 ? "then the \(long) min long break" : "then a \(breakMinutes) min break"
    }

    static func phaseText(_ status: RhythmFocusStatus?, now clock: Double? = nil) -> String {
        guard let status else { return "Unknown" }
        switch status.focus.phase {
        case "focus":
            guard let endsAt = status.focus.endsAt, let now = clock ?? status.now, endsAt > now else { return "Running" }
            return "\(Int(ceil((endsAt - now) / 60_000))) min left"
        case "break": return "On a break"
        case "break_due": return "Block done"
        default: return "Off"
        }
    }

    private func run(_ action: @escaping () async -> String) {
        busy = true
        Task {
            message = await action()
            messagePhase = player.focus?.focus.phase
            busy = false
        }
    }
}
