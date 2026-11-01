import AVFoundation
import MediaPlayer
import Observation

/// What plays after a track ends. Pure, so the order rules are tested without audio.
enum FocusMusicOrder: String, CaseIterable, Identifiable {
    case one, inOrder = "in_order", shuffle

    var id: String { rawValue }

    var label: String {
        switch self {
        case .one: return "Repeat one"
        case .inOrder: return "In order"
        case .shuffle: return "Shuffle"
        }
    }

    /// `random` is in [0, 1). Shuffle never repeats the track that just ended.
    static func nextIndex(_ order: FocusMusicOrder, current: Int, count: Int, random: Double) -> Int {
        guard count > 0 else { return -1 }
        if order == .one || count == 1 { return max(0, min(current, count - 1)) }
        if order == .inOrder { return (current + 1) % count }
        let pick = Int(random * Double(count - 1))
        return pick >= current ? pick + 1 : pick
    }
}

/// What Start plays: a folder track on this phone, a Spotify playlist in the Mac's Spotify
/// app, or nothing. The twin of the Rhythm web player's `StartChoice`; stored as one string.
enum FocusStartChoice: Equatable, Hashable {
    case none
    case track(String)
    case spotify(String)

    var stored: String {
        switch self {
        case .none: return "none"
        case .track(let id): return "track:\(id)"
        case .spotify(let uri): return "spotify:\(uri)"
        }
    }

    init?(stored: String?) {
        guard let stored else { return nil }
        if stored == "none" { self = .none; return }
        if stored.hasPrefix("track:"), stored.count > 6 { self = .track(String(stored.dropFirst(6))); return }
        if stored.hasPrefix("spotify:spotify:") { self = .spotify(String(stored.dropFirst(8))); return }
        return nil
    }

    /// Twin of the web's `resolveStartChoice`: the phone's own pick while it still exists;
    /// the first time, the setting decides between the current track and nothing. A track
    /// that left the folder falls back to the current one; a playlist that is gone (or a
    /// Mac without Spotify) to nothing.
    static func resolve(stored: FocusStartChoice?, listing: RhythmMusicListing?, trackID: String?, withFocus: Bool) -> FocusStartChoice {
        let tracks = listing?.tracks ?? []
        let current = tracks.first { $0.id == trackID } ?? tracks.first
        switch stored {
        case .none?: return .none
        case .track(let id)?:
            if listing == nil || tracks.contains(where: { $0.id == id }) { return .track(id) }
            return current.map { .track($0.id) } ?? .none
        case .spotify(let uri)?:
            guard let listing else { return .spotify(uri) }
            if let spotify = listing.spotify, spotify.available, spotify.playlists.contains(where: { $0.uri == uri }) { return .spotify(uri) }
            return .none
        case nil:
            return withFocus ? (current.map { .track($0.id) } ?? .none) : .none
        }
    }
}

/// The phone's focus music: the tracks in the Rhythm folder on the Mac, streamed with
/// byte ranges (an 8 hour file starts at once), looping, with lock screen controls.
///
/// It keeps playing with the screen locked and in the background: the app declares the
/// `audio` background mode and the session is `.playback`. Music started with a focus
/// block (or while one runs) is tied to it: the player stops at the block's end time and
/// checks Rhythm's status every 20 s, so a block stopped on the Mac stops it too. One
/// track on repeat uses `AVPlayerLooper`, which loops without a gap; In order and Shuffle
/// keep the next track queued in the same player, so a track change never leaves a
/// silent gap in which iOS could suspend the app.
///
/// The app's other audio (dictation, voice mode, a session video) takes the shared audio
/// session and pauses this player. A pause nobody here asked for is shown as a stop,
/// except during an interruption (a call), after which the music comes back when iOS
/// says it may.
@Observable
@MainActor
final class FocusMusicPlayer {
    static let shared = FocusMusicPlayer()

    private(set) var listing: RhythmMusicListing?
    private(set) var loading = false
    private(set) var loadError: String?
    private(set) var focus: RhythmFocusStatus?
    private(set) var trackID: String?
    private(set) var playing = false
    private(set) var starting = false
    private(set) var tiedToFocus = false
    private(set) var error: String?
    private(set) var order: FocusMusicOrder
    private(set) var volume: Float
    /// This phone's own pick for Start; read it through `startChoice`.
    private(set) var storedStartChoice: FocusStartChoice?

    @ObservationIgnored private let api = WalnutAPI()
    @ObservationIgnored private var player: AVQueuePlayer?
    @ObservationIgnored private var looper: AVPlayerLooper?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    /// Bumped by every start and stop; late callbacks of an older player check it.
    @ObservationIgnored private var generation = 0
    /// Track ids queued behind the current one, in play order (In order / Shuffle).
    @ObservationIgnored private var queuedIDs: [ObjectIdentifier: String] = [:]
    /// A Start from this phone that Rhythm has not answered yet: the block is not "focus" yet.
    @ObservationIgnored private var focusStartPending = false
    /// When `focus` was read, to judge a block's end by the server's clock.
    @ObservationIgnored private var focusReadAt = Date.distantPast
    @ObservationIgnored private var interrupted = false
    @ObservationIgnored private var interruptionObserver: NSObjectProtocol?
    @ObservationIgnored private var focusWatch: Task<Void, Never>?
    @ObservationIgnored private var watchID = 0
    @ObservationIgnored private var remoteCommandsReady = false

    static let orderKey = "focusMusic.order"
    static let volumeKey = "focusMusic.volume"
    static let trackKey = "focusMusic.track"
    static let startChoiceKey = "focusMusic.startChoice"
    static let watchSeconds: UInt64 = 20

    private init() {
        let defaults = AppPrefs.defaults
        order = FocusMusicOrder(rawValue: defaults.string(forKey: Self.orderKey) ?? "") ?? .one
        let stored = defaults.object(forKey: Self.volumeKey) as? Double
        volume = Float(stored.map { min(1, max(0, $0)) } ?? 0.6)
        trackID = defaults.string(forKey: Self.trackKey)
        storedStartChoice = FocusStartChoice(stored: defaults.string(forKey: Self.startChoiceKey))
    }

    var startChoice: FocusStartChoice {
        FocusStartChoice.resolve(
            stored: storedStartChoice, listing: listing, trackID: trackID,
            withFocus: focus?.config?.musicWithFocus ?? listing?.withFocus ?? true
        )
    }

    func setStartChoice(_ choice: FocusStartChoice) {
        storedStartChoice = choice
        AppPrefs.defaults.set(choice.stored, forKey: Self.startChoiceKey)
        if case .track(let id) = choice { trackID = id; AppPrefs.defaults.set(id, forKey: Self.trackKey) }
    }

    var tracks: [RhythmMusicListing.Track] { listing?.tracks ?? [] }
    var currentTrack: RhythmMusicListing.Track? { tracks.first { $0.id == trackID } ?? tracks.first }
    var isOn: Bool { playing || starting }

    // MARK: - Loading

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            let next = try await api.rhythmMusicTracks()
            listing = next
            loadError = nil
            if !next.tracks.contains(where: { $0.id == trackID }) { trackID = next.tracks.first?.id }
        } catch {
            loadError = error.localizedDescription
        }
        await refreshFocus()
    }

    /// False when the Mac did not answer.
    @discardableResult
    func refreshFocus() async -> Bool {
        guard let status = try? await api.rhythmStatus() else { return false }
        applyFocus(status)
        return true
    }

    /// The server's clock now, from its last answer plus the time since.
    func serverNow(at date: Date = Date()) -> Double? {
        guard let now = focus?.now else { return nil }
        return now + date.timeIntervalSince(focusReadAt) * 1000
    }

    // MARK: - Playback

    func toggle() {
        if isOn { stop() } else { play() }
    }

    func play(trackID wanted: String? = nil, withFocus: Bool = false) {
        guard let track = tracks.first(where: { $0.id == (wanted ?? trackID) }) ?? tracks.first else {
            error = listing == nil ? "The music list has not loaded yet." : "There is no music in the folder yet. Add an m4a, mp3 or wav file on the Mac, then pull to refresh."
            return
        }
        tiedToFocus = Self.shouldTie(withFocus: withFocus, status: focus, readAt: focusReadAt, now: Date())
        start(track)
    }

    func stop() {
        generation += 1
        tiedToFocus = false
        endWatch()
        teardownPlayer()
        playing = false
        starting = false
        interrupted = false
        releaseAudio()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    func select(_ id: String) {
        trackID = id
        AppPrefs.defaults.set(id, forKey: Self.trackKey)
        error = nil
        if isOn, let track = tracks.first(where: { $0.id == id }) { start(track) }
    }

    func setOrder(_ next: FocusMusicOrder) {
        order = next
        AppPrefs.defaults.set(next.rawValue, forKey: Self.orderKey)
        if isOn, let track = currentTrack { start(track) }
    }

    func setVolume(_ next: Float) {
        volume = min(1, max(0, next))
        player?.volume = volume
        AppPrefs.defaults.set(Double(volume), forKey: Self.volumeKey)
    }

    /// Start a block on the Mac with this phone's music pick: a folder track plays here,
    /// a Spotify playlist in the Mac's Spotify app. The lengths become the next defaults.
    func startFocusBlock(minutes: Int, breakMinutes: Int, remember: Bool = true) async -> String {
        let choice = startChoice
        var withMusic = false
        var spotify: String?
        switch choice {
        case .track(let id): withMusic = tracks.contains { $0.id == id }
        case .spotify(let uri): spotify = uri; if isOn { stop() }
        case .none: break
        }
        focusStartPending = true
        if withMusic, case .track(let id) = choice { play(trackID: id, withFocus: true) }
        let played = generation
        defer { focusStartPending = false }
        do {
            let result = try await api.rhythmFocusStart(minutes: minutes, breakMinutes: breakMinutes, spotify: spotify, remember: remember)
            focusStartPending = false
            if let state = result.state { applyFocus(state) }
            return result.message
        } catch {
            // Only the play this Start made: music restarted since then is the person's.
            if withMusic, generation == played { stop() }
            return error.localizedDescription
        }
    }

    func stopFocusBlock() async -> String {
        await focusAction { try await $0.rhythmFocusStop() }
    }

    /// End the break: off, keeping the cycle count so the long break still comes.
    func endBreak() async -> String {
        await focusAction { try await $0.rhythmBreakSkip() }
    }

    private func focusAction(_ call: (WalnutAPI) async throws -> RhythmActionResult) async -> String {
        do {
            let result = try await call(api)
            if let state = result.state { applyFocus(state) }
            return result.message
        } catch {
            return error.localizedDescription
        }
    }

    /// Music is tied to a block when a Start asked for it, or when a block is running by a
    /// reading fresh enough to trust: its end, by the server's clock, is still ahead.
    static func shouldTie(withFocus: Bool, status: RhythmFocusStatus?, readAt: Date, now: Date) -> Bool {
        if withFocus { return true }
        guard let status, status.focus.phase == "focus" else { return false }
        guard let endsAt = status.focus.endsAt, endsAt > 0, let serverNow = status.now else { return false }
        let serverNowNow = serverNow + now.timeIntervalSince(readAt) * 1000
        return endsAt > serverNowNow
    }

    // MARK: - Internals

    private func start(_ track: RhythmMusicListing.Track) {
        guard WalnutAPI.rawFileContentURL(path: track.file) != nil, AppConfig.token != nil else {
            error = "Walnut is not connected."
            return
        }
        teardownPlayer()
        generation += 1
        let current = generation
        trackID = track.id
        AppPrefs.defaults.set(track.id, forKey: Self.trackKey)
        error = nil
        starting = true
        setNowPlaying(track)
        watchFocusIfTied()
        Task { [weak self] in
            // A switch-off still queued from an earlier stop would silence this start.
            await AudioSessionHandoff.settle()
            guard let self, self.generation == current else { return }
            guard self.claimAudio() else { self.starting = false; return }
            self.startPlayer(track, generation: current)
        }
    }

    private func item(for track: RhythmMusicListing.Track) -> AVPlayerItem? {
        guard let url = WalnutAPI.rawFileContentURL(path: track.file), let token = AppConfig.token else { return nil }
        // The raw route needs the device token; AVURLAsset sends it on every range request.
        let asset = AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": ["Authorization": "Bearer \(token)"]])
        return AVPlayerItem(asset: asset)
    }

    private func startPlayer(_ track: RhythmMusicListing.Track, generation current: Int) {
        guard let first = item(for: track) else { fail("Walnut is not connected."); return }
        let queue = AVQueuePlayer()
        queue.volume = volume
        player = queue
        if order == .one || tracks.count == 1 {
            let looper = AVPlayerLooper(player: queue, templateItem: first)
            self.looper = looper
            observations.append(looper.observe(\.status, options: [.new]) { [weak self] looper, _ in
                let failed = looper.status == .failed
                Task { @MainActor [weak self] in
                    guard failed, let self, self.generation == current else { return }
                    self.fail("Could not play \(track.title). Check that the Mac is reachable and the file is still in the folder.")
                }
            })
        } else {
            queue.insert(first, after: nil)
            queuedIDs[ObjectIdentifier(first)] = track.id
            queueNext(after: track.id, in: queue)
            // The queue moves on by itself; this only names the new track and queues the one after it.
            observations.append(queue.observe(\.currentItem, options: [.new]) { [weak self] queue, _ in
                Task { @MainActor [weak self] in
                    guard let self, self.generation == current, self.player === queue, let item = queue.currentItem,
                          let id = self.queuedIDs[ObjectIdentifier(item)], id != self.trackID else { return }
                    self.trackID = id
                    AppPrefs.defaults.set(id, forKey: Self.trackKey)
                    if let now = self.tracks.first(where: { $0.id == id }) { self.setNowPlaying(now) }
                    self.queueNext(after: id, in: queue)
                }
            })
        }
        observations.append(queue.observe(\.timeControlStatus, options: [.new]) { [weak self] queue, _ in
            let status = queue.timeControlStatus
            Task { @MainActor [weak self] in
                guard let self, self.generation == current, self.player === queue else { return }
                switch status {
                case .playing:
                    self.playing = true
                    self.starting = false
                case .paused where self.playing:
                    // Someone else took the audio session (dictation, voice mode, a video): say so.
                    // An interruption's own notice can land just after this pause, so wait for it.
                    try? await Task.sleep(nanoseconds: 400_000_000)
                    guard self.generation == current, self.player === queue, self.playing, !self.interrupted,
                          queue.timeControlStatus == .paused else { return }
                    AppLog.info("focus-music", "paused by another audio user")
                    self.stop()
                default: break
                }
            }
        })
        watchFailure(of: queue, title: track.title, generation: current)
        queue.play()
    }

    /// Keep exactly one track queued behind the current one.
    private func queueNext(after id: String, in queue: AVQueuePlayer) {
        let list = tracks
        let current = list.firstIndex { $0.id == id } ?? 0
        let next = FocusMusicOrder.nextIndex(order, current: current, count: list.count, random: Double.random(in: 0..<1))
        guard next >= 0, queue.items().count < 2, let item = item(for: list[next]) else { return }
        queuedIDs[ObjectIdentifier(item)] = list[next].id
        queue.insert(item, after: nil)
    }

    /// A bad file or a refused read shows up as the item's status (or the looper's), not as a notification.
    private func watchFailure(of queue: AVQueuePlayer, title: String, generation current: Int) {
        observers.append(NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: nil, queue: .main) { [weak self, weak queue] note in
            let failedItem = note.object as? AVPlayerItem
            Task { @MainActor in
                guard let self, let queue, self.generation == current, self.player === queue,
                      let failedItem, queue.items().contains(failedItem) else { return }
                self.fail("Could not play \(title): the stream stopped.")
            }
        })
        Task { @MainActor [weak self] in
            for _ in 0..<60 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self, self.generation == current, let queue = self.player else { return }
                // The looper inserts its copies only once the duration loaded, so an empty queue is still loading.
                guard let item = queue.currentItem else { continue }
                if item.status == .failed {
                    AppLog.warn("focus-music", "track failed", ["code": String((item.error as NSError?)?.code ?? 0)])
                    self.fail("Could not play \(title). Check that the Mac is reachable and the file is still in the folder.")
                    return
                }
                if item.status == .readyToPlay { return }
            }
            guard let self, self.generation == current, !self.playing else { return }
            self.fail("Could not play \(title): the Mac did not answer in 30 seconds.")
        }
    }

    private func fail(_ message: String) {
        stop()
        error = message
    }

    private func teardownPlayer() {
        looper?.disableLooping()
        looper = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        for observation in observations { observation.invalidate() }
        observations = []
        queuedIDs = [:]
        player?.pause()
        player?.removeAllItems()
        player = nil
    }

    /// Asked of the session on every start: another part of the app may have switched it
    /// to recording, or off, since the last one.
    private func claimAudio() -> Bool {
        SpeechOutput.shared.stop(handoff: true)
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
            observeInterruptions()
            setupRemoteCommands()
            return true
        } catch {
            self.error = "Couldn't start audio on this phone: \(error.localizedDescription)"
            return false
        }
    }

    private func releaseAudio() {
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        interruptionObserver = nil
        AudioSessionHandoff.deactivateOffMain()
    }

    private func observeInterruptions() {
        guard interruptionObserver == nil else { return }
        interruptionObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init) ?? []
            Task { @MainActor in
                guard let self, self.isOn else { return }
                switch type {
                case .began:
                    self.interrupted = true
                case .ended:
                    self.interrupted = false
                    // A call or an alarm paused the music; it comes back when iOS says it may, else it is stopped.
                    if options.contains(.shouldResume), (try? AVAudioSession.sharedInstance().setActive(true)) != nil {
                        self.player?.play()
                    } else {
                        self.stop()
                    }
                default: break
                }
            }
        }
    }

    private func setupRemoteCommands() {
        guard !remoteCommandsReady else { return }
        remoteCommandsReady = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in if self?.isOn == false { self?.play() } }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.stop() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.toggle() }
            return .success
        }
    }

    private func setNowPlaying(_ track: RhythmMusicListing.Track) {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: "Rhythm focus music",
            MPNowPlayingInfoPropertyPlaybackRate: 1.0,
        ]
    }

    private func applyFocus(_ status: RhythmFocusStatus) {
        focus = status
        focusReadAt = Date()
        if tiedToFocus, isOn, !focusStartPending, status.focus.phase != "focus" { stop() }
    }

    private func endWatch() {
        focusWatch?.cancel()
        focusWatch = nil
    }

    /// While tied: stop at the block's end, and notice a block stopped elsewhere.
    private func watchFocusIfTied() {
        guard tiedToFocus, focusWatch == nil else { return }
        watchID += 1
        let id = watchID
        focusWatch = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let wait = Self.nextCheckSeconds(self.focus)
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                guard !Task.isCancelled, self.watchID == id else { return }
                guard self.tiedToFocus, self.isOn else { self.focusWatch = nil; return }
                guard let status = try? await self.api.rhythmStatus() else { continue }
                guard !Task.isCancelled, self.watchID == id else { return }
                self.applyFocus(status)
                if !self.isOn { self.focusWatch = nil; return }
            }
        }
    }

    /// Check again at the block's (or break's) end by the server's clock, or in 20 s, whichever is sooner.
    static func nextCheckSeconds(_ status: RhythmFocusStatus?) -> Double {
        let cap = Double(watchSeconds)
        guard let status, status.focus.phase == "focus" || status.focus.phase == "break", let endsAt = status.focus.endsAt, endsAt > 0, let now = status.now else { return cap }
        return min(cap, max(1, (endsAt - now) / 1000 + 1))
    }
}
