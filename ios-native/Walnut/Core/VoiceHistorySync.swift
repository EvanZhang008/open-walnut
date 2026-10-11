import Foundation
import Observation
import UIKit

@Observable
@MainActor
final class VoiceHistorySync {
    static let shared = VoiceHistorySync()
    private(set) var syncing = false
    private(set) var lastError: String?
    private(set) var revision = 0
    @ObservationIgnored private var api: WalnutAPI?
    @ObservationIgnored private var activeObserver: NSObjectProtocol?
    @ObservationIgnored private var recovered = false
    @ObservationIgnored private let launchedAt = Date()
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var requestedAgain = false

    func start() {
        guard activeObserver == nil,
              !InstallMarker.isHostedUnitTestProcess else { return }
        activeObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.kick() }
        }
        kick()
    }

    func kick() {
        if syncing { requestedAgain = true; return }
        guard AppConfig.isConfigured, !DemoMode.isActive,
              !InstallMarker.isHostedUnitTestProcess,
              UIApplication.shared.isProtectedDataAvailable else { return }
        syncing = true
        task = Task {
            defer {
                syncing = false
                task = nil
                revision += 1
                if requestedAgain { requestedAgain = false; kick() }
            }
            let store = VoiceRecordingStore.shared
            if !recovered {
                let launchedAt = launchedAt
                await Task.detached(priority: .utility) {
                    for recording in store.history() where recording.reason == "recording" && recording.createdAt < launchedAt {
                        store.preserve(id: recording.id, reason: "interrupted")
                    }
                }.value
                recovered = true
            }
            let recordings = await Task.detached(priority: .utility) { store.history() }.value
            lastError = nil
            if api == nil { api = WalnutAPI() }
            guard let api else { return }
            for recording in recordings where recording.reason != "recording" {
                do {
                    let cloud = AppConfig.routes.first(where: { $0.kind == .cloud })?.origin
                    if let cloud, recording.archiveState == "saved",
                       !ServerRoute.sameOrigin(recording.archiveOrigin, cloud), recording.audioAvailable {
                        var cloudCopy = recording
                        cloudCopy.archiveOrigin = cloud
                        let remote = try await api.archiveVoice(audioURL: recording.audioURL, recording: cloudCopy)
                        try store.markBackup(id: recording.id, serverID: remote.id, primarySaved: remote.primarySaved, origin: remote.archiveOrigin, storage: remote.storage)
                        if recording.transcript == nil, let text = remote.text, !text.isEmpty {
                            try store.saveRecoveredTranscription(id: recording.id, text: text)
                        }
                        continue
                    }
                    if recording.archiveState == "saved", let id = recording.serverID {
                        var remote: VoiceArchiveRecord
                        do {
                            remote = try await api.voiceRecording(id: id, origin: recording.archiveOrigin)
                        } catch let APIError.server(status, _, _, _, _) where status == 404 {
                            remote = try await api.archiveVoice(audioURL: recording.audioURL, recording: recording)
                        } catch let error as APIError where VoiceRetryPlan.classify(error) == .transport && recording.audioAvailable {
                            remote = try await api.archiveVoice(audioURL: recording.audioURL, recording: recording)
                        }
                        if let text = recording.transcript, remote.text == nil {
                            remote = try await api.saveVoiceTranscript(id: id, text: text, origin: remote.archiveOrigin)
                        }
                        try store.markBackup(id: recording.id, serverID: remote.id, primarySaved: remote.primarySaved, origin: remote.archiveOrigin, storage: remote.storage)
                        if recording.transcript == nil, let text = remote.text, !text.isEmpty {
                            try store.saveRecoveredTranscription(id: recording.id, text: text)
                        }
                        continue
                    }
                    guard FileManager.default.fileExists(atPath: recording.audioURL.path) else { continue }
                    let remote = try await api.archiveVoice(audioURL: recording.audioURL, recording: recording)
                    try store.markBackup(id: recording.id, serverID: remote.id, primarySaved: remote.primarySaved, origin: remote.archiveOrigin, storage: remote.storage)
                    if recording.transcript == nil, let text = remote.text, !text.isEmpty {
                        try store.saveRecoveredTranscription(id: recording.id, text: text)
                    }
                    revision += 1
                } catch {
                    try? store.noteBackupFailure(id: recording.id, message: error.localizedDescription)
                    lastError = "Backup hasn't finished. Recordings and text are kept on this iPhone."
                    AppLog.warn("voice", "archive backup pending", ["id": recording.id, "error": error.localizedDescription])
                }
            }
        }
    }
}
