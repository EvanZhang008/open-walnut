import Foundation
import os
import WebKit

/// Erases everything Walnut keeps on this phone about the server it was paired
/// with. Run by Disconnect (and so by Leave demo, which is a disconnect from
/// the demo server), so pairing again starts from nothing.
///
/// The demo is a scope of its own (`AppPrefs`): entering it, every launch in
/// it, and leaving it erase the demo's state and nothing of the real app's.
/// Its preferences live in their own suite; its files land in the app's
/// folders, which hold nothing of the real app's while it is unpaired (the
/// demo is only offered then, and a disconnect sweeps them), apart from the
/// diagnostic log, which the sweep keeps.
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
/// (up to 16 MB) and what the log's heartbeat remembers, web view storage,
/// HTTP caches and cookies, and every preference. The Keychain token is
/// removed by `AppConfig.clear()`.
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
        /// The demo's preferences suite and its name (`AppPrefs`).
        var demoDefaults: UserDefaults = AppPrefs.demo
        var demoDefaultsDomain: String? = AppPrefs.demoSuiteName

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

        func eraseDemoPreferences() {
            if let domain = demoDefaultsDomain { demoDefaults.removePersistentDomain(forName: domain) }
            for key in demoDefaults.dictionaryRepresentation().keys where AppPrefs.isOurs(key) {
                demoDefaults.removeObject(forKey: key)
            }
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
    ///
    /// `scope` says whose preferences go: `.real` (Disconnect) removes every
    /// preference of the app, and the demo's too; `.demo` (entering or leaving
    /// the demo) removes the demo's suite only, and runs every store's own reset
    /// with the demo scope pinned, so even a reset that writes a value back
    /// writes it into the demo's suite, never into the real app's.
    @discardableResult
    static func eraseAll(reason: String, scope: AppPrefs.Scope = .real, locations explicit: Locations? = nil) -> [String] {
        let removed = AppPrefs.during(scope) {
            erase(reason: reason, scope: scope, locations: explicit ?? defaultLocations)
        }
        // Read again outside the pinned scope: what the next screen shows is
        // the scope now in force (the real app's, after leaving the demo).
        inbox?.reloadPreferences()
        return removed
    }

    /// The demo's state on disk, wiped at a launch in the demo, before any
    /// store reads it: its preferences suite, the durable queues, the caches,
    /// and the files in the app's folders (the log excepted). No store exists
    /// yet, so there is nothing in memory to reset, and the web view store is
    /// left alone (every web view is non-persistent; starting WebKit here
    /// would cost the launch).
    @discardableResult
    static func eraseDemoAtLaunch(locations explicit: Locations? = nil) -> [String] {
        let locations = explicit ?? defaultLocations
        locations.eraseDemoPreferences()
        DurableStore.eraseAll()
        DiskCache.clearAll()
        let removed = sweepFolders(locations)
        AppLog.info("reset", "demo state erased at launch", ["removed": String(removed.count)])
        return removed
    }

    private static func erase(reason: String, scope: AppPrefs.Scope, locations: Locations) -> [String] {
        let started = Date()

        // 0. Loads still running would land after the erase (see clearHTTPCaches).
        cancelSharedSessionLoads()

        // 1. In-memory state, through each owner's API.
        tasks?.eraseLocalState()
        chat?.eraseLocalState()
        notes?.eraseLocalState()
        inbox?.eraseLocalState()
        filePreview?.closeDocked()
        ComposerDrafts.shared.clearAll()
        LetterReplyStore.shared.eraseAll()
        AttachmentLoader.shared.eraseAll()
        SessionStreamResumeIDs.shared.removeAll()
        TimeHeartbeatReporter.shared.eraseLocalData()
        // The diagnostic tape keeps running: it must not carry the old screen
        // names, crumbs or work trail into the fresh log.
        Breadcrumbs.eraseHistory()
        PushRegistration.shared.forgetServer()
        DemoServer.shared.reset()

        // 2. Stores with their own IO queues, cleared on those queues.
        DurableStore.eraseAll()
        DiskCache.clearAll()
        AppLog.shared.discardLocalLogs()

        // 3. Everything else on disk that is ours.
        let removed = sweepFolders(locations)

        // 4. System caches that can hold server answers or pages.
        clearHTTPCaches()
        HTTPCookieStorage.shared.removeCookies(since: .distantPast)
        WKWebsiteDataStore.default().removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast
        ) {}

        // 5. Every preference, mic route and board filters included. The demo's
        // erase leaves the real app's preferences alone.
        if scope == .real {
            if let domain = locations.defaultsDomain {
                locations.defaults.removePersistentDomain(forName: domain)
            } else {
                for key in locations.defaults.dictionaryRepresentation().keys where AppPrefs.isOurs(key) {
                    locations.defaults.removeObject(forKey: key)
                }
            }
        }

        // 6. Apple Health: stop background delivery and forget every sync
        // anchor (the Mac's copy is only removed by "Delete Health Data on Mac").
        HealthSync.eraseLocalState()

        // 7. Places: stop recording and forget the visits kept here (the Mac's
        // copy is only removed by "Delete Places on Mac").
        PlacesRecorder.shared.eraseLocalState()

        // 8. The demo's own preferences, last, so the values the resets above
        // wrote back go too.
        locations.eraseDemoPreferences()

        AppLog.info("reset", "local data erased", [
            "reason": reason,
            "scope": scope.rawValue,
            "removed": String(removed.count),
            "elapsedMs": String(Int(Date().timeIntervalSince(started) * 1000)),
        ])
        return removed
    }

    /// Cancel every load on `URLSession.shared` (letter bodies, the log upload).
    /// The attachment loader cancels its own transfers in `eraseAll()`, and the
    /// stores' API calls end with the lifecycle teardown that runs first.
    private static func cancelSharedSessionLoads() {
        URLSession.shared.getAllTasks { tasks in
            for task in tasks { task.cancel() }
        }
    }

    /// How long after the erase the HTTP cache is cleared one last time.
    static let lateCacheClearDelay: TimeInterval = 1

    /// A response can still reach the HTTP cache after the erase: a transfer
    /// that finished just before its cancellation writes its response a few
    /// milliseconds later, and `removeAllCachedResponses()` itself finishes
    /// deleting after it returns. So the cache is cleared now, again once the
    /// shared session's cancellations have landed, and once more a moment later.
    private static func clearHTTPCaches() {
        URLCache.shared.removeAllCachedResponses()
        URLSession.shared.getAllTasks { tasks in
            for task in tasks { task.cancel() }
            URLCache.shared.removeAllCachedResponses()
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + lateCacheClearDelay) {
            URLCache.shared.removeAllCachedResponses()
        }
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

    private static func sweepFolders(_ locations: Locations) -> [String] {
        var removed: [String] = []
        removed += sweep(locations.applicationSupport, keep: { logFiles.contains($0) || isSystemOwned($0) })
        removed += sweep(locations.caches, keep: keepsCacheEntry)
        removed += sweep(locations.temporary, keep: isSystemOwned)
        removed += sweep(locations.documents, keep: { _ in false })
        return removed
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
