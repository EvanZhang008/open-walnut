import AVKit
import Observation
import SwiftUI

@Observable
@MainActor
final class SessionMediaPlayback {
    private(set) var player: AVPlayer?
    private(set) var preparing = false
    private(set) var failure: FileReadFailure?
    @ObservationIgnored private var observation: NSKeyValueObservation?
    @ObservationIgnored private var playObservation: NSKeyValueObservation?
    @ObservationIgnored private var audioNotifications: [NSObjectProtocol] = []
    @ObservationIgnored private var interrupted = false
    @ObservationIgnored private let stopSpeech: @MainActor () -> Void
    @ObservationIgnored private var audioTask: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var ownsAudio = false
    @ObservationIgnored private var itemReady = false
    @ObservationIgnored private var foreground = true
    @ObservationIgnored private var suspendedTime: CMTime?
    @ObservationIgnored private let settleAudio: @MainActor () async -> Void
    @ObservationIgnored private let activateAudio: @MainActor () throws -> Void
    @ObservationIgnored private let deactivateAudio: @MainActor () -> Void

    init(settleAudio: @escaping @MainActor () async -> Void = { await AudioSessionHandoff.settle() },
         activateAudio: @escaping @MainActor () throws -> Void = {
             let session = AVAudioSession.sharedInstance()
             try session.setCategory(.playback, mode: .moviePlayback)
             try session.setActive(true)
         },
         deactivateAudio: @escaping @MainActor () -> Void = { AudioSessionHandoff.deactivateOffMain() },
         stopSpeech: @escaping @MainActor () -> Void = { SpeechOutput.shared.stop(handoff: true) }) {
        self.stopSpeech = stopSpeech
        self.settleAudio = settleAudio
        self.activateAudio = activateAudio
        self.deactivateAudio = deactivateAudio
    }

    func open(_ url: URL, host: String?) {
        teardown()
        preparing = true
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        self.player = player
        playObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player, self.player === player else { return }
                if player.timeControlStatus == .paused {
                    self.releaseAudio()
                } else {
                    self.claimAudio(host: host)
                }
            }
        }
        observeAudioNotifications()
        observation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            Task { @MainActor [weak self, weak item] in
                guard let self, let item, self.player?.currentItem === item else { return }
                switch item.status {
                case .readyToPlay:
                    self.itemReady = true
                    self.preparing = false
                    AppLog.info("session-media", "media ready to play", [
                        "duration": String(item.duration.seconds), "playable": "true"
                    ])
                case .failed:
                    self.releaseAudio()
                    self.preparing = false
                    self.failure = FileReadFailure(kind: .unsupportedType, host: host)
                    self.player?.pause()
                    let error = item.error as NSError?
                    AppLog.warn("session-media", "media playback failed", [
                        "domain": error?.domain ?? "Unknown", "code": String(error?.code ?? 0)
                    ])
                default: break
                }
            }
        }
    }

    @discardableResult
    func claimAudio(host: String?) -> Task<Void, Never>? {
        guard foreground, !interrupted, !ownsAudio, audioTask == nil else { return audioTask }
        stopSpeech()
        let current = generation
        let settle = settleAudio
        audioTask = Task { [weak self] in
            await settle()
            guard let self, self.generation == current, self.foreground, !Task.isCancelled else { return }
            if self.player?.timeControlStatus == .paused {
                self.audioTask = nil
                return
            }
            do {
                try self.activateAudio()
                self.ownsAudio = true
                self.failure = nil
                self.preparing = false
            } catch {
                self.player?.pause()
                self.failure = FileReadFailure(kind: .hostReadFailed("Couldn't start media audio on this phone."), host: host)
                self.preparing = false
            }
            self.audioTask = nil
        }
        return audioTask
    }

    func setForeground(_ active: Bool, host: String?) {
        guard foreground != active else { return }
        foreground = active
        if !active {
            player?.pause()
            let time = player?.currentTime()
            suspendedTime = time?.isNumeric == true ? time : nil
            releaseAudio()
        } else if let time = suspendedTime {
            suspendedTime = nil
            player?.pause()
            // Background recovery can land on a keyframe instead of the paused frame.
            player?.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
        }
    }

    private func observeAudioNotifications() {
        let player = self.player
        let center = NotificationCenter.default
        audioNotifications = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) {
                [weak self, weak player] notification in
                let began = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt)
                    == AVAudioSession.InterruptionType.began.rawValue
                Task { @MainActor [weak self, weak player] in
                    guard let self, let player, self.player === player else { return }
                    self.interrupted = began
                    if began {
                        self.player?.pause()
                        self.releaseAudio()
                    }
                }
            },
            center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) {
                [weak self, weak player] _ in
                Task { @MainActor [weak self, weak player] in
                    guard let self, let player, self.player === player else { return }
                    self.player?.pause()
                    self.releaseAudio()
                    self.interrupted = false
                }
            }
        ]
    }

    private func releaseAudio() {
        generation += 1
        audioTask?.cancel()
        audioTask = nil
        if ownsAudio { deactivateAudio() }
        ownsAudio = false
    }

    func teardown() {
        releaseAudio()
        observation?.invalidate()
        observation = nil
        playObservation?.invalidate()
        playObservation = nil
        for token in audioNotifications { NotificationCenter.default.removeObserver(token) }
        audioNotifications = []
        interrupted = false
        suspendedTime = nil
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
        itemReady = false
        preparing = false
        failure = nil
    }
}

@Observable
@MainActor
final class SessionMediaPresentation {
    let loader = SessionMediaLoader()
    let playback = SessionMediaPlayback()
    var targetID: String?

    func teardown() {
        targetID = nil
        playback.teardown()
        loader.teardown()
    }
}

private struct SessionFileSheet<Item: Identifiable, Sheet: View>: ViewModifier {
    @Binding var item: Item?
    let sheet: (Item) -> Sheet
    // SwiftUI can recreate sheet content on foreground without dismissing it.
    @State private var media = SessionMediaPresentation()

    func body(content: Content) -> some View {
        content.sheet(item: $item, onDismiss: media.teardown) { item in
            sheet(item).environment(media)
        }
    }
}

extension View {
    func sessionFileSheet<Item: Identifiable, Sheet: View>(
        item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Sheet
    ) -> some View {
        modifier(SessionFileSheet(item: item, sheet: content))
    }
}

private struct SessionMediaPlayer: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
    }

    static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: ()) {
        controller.player = nil
    }
}

struct SessionMediaView: View {
    let path: String
    let host: String?
    var reference: String? = nil
    var cwd: String? = nil
    var sessionID: String? = nil

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(SessionMediaPresentation.self) private var media
    @State private var visible = false

    private var loader: SessionMediaLoader { media.loader }
    private var playback: SessionMediaPlayback { media.playback }
    private var targetID: String { "\(host ?? "")\u{1}\(path)" }

    var body: some View {
        ZStack {
            if SessionMediaKind.forPath(path) == .unsupported {
                ContentUnavailableView {
                    Label("Unsupported media format", systemImage: "play.slash")
                } description: {
                    Text("WebM and Ogg aren't supported on this phone. Use MP4, M4V, MOV, MP3, M4A or WAV with an Apple-compatible codec.")
                }
            } else if let failure = playback.failure {
                unavailable(failure, retryable: true)
            } else {
                switch loader.phase {
                case .idle, .downloading:
                    waiting("Downloading media…")
                case .failed(let failure):
                    unavailable(failure, retryable: failure.isRetryable)
                case .ready:
                    VStack(spacing: 0) {
                        healedNotice.padding(12)
                        ZStack {
                            if let player = playback.player {
                                SessionMediaPlayer(player: player)
                                    .accessibilityIdentifier("session.media.player")
                            }
                            if playback.preparing { waiting("Preparing media…") }
                        }
                        if typeSize.isAccessibilitySize, let player = playback.player {
                            TimelineView(.periodic(from: .now, by: 1)) { _ in
                                Text("\(Self.timeLabel(player.currentTime().seconds)) / \(Self.timeLabel(player.currentItem?.duration.seconds ?? 0))")
                                    .font(.caption.monospacedDigit())
                                    .accessibilityIdentifier("session.media.time")
                            }
                            .padding(8)
                        }
                    }
                }
            }
        }
        .toolbar {
            if case .ready(let url) = loader.phase {
                ToolbarItem(placement: .topBarLeading) {
                    ShareLink(item: url)
                        .accessibilityIdentifier("session.media.share")
                }
            }
        }
        .task(id: targetID) {
            visible = true
            playback.setForeground(scenePhase == .active, host: host)
            guard media.targetID != targetID else { return }
            media.targetID = targetID
            start()
        }
        .onChange(of: loader.phase, initial: true) { _, phase in
            if case .ready(let url) = phase, playback.player == nil {
                playback.open(url, host: host)
            }
        }
        .onAppear {
            visible = true
            playback.setForeground(scenePhase == .active, host: host)
        }
        .onChange(of: scenePhase) { _, phase in
            playback.setForeground(phase == .active && visible, host: host)
        }
        .onDisappear {
            visible = false
            playback.setForeground(false, host: host)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session.media")
    }

    @ViewBuilder
    private var healedNotice: some View {
        if let healed = loader.healedPath {
            Label("The original path wasn't there. Trying \(healed) instead.",
                  systemImage: "arrow.triangle.branch")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func waiting(_ message: String) -> some View {
        VStack(spacing: 16) {
            healedNotice
            ProgressView()
            Text(message).foregroundStyle(.secondary)
            Text("Playback starts when you tap Play.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Cancel") {
                teardown()
                dismiss()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session.media.loading")
    }

    private func unavailable(_ failure: FileReadFailure, retryable: Bool) -> some View {
        ContentUnavailableView {
            Label(failure.title, systemImage: failure.icon)
        } description: {
            healedNotice
            if playback.failure != nil {
                Text("This media couldn't be played. Its codec may not be supported, or the file may be incomplete. Try downloading it again or use an Apple-compatible codec.")
            } else {
                Text(failure.message)
            }
        } actions: {
            if retryable {
                Button("Try Again", action: start)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("session.media.retry")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func start() {
        playback.teardown()
        let resolver: SessionMediaLoader.Resolve?
        if let cwd, !cwd.isEmpty {
            let reference = self.reference ?? path
            let host = self.host
            let sessionID = self.sessionID
            resolver = { _ in
                guard let result = try? await WalnutAPI().resolvePath(
                    rel: reference, cwd: cwd, host: host, sessionID: sessionID), result.resolved else { return nil }
                return result.path
            }
        } else {
            resolver = nil
        }
        loader.start(path: path, host: host, resolve: resolver)
    }

    static func timeLabel(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let value = Int(seconds)
        return String(format: "%d:%02d", value / 60, value % 60)
    }

    private func teardown() {
        media.teardown()
    }
}
