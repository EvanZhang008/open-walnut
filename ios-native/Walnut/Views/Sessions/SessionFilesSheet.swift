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
                Label("\(namedFile) is a file, not a folder. Showing \(root), with it highlighted.",
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
        .sessionFileSheet(item: $selectedFile) { file in
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
            // WITH the host. Dropping it here is what made every failed listing on
            // a remote box read as a statement about the reader's Mac — the exact
            // thing `FileReadFailure` carries a host to prevent.
            loadError = Self.friendlyFilesError(error, host: host.isEmpty ? nil : host)
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
    /// `host` is the box the listing was aimed at. Optional, because one caller
    /// (the contract test's cloud-501 case) genuinely does not know one — and
    /// that is exactly why the copy has to stay host-neutral rather than default
    /// to the reader's Mac.
    static func friendlyFilesError(_ error: Error, host: String? = nil) -> String {
        FilePreviewLink.failure(for: error, host: host).message
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
    /// The tapped path was found on another host than the session's
    /// (`ClickedPath.locate`): named above the file.
    var hostNote: String? = nil
    /// No host has the tapped path: this line instead of a read.
    var missingNote: String? = nil
    /// No machine is known for the tapped path (`ClickedPath.unreachableSource`): under the
    /// missing line, the user's machines to open it from. Nothing is picked or probed for them.
    var unknownSource = false

    @Environment(\.dismiss) private var dismiss
    @Environment(TasksStore.self) private var tasks: TasksStore?
    private let api = WalnutAPI()

    /// What the user's pick of a machine found (`ClickedPath.locate`), shown in place of the
    /// tapped target it was picked for (`inputKey`); nil until they pick. Kept with that key, so
    /// another tapped target never shows it, not even for the one render before `onChange`.
    @State private var picked: Picked?
    @State private var pickedDirectory: DirectoryTarget?
    /// The machine being looked up now ("" = Local), and its lookup: a newer pick, a path change
    /// or closing the viewer cancels it, so a late answer never replaces what is shown.
    @State private var picking: String?
    @State private var pickTask: Task<Void, Never>?
    @State private var pickSeq = 0
    /// Bumped by every new target, so its read always starts over (`shownKey`).
    @State private var readGen = 0
    /// The user's configured machines (`GET /sessions/launch-options`), read once the picker shows:
    /// a list only, it locates and reads nothing. nil while it loads; `hostsFailed` when it could not.
    @State private var launchHosts: [SessionLaunchOptions.Host]?
    @State private var hostsFailed = false

    /// The target on screen: the tapped one, or what a picked machine answered.
    struct Shown: Equatable {
        var name: String
        var path: String
        var host: String
        var ref: FilePathRef?
        var cwd: String?
        var sessionID: String?
        var hostNote: String?
        var missing: String?
        var unknownSource: Bool
    }

    struct Picked: Equatable {
        let inputKey: String
        let target: Shown
    }

    private static func refKey(_ ref: FilePathRef?) -> [String] {
        [ref?.raw ?? "", ref?.line.map(String.init) ?? "", ref?.endLine.map(String.init) ?? "",
         ref?.column.map(String.init) ?? ""]
    }

    /// The tapped target as given: every field of it, so a change of any one is another target.
    private var inputKey: String {
        ([name, path, host, cwd ?? "", sessionID ?? "", hostNote ?? "", missingNote ?? "", unknownSource ? "1" : "0"]
            + Self.refKey(ref)).joined(separator: "\u{1}")
    }

    /// The target on screen, and the read it was given (`readGen`): what a read is kept for.
    private var shownKey: String {
        ([String(readGen), shown.path, shown.host, shown.cwd ?? "", shown.sessionID ?? "", shown.missing ?? ""]
            + Self.refKey(shown.ref)).joined(separator: "\u{1}")
    }

    private var shown: Shown {
        if let picked, picked.inputKey == inputKey { return picked.target }
        return Shown(name: name, path: path, host: host, ref: ref, cwd: cwd, sessionID: sessionID,
                     hostNote: hostNote, missing: missingNote, unknownSource: unknownSource)
    }

    /// The read below belongs to the target on screen: content, failure and heal of any other
    /// target are never drawn, not even for the one render before a new read starts.
    @State private var readKey: String?
    private var readIsCurrent: Bool { readKey == shownKey }
    private var liveLoaded: Bool { readIsCurrent && loaded }
    private var liveFailure: FileReadFailure? { readIsCurrent ? loadFailure : nil }
    private var liveContent: SessionFileContent? { readIsCurrent ? content : nil }
    private var liveHealedNotice: String? { readIsCurrent ? healedNotice : nil }

    @State private var content: SessionFileContent?
    @State private var loaded = false
    /// The whole failure, not just its sentence: the empty state needs the
    /// headline and the retry decision too.
    @State private var loadFailure: FileReadFailure?
    /// Source or preview of an HTML file: the reader's pick, kept (`ViewMemory`).
    @AppStorage(ViewMemory.key("files", "showSource"), store: AppPrefs.defaults) private var showSource = false
    /// Set when the resolver found the file somewhere else.
    @State private var healedPath: String?
    @State private var healedNotice: String?
    @State private var anchorLine: Int?
    @State private var anchorEndLine: Int?

    /// What is actually on screen: the requested path, or what the resolver
    /// found instead.
    private var shownPath: String { (readIsCurrent ? healedPath : nil) ?? shown.path }
    private var hostParam: String? { shown.host.isEmpty ? nil : shown.host }
    private var isHTMLPreviewable: Bool { FilePreviewLink.isPreviewablePath(shownPath) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let hostNote = shown.hostNote, shown.missing == nil {
                    Label(hostNote, systemImage: "desktopcomputer")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("session.files.viewer.hostNote")
                }
                VStack(spacing: 0) {
                    if let missingNote = shown.missing {
                        ContentUnavailableView {
                            // Before any pick the machine is a question to answer, not a missing file.
                            if shown.unknownSource && picked?.inputKey != inputKey {
                                Label("Choose a machine", systemImage: "desktopcomputer")
                            } else {
                                Label("Not Found", systemImage: "questionmark.folder")
                            }
                        } description: {
                            // On the line itself: an identifier on the container is overwritten by the
                            // viewer's own, which the container folds into.
                            Text(missingNote)
                                .accessibilityIdentifier("session.files.viewer.missing")
                        } actions: {
                            if shown.unknownSource { machinePicker }
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if AttachmentLoader.isFileImage(shownPath) {
                        // From the machine this viewer names (a lookup confirmed it, or the user
                        // picked it), never through the media route's primary-first read.
                        SourceFileImageView(path: shownPath, host: shown.host)
                    } else if SessionMediaKind.forPath(shownPath) != nil {
                        SessionMediaView(path: shownPath, host: hostParam,
                                         reference: shown.ref?.decorated ?? shown.path, cwd: shown.cwd, sessionID: shown.sessionID)
                    } else if isHTMLPreviewable && !showSource {
                        HTMLFilePreview(path: shownPath, host: hostParam)
                    } else {
                        sourceBody
                    }
                }
                // Keep the body's identifiers instead of stamping the viewer's onto every child.
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("session.files.viewer")
            }
            .navigationTitle(shown.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if isHTMLPreviewable && shown.missing == nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(showSource ? "Preview" : "Source") { showSource.toggle() }
                            .accessibilityIdentifier("session.files.viewer.sourceToggle")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
        .sheet(item: $pickedDirectory) { DirectoryPreviewSheet(target: $0) }
        // Another tapped target in the same viewer: nothing of the last one (its pick, its read)
        // stays on screen.
        .onChange(of: inputKey) {
            cancelPick()
            pickedDirectory = nil
            show(nil)
        }
        .onDisappear { cancelPick() }
    }

    // MARK: - Picking the machine

    /// Local, then the user's configured machines with their names, then any other machine this
    /// phone knows from its sessions. A list, never a pick: the file opens only from the machine the
    /// user taps.
    struct Machine: Hashable {
        let alias: String
        let label: String
    }

    private var machines: [Machine] {
        let isRemote = { (h: String) in !h.isEmpty && h != "local" && h != "__local__" }
        var out = [Machine(alias: "", label: "Local")]
        var seen: Set<String> = [""]
        for h in launchHosts ?? [] {
            let alias = h.alias.trimmingCharacters(in: .whitespacesAndNewlines)
            guard isRemote(alias), seen.insert(alias).inserted else { continue }
            let label = h.label.trimmingCharacters(in: .whitespacesAndNewlines)
            out.append(Machine(alias: alias, label: label.isEmpty ? alias : label))
        }
        let fromSessions = Set((tasks?.sessions ?? []).map { $0.host.trimmingCharacters(in: .whitespacesAndNewlines) })
        for alias in fromSessions.filter(isRemote).sorted() where seen.insert(alias).inserted {
            out.append(Machine(alias: alias, label: alias))
        }
        return out
    }

    private func loadHosts() async {
        guard launchHosts == nil else { return }
        do {
            launchHosts = try await api.sessionLaunchOptions().hosts
            hostsFailed = false
        } catch {
            guard !Task.isCancelled else { return }
            hostsFailed = true
        }
    }

    @ViewBuilder
    private var machinePicker: some View {
        VStack(spacing: 8) {
            Text("Open it from:")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            ForEach(machines, id: \.alias) { machine in
                Button {
                    pick(machine.alias)
                } label: {
                    HStack(spacing: 6) {
                        if picking == machine.alias { ProgressView() }
                        Text(machine.label)
                    }
                    .frame(minWidth: 160, minHeight: 32)
                }
                .buttonStyle(.bordered)
                .disabled(picking != nil)
                .accessibilityIdentifier("session.files.viewer.pick.\(machine.alias.isEmpty ? "local" : machine.alias)")
            }
            if launchHosts == nil && !hostsFailed {
                HStack(spacing: 6) {
                    ProgressView()
                    Text("Loading your machines…")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            } else if hostsFailed {
                Text("Couldn't load your machines, so this list may be incomplete.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("session.files.viewer.pick.hostsFailed")
            }
        }
        .task { await loadHosts() }
    }

    private func cancelPick() {
        pickTask?.cancel()
        pickTask = nil
        picking = nil
        pickSeq &+= 1
    }

    /// Look the path up on the machine the user tapped only (`sourceOnly`), then show what it found.
    private func pick(_ machine: String) {
        cancelPick()
        let mine = pickSeq
        let target = shown.ref ?? FilePathRef(path: shown.path)
        picking = machine
        pickTask = Task { @MainActor in
            let route = await ClickedPath.locate(target, host: machine, cwd: nil, sessionID: nil, sourceOnly: true)
            guard !Task.isCancelled, mine == pickSeq else { return }
            picking = nil
            pickTask = nil
            switch route {
            case .text(let found):
                show(Shown(name: found.ref.displayName, path: found.ref.path, host: found.host ?? "", ref: found.ref,
                           cwd: found.cwd, sessionID: found.sessionID, hostNote: found.hostNote,
                           // Not on that machine: the picker stays, so another one can be tried.
                           missing: found.missing, unknownSource: found.missing != nil))
            case .html(let found):
                show(Shown(name: found.displayName, path: found.path, host: found.host ?? "", ref: FilePathRef(path: found.path),
                           cwd: nil, sessionID: nil, hostNote: nil, missing: nil, unknownSource: false))
            case .directory(let found):
                pickedDirectory = found
            }
        }
    }

    /// A new target (nil: the tapped one again): the previous one's read and heal are dropped, so
    /// nothing of it stays on screen.
    private func show(_ next: Shown?) {
        loaded = false
        loadFailure = nil
        content = nil
        healedPath = nil
        healedNotice = nil
        showSource = false
        picked = next.map { Picked(inputKey: inputKey, target: $0) }
        readGen &+= 1
    }

    @ViewBuilder
    private var sourceBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !liveLoaded {
                HStack { ProgressView(); Text("Loading…").foregroundStyle(.secondary) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .padding(.top, 40)
            } else if let loadFailure = liveFailure {
                unavailable(loadFailure)
            } else if let content = liveContent {
                if content.error != nil {
                    unavailable(FilePreviewLink.failure(fromPayloadError: content.error, host: hostParam))
                } else if content.binary == true {
                    unavailable(FileReadFailure(kind: .unsupportedType, host: hostParam))
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
        .task(id: shownKey) { await load() }
    }

    private func unavailable(_ failure: FileReadFailure) -> some View {
        ContentUnavailableView {
            Label(failure.title, systemImage: failure.icon)
        } description: {
            Text(failure.message)
        } actions: {
            if failure.isRetryable {
                Button("Try Again") { retry() }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("session.files.viewer.retry")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Re-issue the same read from scratch. `load()` is guarded on `loaded`, so
    /// the reset has to come first — and the HEAL bookkeeping has to be reset
    /// with it, because a retry that kept a previous run's `healedPath` would
    /// silently read a different file than the one the reader asked for.
    private func retry() {
        loaded = false
        loadFailure = nil
        content = nil
        healedPath = nil
        healedNotice = nil
        Task { await load() }
    }

    /// Above-the-body banners: a server clip, and a self-heal that changed which
    /// file this is. The heal notice is NOT optional politeness — the reader
    /// asked for one path and is looking at another, and silently swapping it
    /// would be the "confident wrong answer" failure mode.
    @ViewBuilder
    private func notices(for content: SessionFileContent) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let healedNotice = liveHealedNotice {
                Label(healedNotice, systemImage: "arrow.triangle.branch")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if content.truncated == true {
                Label("Large file: showing the first 512 KB.", systemImage: "scissors")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, liveHealedNotice == nil && content.truncated != true ? 0 : 8)
    }

    private func load() async {
        let key = shownKey
        guard !(loaded && readKey == key) else { return }
        if readKey != key {
            // A new target: nothing of the last read carries over.
            readKey = key
            loaded = false
            loadFailure = nil
            content = nil
            healedPath = nil
            healedNotice = nil
        }
        // This read is for the target on screen now; one it no longer shows sets nothing.
        let path = shown.path, ref = shown.ref, readHost = hostParam
        let current = { !Task.isCancelled && key == shownKey }
        anchorLine = ref?.line
        anchorEndLine = ref?.endLine
        var firstFailure: FileReadFailure?
        // Only a "wrong path" shape is worth re-resolving. 403/413/501/503 are
        // honest statements about a path that DOES exist, and re-resolving one
        // would just replace a true answer with a guess.
        var pathLooksWrong = false
        do {
            let payload = try await api.fileContent(path: path, host: readHost)
            guard current() else { return }
            if payload.error == nil {
                content = payload
                loaded = true
                return
            }
            pathLooksWrong = true
            firstFailure = FilePreviewLink.failure(fromPayloadError: payload.error, host: readHost)
        } catch let error as APIError where error.isCancelled {
            return
        } catch let error as APIError {
            guard current() else { return }
            if case .server(let status, _, _, _, _) = error, status == 400 || status == 404 {
                pathLooksWrong = true
            }
            firstFailure = FilePreviewLink.failure(for: error, host: readHost)
        } catch {
            guard current() else { return }
            firstFailure = FilePreviewLink.failure(for: error, host: readHost)
        }

        if pathLooksWrong, let healed = await resolve() {
            // Another target replaced this one while the read ran.
            guard current() else { return }
            do {
                let payload = try await api.fileContent(path: healed.path, host: readHost)
                guard current() else { return }
                if payload.error == nil {
                    content = payload
                    healedPath = healed.path
                    healedNotice = "The path in the message wasn't there, so \(healed.path) opened instead."
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
        guard current() else { return }
        loadFailure = firstFailure ?? FileReadFailure(kind: .serverError(status: nil), host: readHost)
        loaded = true
    }

    /// Ask the host where this reference really lives. The phone has never
    /// called this endpoint before; it is the only layer that can see the
    /// session transcript and the host's git index, which is exactly what fixes
    /// a path written from another cwd.
    private func resolve() async -> FilePathRef? {
        let path = shown.path, ref = shown.ref, sessionID = shown.sessionID
        guard let cwd = shown.cwd, !cwd.isEmpty else { return nil }
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
