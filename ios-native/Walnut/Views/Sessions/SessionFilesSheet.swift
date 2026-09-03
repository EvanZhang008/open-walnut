import SwiftUI

/// Session file browser (Wave 2 /v1/files/list + /v1/file-content) — lazy
/// directory drill-down starting at the session's cwd, with a text viewer.
/// Cloud replica: BOTH listing and content relay to the Mac — listing over the
/// box-level control action, content over the narrow `fs.readBounded` bridge
/// command (2 MB cap + path sandbox, enforced host-side). The 501
/// "open it on your Mac" copy is now only the OLD-DAEMON case, and it
/// self-heals on the primary's next auto-deploy.
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

/// A directory a MESSAGE mentioned ("the work is under /Users/me/repo/src"),
/// opened at that path. Deliberately no new browser: it is the same
/// `SessionDirectoryList` the session file browser uses, just rooted somewhere
/// else, wrapped in the NavigationStack its drill-down links need.
struct DirectoryTarget: Identifiable, Equatable {
    let path: String
    /// nil/"" = the primary box; otherwise the session's exec-host alias.
    let host: String?

    init(path: String, host: String? = nil) {
        self.path = path
        self.host = host
    }

    var id: String { "\(host ?? "")\u{1}\(path)" }
}

struct DirectoryPreviewSheet: View {
    let target: DirectoryTarget

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SessionDirectoryList(
                path: target.path,
                host: target.host ?? "",
                title: (target.path as NSString).lastPathComponent
            )
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
    }
}

/// One directory level — pushes deeper levels onto the enclosing stack.
///
/// `path` is what was ASKED FOR; `root` is what the server actually listed. They
/// differ whenever a message mentions a file with no extension
/// (`/usr/local/bin/node`), which the linkifier reads as a directory: the server
/// lists the parent and names the file. Titling and drilling from the requested
/// path in that case produced a listing of `/usr/bin` called "jq", opening at
/// "aa", with nothing on screen mentioning jq — an answer to a question nobody
/// asked. Everything below reads `root`, and the named file is scrolled to and
/// marked.
struct SessionDirectoryList: View {
    let path: String
    let host: String
    let title: String

    private let api = WalnutAPI()

    @State private var entries: [SessionFileEntry] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var selectedFile: SessionFileEntry?
    /// The directory the server listed, once it has told us.
    @State private var serverPath: String?
    /// The file the requested path turned out to be, if any.
    @State private var namedFile: String?

    /// Where children live and what gets titled. Falls back to the request
    /// while in flight, so the header does not flicker.
    private var root: String { Self.effectiveRoot(requested: path, serverPath: serverPath) }

    /// The requested path pointed at a FILE, so this listing is a stand-in.
    private var isStandIn: Bool { namedFile != nil && root != path }

    private var displayTitle: String {
        Self.title(requested: path, requestedTitle: title, serverPath: serverPath)
    }

    var body: some View {
        ScrollViewReader { proxy in
            listBody
                .task(id: namedFile) {
                    guard let namedFile else { return }
                    // One beat for the rows to exist before asking for one, then a
                    // retry: `/usr/bin` is ~1000 rows and a List realises lazily,
                    // so a first attempt at a row far down can land short. Same
                    // reason the file viewer's anchor scrolls twice.
                    try? await Task.sleep(for: .milliseconds(80))
                    guard !Task.isCancelled else { return }
                    proxy.scrollTo(namedFile, anchor: .center)
                    try? await Task.sleep(for: .milliseconds(250))
                    guard !Task.isCancelled else { return }
                    proxy.scrollTo(namedFile, anchor: .center)
                }
        }
    }

    @ViewBuilder
    private var listBody: some View {
        List {
            if isStandIn, let namedFile {
                Label("\(namedFile) is a file, not a folder — showing \(root), with it highlighted.",
                      systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("session.files.standInNotice")
            }
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
                                path: entry.absolutePath(in: root), host: host, title: entry.name
                            )
                        } label: {
                            Label(entry.name, systemImage: "folder")
                        }
                        .id(entry.name)
                        .listRowBackground(rowBackground(entry))
                        .accessibilityIdentifier("session.files.dir.\(entry.name)")
                    } else {
                        Button {
                            selectedFile = entry
                        } label: {
                            HStack {
                                Label(entry.name, systemImage: "doc.text")
                                    .foregroundStyle(.primary)
                                Spacer()
                                if entry.name == namedFile {
                                    Image(systemName: "arrow.left.circle.fill")
                                        .foregroundStyle(Theme.tint)
                                        .accessibilityLabel("the path you tapped")
                                } else if let size = entry.size {
                                    Text(Self.sizeText(size))
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .id(entry.name)
                        .listRowBackground(rowBackground(entry))
                        .accessibilityIdentifier("session.files.file.\(entry.name)")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("session.files.list")
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $selectedFile) { file in
            SessionFileViewer(name: file.name, path: file.absolutePath(in: root), host: host)
        }
    }

    /// nil restores the system row background, so an ordinary listing looks
    /// exactly as it did before this existed.
    private func rowBackground(_ entry: SessionFileEntry) -> Color? {
        entry.name == namedFile ? Theme.tint.opacity(0.14) : nil
    }

    private func load() async {
        do {
            let response = try await api.listFiles(path: path, host: host.isEmpty ? nil : host)
            entries = response.entries
            // Adopt the server's answer, not the question. An empty `path` would
            // be a server that told us nothing, so keep the request in that case.
            serverPath = response.path.isEmpty ? path : response.path
            namedFile = response.selectedFile
            loadError = nil
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            loadError = Self.friendlyFilesError(error)
        }
        loaded = true
    }

    /// The directory every child path and the title are built from. Pulled out
    /// of the view because the choice of base IS the defect: the requested path
    /// is a guess, the server's answer is the fact.
    static func effectiveRoot(requested: String, serverPath: String?) -> String {
        guard let serverPath, !serverPath.isEmpty else { return requested }
        return serverPath
    }

    /// What the header should read, given a request and the server's answer.
    static func title(requested: String, requestedTitle: String, serverPath: String?) -> String {
        let root = effectiveRoot(requested: requested, serverPath: serverPath)
        guard root != requested else { return requestedTitle }
        let leaf = (root as NSString).lastPathComponent
        return leaf.isEmpty ? root : leaf
    }

    static func sizeText(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1_048_576 { return String(format: "%.1f KB", Double(bytes) / 1024) }
        return String(format: "%.1f MB", Double(bytes) / 1_048_576)
    }

    /// Honest copy for the files failure ladder. ONE mapping, shared with the
    /// WKWebView preview (`FilePreviewLink.friendlyMessage`), keyed on STATUS:
    /// the server reuses the `not_supported_cloud` code for both 403 (a secret
    /// path, refused forever) and 501 (an old daemon, fixed on the next
    /// reconnect), so the code alone told half of those readers the wrong thing.
    static func friendlyFilesError(_ error: Error) -> String {
        FilePreviewLink.friendlyMessage(for: error)
    }
}

/// Plain-text file viewer over GET /v1/file-content, for ANY absolute path —
/// a file picked out of the browser above, or a path a message mentioned and the
/// reader tapped. Binary and too-large states degrade to clear copy; a missing
/// file is a 200 with `error` set. HTML files default to a rendered WKWebView
/// preview (raw=1 URL — the same document the web console's preview iframe
/// loads), with a Source toggle falling back to this text body.
///
/// Two things beyond "show the bytes", both of which are what makes a tapped
/// path feel like opening the reference rather than opening a file:
///  - `ref` carries the POSITION (`foo.ts:2400`), and the body scrolls to it
///    with a gutter and a brief highlight (`FileSourceLinesView`).
///  - `cwd`/`sessionID` let a path that does not exist be re-resolved
///    host-side (`files/resolve-path`) and retried, so a path written from a
///    different working directory — or a file that has since moved — still
///    opens instead of dead-ending.
struct SessionFileViewer: View {
    let name: String
    let path: String
    let host: String
    /// Position the reference named, if any.
    var ref: FilePathRef? = nil
    /// Session context for the self-heal retry. Absent = no retry (the browser
    /// path is already a listing hit, so it cannot be stale).
    var cwd: String? = nil
    var sessionID: String? = nil

    @Environment(\.dismiss) private var dismiss
    private let api = WalnutAPI()

    @State private var content: SessionFileContent?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var showSource = false
    /// Set when the resolver found the file somewhere else.
    @State private var healedPath: String?
    @State private var healedNotice: String?
    @State private var anchorLine: Int?
    @State private var anchorEndLine: Int?

    /// What is actually on screen: the requested path, or what the resolver
    /// found instead.
    private var shownPath: String { healedPath ?? path }
    private var hostParam: String? { host.isEmpty ? nil : host }
    private var isHTMLPreviewable: Bool { FilePreviewLink.isPreviewablePath(shownPath) }

    var body: some View {
        NavigationStack {
            Group {
                if isHTMLPreviewable && !showSource {
                    HTMLFilePreview(path: shownPath, host: hostParam)
                } else {
                    sourceBody
                }
            }
            .navigationTitle(name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if isHTMLPreviewable {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(showSource ? "Preview" : "Source") { showSource.toggle() }
                            .accessibilityIdentifier("session.files.viewer.sourceToggle")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .accessibilityIdentifier("session.files.viewer")
        }
    }

    @ViewBuilder
    private var sourceBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !loaded {
                HStack { ProgressView(); Text("Loading…").foregroundStyle(.secondary) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .padding(.top, 40)
            } else if let loadError {
                unavailable("Can't open file", icon: "doc.questionmark", detail: loadError)
            } else if let content {
                if let serverError = content.error {
                    unavailable("Can't open file", icon: "doc.questionmark", detail: serverError)
                } else if content.binary == true {
                    unavailable("Binary file", icon: "doc.zipper",
                                detail: "This file isn't text — open it on your Mac.")
                } else {
                    notices(for: content)
                    FileSourceLinesView(
                        content: content.content ?? "",
                        anchorLine: anchorLine,
                        anchorEndLine: anchorEndLine
                    )
                }
            }
        }
        .task { await load() }
    }

    private func unavailable(_ title: String, icon: String, detail: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: icon)
        } description: {
            Text(detail)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Above-the-body banners: a server clip, and a self-heal that changed which
    /// file this is. The heal notice is NOT optional politeness — the reader
    /// asked for one path and is looking at another, and silently swapping it
    /// would be the "confident wrong answer" failure mode.
    @ViewBuilder
    private func notices(for content: SessionFileContent) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let healedNotice {
                Label(healedNotice, systemImage: "arrow.triangle.branch")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if content.truncated == true {
                Label("Large file — showing the first 512 KB.", systemImage: "scissors")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, healedNotice == nil && content.truncated != true ? 0 : 8)
    }

    private func load() async {
        guard !loaded else { return }
        anchorLine = ref?.line
        anchorEndLine = ref?.endLine
        var firstMessage: String?
        // Only a "wrong path" shape is worth re-resolving. 403/413/501/503 are
        // honest statements about a path that DOES exist, and re-resolving one
        // would just replace a true answer with a guess.
        var pathLooksWrong = false
        do {
            let payload = try await api.fileContent(path: path, host: hostParam)
            if payload.error == nil {
                content = payload
                loaded = true
                return
            }
            pathLooksWrong = true
            firstMessage = payload.error
        } catch let error as APIError where error.isCancelled {
            return
        } catch let error as APIError {
            if case .server(let status, _, _, _, _) = error, status == 400 || status == 404 {
                pathLooksWrong = true
            }
            firstMessage = FilePreviewLink.friendlyMessage(for: error)
        } catch {
            firstMessage = error.localizedDescription
        }

        if pathLooksWrong, let healed = await resolve() {
            do {
                let payload = try await api.fileContent(path: healed.path, host: hostParam)
                if payload.error == nil {
                    content = payload
                    healedPath = healed.path
                    healedNotice = "The path in the message wasn't there — opened \(healed.path) instead."
                    anchorLine = healed.line ?? anchorLine
                    anchorEndLine = healed.endLine ?? anchorEndLine
                    loaded = true
                    return
                }
            } catch let error as APIError where error.isCancelled {
                return
            } catch {
                // Keep the FIRST failure's copy: it described the thing the
                // reader actually asked for.
            }
        }
        loadError = firstMessage ?? "Couldn't read that file."
        loaded = true
    }

    /// Ask the host where this reference really lives. The phone has never
    /// called this endpoint before; it is the only layer that can see the
    /// session transcript and the host's git index, which is exactly what fixes
    /// a path written from another cwd.
    private func resolve() async -> FilePathRef? {
        guard let cwd, !cwd.isEmpty else { return nil }
        do {
            let resolution = try await api.resolvePath(
                rel: ref?.decorated ?? path, cwd: cwd, host: hostParam, sessionID: sessionID)
            guard resolution.resolved, !resolution.path.isEmpty, resolution.path != path else { return nil }
            return FilePathRef(path: resolution.path,
                               line: resolution.line ?? ref?.line,
                               endLine: resolution.endLine ?? ref?.endLine,
                               column: resolution.column ?? ref?.column,
                               raw: ref?.raw)
        } catch {
            return nil
        }
    }
}
