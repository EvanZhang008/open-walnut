import AVFoundation
import Observation
import SwiftUI
import UIKit

@Observable
@MainActor
final class VoiceHistoryDetailModel {
    private(set) var entry: VoiceHistoryEntry
    private(set) var working = false
    private(set) var playing = false
    private(set) var notice: String?
    private(set) var audioURL: URL?
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private lazy var api = WalnutAPI()
    @ObservationIgnored private let store: VoiceRecordingStore
    @ObservationIgnored private var playbackTask: Task<Void, Never>?
    @ObservationIgnored private var playbackGeneration = 0
    @ObservationIgnored private var sessionActivated = false
    #if DEBUG
    @ObservationIgnored var _testBeforePlayback: (() async -> Void)?
    @ObservationIgnored var _testPlaybackStart: (() -> Void)?
    @ObservationIgnored var _testRemoteRecord: ((String, String?) async throws -> VoiceArchiveRecord)?
    #endif

    init(entry: VoiceHistoryEntry, store: VoiceRecordingStore = .shared) {
        self.entry = entry
        self.store = store
        audioURL = entry.audioURL
    }

    func refresh() async {
        let localID = entry.local?.id
        let store = store
        let local = await Task.detached(priority: .utility) {
            localID.flatMap { store.recording(id: $0) }
        }.value
        entry = VoiceHistoryEntry(id: entry.id, local: local ?? entry.local, remote: entry.remote)
        if audioURL == nil { audioURL = entry.audioURL }
        guard let id = entry.serverID else { return }
        do {
            let remote: VoiceArchiveRecord
            #if DEBUG
            if let override = _testRemoteRecord {
                remote = try await override(id, entry.archiveOrigin)
            } else {
                remote = try await api.voiceRecording(id: id, origin: entry.archiveOrigin)
            }
            #else
            remote = try await api.voiceRecording(id: id, origin: entry.archiveOrigin)
            #endif
            entry = VoiceHistoryEntry(id: entry.id, local: entry.local, remote: remote)
            if notice == "Backup status is unavailable. Saved recordings and text are still here." { notice = nil }
        } catch {
            notice = "Backup status is unavailable. Saved recordings and text are still here."
        }
    }

    func loadAudio() async {
        guard audioURL == nil, let id = entry.serverID, !working else { return }
        working = true
        defer { working = false }
        do {
            let format = entry.remote?.format ?? entry.local?.format ?? "m4a"
            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent("voice-history", isDirectory: true)
                .appendingPathComponent("\(id).\(format)")
            audioURL = try await api.voiceAudio(id: id, destination: destination, origin: entry.archiveOrigin)
            notice = nil
        } catch {
            notice = "Could not download the recording. The saved copy is still on your server."
        }
    }

    func togglePlayback() async {
        if playing { stop(); return }
        playbackGeneration += 1
        let generation = playbackGeneration
        await loadAudio()
        guard generation == playbackGeneration, !Task.isCancelled, let audioURL else { return }
        do {
            await AudioSessionHandoff.settle()
            #if DEBUG
            await _testBeforePlayback?()
            #endif
            guard generation == playbackGeneration, !Task.isCancelled else { return }
            #if DEBUG
            _testPlaybackStart?()
            #endif
            let preparedPlayer = try AVAudioPlayer(contentsOf: audioURL)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
            sessionActivated = true
            player = preparedPlayer
            guard player?.play() == true else {
                stop()
                notice = "This recording could not be played. You can still export the saved audio."
                return
            }
            playing = true
            notice = nil
            playbackTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(250))
                    guard let self else { return }
                    if self.player?.isPlaying != true { self.stop(); return }
                }
            }
        } catch {
            stop()
            notice = "This recording could not be played. You can still export the saved audio."
        }
    }

    func stop() {
        playbackGeneration += 1
        let activated = sessionActivated
        sessionActivated = false
        playbackTask?.cancel()
        playbackTask = nil
        player?.stop()
        player = nil
        playing = false
        if activated { AudioSessionHandoff.deactivateOffMain() }
    }

    func transcribe() async {
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            var id = entry.serverID
            var origin = entry.archiveOrigin
            if id == nil, let local = entry.local, let audioURL {
                let archived = try await api.archiveVoice(audioURL: audioURL, recording: local)
                try store.markBackup(id: local.id, serverID: archived.id, primarySaved: archived.primarySaved, origin: archived.archiveOrigin, storage: archived.storage)
                id = archived.id
                origin = archived.archiveOrigin
            }
            guard let id else {
                notice = "No audio is available for transcription."
                return
            }
            let result = try await api.transcribeArchivedVoice(id: id, origin: origin)
            guard result.recordingID?.lowercased() == id.lowercased() else { throw APIError.badResponse }
            if let local = entry.local, !result.text.isEmpty {
                try store.saveTranscription(id: local.id, text: result.text)
            }
            let remote = VoiceArchiveRecord(
                id: id, createdAt: ISO8601DateFormatter().string(from: entry.createdAt),
                format: entry.remote?.format ?? entry.local?.format ?? "caf",
                durationSeconds: entry.duration, surface: entry.local?.surface ?? entry.remote?.surface,
                audioSizeBytes: entry.remote?.audioSizeBytes ?? entry.local?.bytes ?? 0,
                audioSha256: entry.remote?.audioSha256, text: result.text.isEmpty ? nil : result.text,
                via: entry.remote?.via, state: result.text.isEmpty ? "saved" : "transcribed",
                primarySaved: result.primarySaved, storage: result.storage, archiveOrigin: result.archiveOrigin ?? origin
            )
            entry = VoiceHistoryEntry(id: entry.id, local: entry.local, remote: remote)
            notice = result.text.isEmpty ? "No speech was recognized. The recording is still saved." : nil
            await refresh()
        } catch {
            notice = "Transcription did not finish. The recording is still saved; try again later."
        }
    }
}

struct VoiceHistoryDetailView: View {
    @State private var model: VoiceHistoryDetailModel
    @State private var copied = false
    @State private var sync = VoiceHistorySync.shared

    init(entry: VoiceHistoryEntry) {
        _model = State(initialValue: VoiceHistoryDetailModel(entry: entry))
    }

    var body: some View {
        List {
            Section("Recording") {
                LabeledContent("Recorded") {
                    Text(model.entry.createdAt, format: .dateTime.year().month().day().hour().minute())
                }
                if let duration = model.entry.duration {
                    LabeledContent("Length", value: VoiceRecordingIndicator.timeString(duration))
                }
                Text(model.entry.status).font(.footnote).foregroundStyle(.primary)
                Button(model.playing ? "Stop Playback" : "Play Recording", systemImage: model.playing ? "stop.fill" : "play.fill") {
                    Task { await model.togglePlayback() }
                }
                .disabled(model.working)
                .accessibilityIdentifier("voiceHistory.play")
                if let audioURL = model.audioURL {
                    ShareLink(item: audioURL) { Label("Export Recording", systemImage: "square.and.arrow.up") }
                        .accessibilityIdentifier("voiceHistory.exportAudio")
                } else if model.entry.serverID != nil {
                    Button("Download Recording", systemImage: "arrow.down.circle") { Task { await model.loadAudio() } }
                        .disabled(model.working)
                }
            }
            Section("Transcript") {
                if let text = model.entry.text, !text.isEmpty {
                    Text(text)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("voiceHistory.transcript")
                    Button(copied ? "Copied" : "Copy Transcript", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = text
                        copied = true
                    }
                    .accessibilityIdentifier("voiceHistory.copy")
                    ShareLink(item: text) { Label("Export Transcript", systemImage: "square.and.arrow.up") }
                } else {
                    Text("No transcript yet. The original recording is kept.")
                        .foregroundStyle(.secondary)
                    Button("Transcribe Recording", systemImage: "text.bubble") {
                        Task { await model.transcribe() }
                    }
                    .disabled(model.working || model.entry.local?.reason == "recording")
                    .accessibilityIdentifier("voiceHistory.transcribe")
                }
            }
            if model.working { ProgressView().frame(maxWidth: .infinity) }
            if let notice = model.notice {
                Section { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Voice Recording")
        .navigationBarTitleDisplayMode(.inline)
        .barPage(Color(uiColor: .systemGroupedBackground))
        .task { await model.refresh() }
        .onChange(of: sync.revision) { _, _ in Task { await model.refresh() } }
        .onDisappear { model.stop() }
    }
}
