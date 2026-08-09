import SwiftUI

/// Session file browser (Wave 2 /v1/files/list + /v1/file-content) — lazy
/// directory drill-down starting at the session's cwd, with a text viewer.
/// Cloud replica: listing relays over the bridge; file CONTENT deliberately
/// never rides the bridge, so reads answer 501 → "open it on your Mac" copy.
struct SessionFilesSheet: View {
    let session: WalnutSession

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let cwd = session.cwd {
                    SessionDirectoryList(
                        path: cwd,
                        host: session.host,
                        title: displayName(of: cwd)
                    )
                } else {
                    ContentUnavailableView {
                        Label("No working directory", systemImage: "folder.badge.questionmark")
                    } description: {
                        Text("This session has no recorded working directory to browse.")
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
    }

    private func displayName(of path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}

/// One directory level — pushes deeper levels onto the enclosing stack.
struct SessionDirectoryList: View {
    let path: String
    let host: String
    let title: String

    private let api = WalnutAPI()

    @State private var entries: [SessionFileEntry] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var selectedFile: SessionFileEntry?

    var body: some View {
        List {
            if !loaded {
                HStack { ProgressView(); Text("Loading…").foregroundStyle(.secondary) }
            } else if let loadError {
                VStack(spacing: 8) {
                    Text(loadError)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Retry") { Task { await load() } }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.tint)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            } else if entries.isEmpty {
                Text("Empty directory.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
            } else {
                ForEach(entries) { entry in
                    if entry.isDirectory {
                        NavigationLink {
                            SessionDirectoryList(
                                path: entry.absolutePath(in: path), host: host, title: entry.name
                            )
                        } label: {
                            Label(entry.name, systemImage: "folder")
                        }
                        .accessibilityIdentifier("session.files.dir.\(entry.name)")
                    } else {
                        Button {
                            selectedFile = entry
                        } label: {
                            HStack {
                                Label(entry.name, systemImage: "doc.text")
                                    .foregroundStyle(.primary)
                                Spacer()
                                if let size = entry.size {
                                    Text(Self.sizeText(size))
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("session.files.file.\(entry.name)")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("session.files.list")
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $selectedFile) { file in
            SessionFileViewer(name: file.name, path: file.absolutePath(in: path), host: host)
        }
    }

    private func load() async {
        do {
            let response = try await api.listFiles(path: path, host: host.isEmpty ? nil : host)
            entries = response.entries
            loadError = nil
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            loadError = Self.friendlyFilesError(error)
        }
        loaded = true
    }

    static func sizeText(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1_048_576 { return String(format: "%.1f KB", Double(bytes) / 1024) }
        return String(format: "%.1f MB", Double(bytes) / 1_048_576)
    }

    /// Honest copy for the files failure ladder (incl. the cloud 501).
    static func friendlyFilesError(_ error: Error) -> String {
        guard let apiError = error as? APIError else { return error.localizedDescription }
        switch apiError.code {
        case "not_supported_cloud":
            return "File contents can't be read through the cloud companion — open this on your Mac."
        case "bridge_offline":
            return "The primary box isn't reachable right now — try again when it reconnects."
        case "session_control_needs_upgrade":
            return "Your primary box is upgrading for mobile file browsing — try again in a minute."
        default:
            return apiError.localizedDescription
        }
    }
}

/// Plain-text file viewer over GET /v1/file-content. Binary and too-large
/// states degrade to clear copy; a missing file is a 200 with `error` set.
struct SessionFileViewer: View {
    let name: String
    let path: String
    let host: String

    @Environment(\.dismiss) private var dismiss
    private let api = WalnutAPI()

    @State private var content: SessionFileContent?
    @State private var loaded = false
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                if !loaded {
                    HStack { ProgressView(); Text("Loading…").foregroundStyle(.secondary) }
                        .padding(.top, 40)
                } else if let loadError {
                    ContentUnavailableView {
                        Label("Can't open file", systemImage: "doc.questionmark")
                    } description: {
                        Text(loadError)
                    }
                    .padding(.top, 40)
                } else if let content {
                    if let serverError = content.error {
                        ContentUnavailableView {
                            Label("Can't open file", systemImage: "doc.questionmark")
                        } description: {
                            Text(serverError)
                        }
                        .padding(.top, 40)
                    } else if content.binary == true {
                        ContentUnavailableView {
                            Label("Binary file", systemImage: "doc.zipper")
                        } description: {
                            Text("This file isn't text — open it on your Mac.")
                        }
                        .padding(.top, 40)
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            if content.truncated == true {
                                Label("Large file — showing the first 512 KB.", systemImage: "scissors")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Text(content.content ?? "")
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(12)
                    }
                }
            }
            .navigationTitle(name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .accessibilityIdentifier("session.files.viewer")
            .task { await load() }
        }
    }

    private func load() async {
        do {
            content = try await api.fileContent(path: path, host: host.isEmpty ? nil : host)
        } catch let error as APIError where error.isCancelled {
            return
        } catch let error as APIError where error.code == "too_large" {
            loadError = "This file is too large to view on the phone."
        } catch {
            loadError = SessionDirectoryList.friendlyFilesError(error)
        }
        loaded = true
    }
}
