import Foundation
import os
import WebKit

/// Erases everything Walnut keeps on this phone about the server it was paired
/// with. Run by Disconnect (and so by Leave demo, which is a disconnect from
/// the demo server), so pairing again starts from nothing.
///
/// Two halves, both needed:
///  - every store that holds data in MEMORY is reset through its own API, or
///    the next write would put the old data straight back on disk;
///  - the app's own directories are then swept, so a store nobody listed here
///    still cannot outlive a disconnect.
///
/// What it erases: downloaded images and letter bodies, the disk caches behind
/// every list, unsent chat messages and letter replies, composer drafts, voice
/// recordings waiting to upload, queued attention time, the diagnostic log
/// (up to 16 MB), web view storage, HTTP caches and cookies, and every
/// preference. The Keychain token is removed by `AppConfig.clear()`.
@MainActor
enum LocalDataReset {
    /// The app's live stores, registered once at launch. Weak: tests create
    /// their own and must not be kept alive by this.
    private static weak var tasks: TasksStore?
    private static weak var chat: ChatStore?
    private static weak var notes: NotesStore?
    private static weak var inbox: InboxStore?
    private static weak var filePreview: FilePreviewDock?

    static func register(
        tasks: TasksStore, chat: ChatStore, notes: NotesStore, inbox: InboxStore,
        filePreview: FilePreviewDock?
    ) {
        self.tasks = tasks
        self.chat = chat
        self.notes = notes
        self.inbox = inbox
        self.filePreview = filePreview
    }

    /// Where the sweep looks. Injectable so a test can point it at a scratch
    /// directory; the app always uses `.app`.
    struct Locations {
        var applicationSupport: URL
        var caches: URL
        var temporary: URL
        var documents: URL
        var defaults: UserDefaults
        var defaultsDomain: String?

        static var app: Locations {
            let fm = FileManager.default
            return Locations(
                applicationSupport: fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0],
                caches: fm.urls(for: .cachesDirectory, in: .userDomainMask)[0],
                temporary: fm.temporaryDirectory,
                documents: fm.urls(for: .documentDirectory, in: .userDomainMask)[0],
                defaults: .standard,
                defaultsDomain: Bundle.main.bundleIdentifier
            )
        }
    }

    /// Caches folders the sweep leaves alone: URLCache keeps its database in a
    /// folder named after the bundle, and is cleared through its API instead.
    /// Everything else in Caches is ours (WalnutCache, WalnutAttachments,
    /// letter-bodies, and whatever a later store adds).
    static func keepsCacheEntry(_ name: String) -> Bool {
        isSystemOwned(name) || name == Bundle.main.bundleIdentifier
    }

    /// Files the log owns; `AppLog.discardLocalLogs()` empties them in place
    /// rather than deleting files the log is about to append to.
    static let logFiles: Set<String> = ["walnut-applog.jsonl", "walnut-applog.cursor"]

    #if DEBUG
    /// Tests only: where a disconnect inside a hosted test sweeps, so it cannot
    /// wipe the host app's own preferences.
    static var locationsOverrideForTesting: Locations?

    /// Tests only: the registered stores, so a test can swap in its own and
    /// put the app's back.
    static var registrationForTesting: (TasksStore?, ChatStore?, NotesStore?, InboxStore?, FilePreviewDock?) {
        get { (tasks, chat, notes, inbox, filePreview) }
        set { (tasks, chat, notes, inbox, filePreview) = newValue }
    }
    #endif

    /// Erase it all. Returns the top-level names the sweep removed (tests, log).
    @discardableResult
    static func eraseAll(reason: String, locations explicit: Locations? = nil) -> [String] {
        let started = Date()
        let locations = explicit ?? defaultLocations

        // 1. In-memory state, through each owner's API.
        tasks?.eraseLocalState()
        chat?.eraseLocalState()
        notes?.eraseLocalState()
        inbox?.eraseLocalState()
        filePreview?.closeDocked()
        ComposerDrafts.shared.clearAll()
        LetterReplyStore.shared.eraseAll()
        AttachmentLoader.shared.eraseAll()
        TimeHeartbeatReporter.shared.eraseLocalData()
        PushRegistration.shared.forgetServer()
        DemoServer.shared.reset()

        // 2. Stores with their own IO queues, cleared on those queues.
        DurableStore.eraseAll()
        DiskCache.clearAll()
        AppLog.shared.discardLocalLogs()

        // 3. Everything else on disk that is ours.
        var removed: [String] = []
        removed += sweep(locations.applicationSupport, keep: { logFiles.contains($0) || isSystemOwned($0) })
        removed += sweep(locations.caches, keep: keepsCacheEntry)
        removed += sweep(locations.temporary, keep: isSystemOwned)
        removed += sweep(locations.documents, keep: { _ in false })

        // 4. System caches that can hold server answers or pages.
        URLCache.shared.removeAllCachedResponses()
        HTTPCookieStorage.shared.removeCookies(since: .distantPast)
        WKWebsiteDataStore.default().removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast
        ) {}

        // 5. Every preference, mic route and board filters included.
        if let domain = locations.defaultsDomain {
            locations.defaults.removePersistentDomain(forName: domain)
        } else {
            for key in locations.defaults.dictionaryRepresentation().keys where key.hasPrefix("walnut") {
                locations.defaults.removeObject(forKey: key)
            }
        }

        AppLog.info("reset", "local data erased", [
            "reason": reason,
            "removed": String(removed.count),
            "elapsedMs": String(Int(Date().timeIntervalSince(started) * 1000)),
        ])
        return removed
    }

    private static var defaultLocations: Locations {
        #if DEBUG
        if let override = locationsOverrideForTesting { return override }
        #endif
        return .app
    }

    /// Folders Apple frameworks create in our container. Left to their owners.
    private static func isSystemOwned(_ name: String) -> Bool {
        name.hasPrefix("com.apple") || name.hasPrefix("WebKit") || name.hasPrefix(".")
    }

    private static func sweep(_ directory: URL, keep: (String) -> Bool) -> [String] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: directory.path) else { return [] }
        var removed: [String] = []
        for name in names where !keep(name) {
            if (try? fm.removeItem(at: directory.appendingPathComponent(name))) != nil {
                removed.append(name)
            }
        }
        return removed
    }
}

// MARK: - Owners' erase hooks that need no private access

extension NotesStore {
    func eraseLocalState() {
        tree = []
        pinned = []
        rowMeta = [:]
        errorMessage = nil
        loadingTree = false
    }
}
