import Observation
import SwiftUI

struct VoiceHistoryEntry: Identifiable {
    let id: String
    let local: VoiceRecordingStore.Recording?
    let remote: VoiceArchiveRecord?

    var text: String? { local?.transcript ?? remote?.text }
    var audioURL: URL? {
        guard let url = local?.audioURL, FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }
    var createdAt: Date {
        local?.createdAt ?? remote.flatMap { WalnutTask.parseISO($0.createdAt) } ?? .distantPast
    }
    var duration: Double? { local?.durationSeconds ?? remote?.durationSeconds }
    var serverID: String? { remote?.id ?? local?.serverID }
    var archiveOrigin: String? { remote?.archiveOrigin ?? local?.archiveOrigin }
    var status: String {
        if remote?.state == "uploading" { return "Backup incomplete. Original audio is kept on iPhone." }
        if remote != nil || local?.archiveState == "saved" {
            let storage = remote?.storage ?? local?.archiveStorage
            if storage == "primary" {
                return audioURL == nil ? "Saved on Mac. Cloud copy pending." : "Saved on iPhone and Mac. Cloud copy pending."
            }
            if (remote?.primarySaved ?? local?.primarySaved) == false {
                return audioURL == nil ? "Saved on server. Mac copy pending." : "Saved on iPhone and server. Mac copy pending."
            }
            if storage == "companion", (remote?.primarySaved ?? local?.primarySaved) == true {
                return audioURL == nil ? "Saved on server and Mac." : "Saved on iPhone, server and Mac."
            }
            return audioURL == nil ? "Saved on server." : "Saved on iPhone and server."
        }
        return "Saved on iPhone. Backup pending."
    }

    static func merge(
        local: [VoiceRecordingStore.Recording], remote: [VoiceArchiveRecord]
    ) -> [VoiceHistoryEntry] {
        let localByID = Dictionary(local.map { (($0.serverID ?? $0.id).lowercased(), $0) }, uniquingKeysWith: { a, _ in a })
        let remoteByID = Dictionary(remote.map { ($0.id.lowercased(), $0) }, uniquingKeysWith: { a, _ in a })
        return Set(localByID.keys).union(remoteByID.keys).map {
            VoiceHistoryEntry(id: $0, local: localByID[$0], remote: remoteByID[$0])
        }.sorted { $0.createdAt > $1.createdAt }
    }
}

@Observable
@MainActor
final class VoiceHistoryModel {
    private(set) var entries: [VoiceHistoryEntry] = []
    private(set) var loading = false
    private(set) var notice: String?
    private(set) var nextBefore: String?
    @ObservationIgnored private var local: [VoiceRecordingStore.Recording] = []
    @ObservationIgnored private var remote: [VoiceArchiveRecord] = []
    @ObservationIgnored private lazy var api = WalnutAPI()
    @ObservationIgnored private let store: VoiceRecordingStore
    #if DEBUG
    @ObservationIgnored var _testPage: ((String?) async throws -> VoiceArchivePage)?
    #endif

    init(store: VoiceRecordingStore = .shared) { self.store = store }

    func refresh(more: Bool = false, preservingLoaded: Bool = false) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        let store = store
        local = await Task.detached(priority: .utility) { store.history() }.value
        entries = VoiceHistoryEntry.merge(local: local, remote: remote.filter { $0.state != "uploading" })
        guard AppConfig.isConfigured else { return }
        do {
            let page: VoiceArchivePage
            #if DEBUG
            if let override = _testPage {
                page = try await override(more ? nextBefore : nil)
            } else {
                page = try await api.voiceHistory(before: more ? nextBefore : nil)
            }
            #else
            page = try await api.voiceHistory(before: more ? nextBefore : nil)
            #endif
            if more || preservingLoaded {
                let updated = Set(page.recordings.map { $0.id.lowercased() })
                remote = remote.filter { !updated.contains($0.id.lowercased()) } + page.recordings
            } else {
                remote = page.recordings
            }
            if more || !preservingLoaded || remote.count <= page.recordings.count {
                nextBefore = page.nextBefore
            }
            notice = nil
        } catch {
            notice = "Server history is unavailable. Recordings saved on this iPhone are still here."
        }
        entries = VoiceHistoryEntry.merge(local: local, remote: remote.filter { $0.state != "uploading" })
    }
}

struct VoiceHistoryView: View {
    @State private var model = VoiceHistoryModel()
    @State private var sync = VoiceHistorySync.shared

    var body: some View {
        List {
            Section {
                Text("Recordings and transcribed text are kept, even if Walnut closes or a message cannot be sent.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let notice = model.notice ?? sync.lastError {
                Section {
                    Text(notice).font(.footnote)
                    Button("Try Backup Again") { sync.kick(); Task { await model.refresh() } }
                        .disabled(sync.syncing)
                        .accessibilityIdentifier("voiceHistory.sync")
                }
            }
            if model.entries.isEmpty && !model.loading {
                ContentUnavailableView("No Recordings Yet", systemImage: "waveform", description: Text("Your voice input will appear here."))
            }
            Section {
                ForEach(model.entries) { entry in
                    NavigationLink {
                        VoiceHistoryDetailView(entry: entry)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(entry.createdAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                                Spacer()
                                if let duration = entry.duration {
                                    Text(VoiceRecordingIndicator.timeString(duration)).monospacedDigit()
                                }
                            }
                            Text(entry.text.flatMap { $0.isEmpty ? nil : $0 } ?? "Recording saved. No transcript yet.")
                                .lineLimit(2)
                                .font(.subheadline)
                            Text(entry.status).font(.caption).foregroundStyle(.primary)
                        }
                        .padding(.vertical, 4)
                    }
                    .accessibilityIdentifier("voiceHistory.recording.\(entry.id)")
                }
                if model.nextBefore != nil {
                    Button("Load Earlier") { Task { await model.refresh(more: true) } }
                        .disabled(model.loading)
                        .accessibilityIdentifier("voiceHistory.loadEarlier")
                }
            }
            if model.loading { ProgressView().frame(maxWidth: .infinity) }
        }
        .navigationTitle("Past Voice")
        .navigationBarTitleDisplayMode(.inline)
        .barPage(Color(uiColor: .systemGroupedBackground))
        .task { await model.refresh(); sync.kick() }
        .refreshable { await model.refresh(); sync.kick() }
        .onChange(of: sync.revision) { _, _ in Task { await model.refresh(preservingLoaded: true) } }
        .accessibilityIdentifier("voiceHistory.list")
    }
}
