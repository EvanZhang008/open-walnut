import Foundation
import Observation
import os

/// Durable owner of composer state (draft text + picked images), keyed per
/// conversation / per session.
///
/// Why this exists: the composer used to hold its draft in view-local `@State`.
/// That makes the text only as durable as the view's IDENTITY, and a SwiftUI
/// view inside a `safeAreaInset` under a tab, a `NavigationStack`, and a
/// keyboard-driven safe-area change has many ways to be re-identified — each of
/// which silently resets `@State` and drops whatever the user had typed
/// (reported: type, dismiss the keyboard, text gone). State whose loss the user
/// notices must not be owned by a view.
///
/// Text is mirrored to UserDefaults so it also survives a background kill.
/// Images are memory-only on purpose: they are large, they are re-pickable, and
/// persisting photo bytes on disk for an unsent message is not a trade worth
/// making.
@Observable
@MainActor
final class ComposerDrafts {
    static let shared = ComposerDrafts()

    private var text: [String: String] = [:]
    private var images: [String: [SelectedImage]] = [:]
    /// Attached files (a session's videos and documents). Memory-only like the
    /// images; the bytes are the app's copies in `ComposerFileStore`.
    private var files: [String: [ComposerFile]] = [:]
    /// Each draft's picked references, `@[label]` -> its `<task-ref/>` tag
    /// (`ComposerSuggestController`): the draft keeps the token, this keeps what it stands for,
    /// so a box built again (a row scrolled back, a letter opened again, a relaunch) still sends
    /// the tag. Kept on disk beside the words; written only on a pick or a send, never per keystroke.
    private var refs: [String: [String: String]] = [:]

    private static let storageKey = "walnut.composerDrafts"
    private static let refsStorageKey = "walnut.composerDraftRefs"
    /// Cap the persisted set so a long-lived install can't grow it without
    /// bound (one entry per conversation the user ever typed in).
    private static let maxPersistedDrafts = 40
    /// DEBUG launch argument (`-walnut.resetThreadFollowUps YES`) that drops every unsent thread
    /// Follow up at launch. `UITestLaunch` passes it on every UI test launch.
    nonisolated static let resetThreadFollowUpsArgument = "walnut.resetThreadFollowUps"

    private init() {
        if let saved = AppPrefs.defaults.dictionary(forKey: Self.storageKey) as? [String: String] {
            text = saved
        }
        if let saved = AppPrefs.defaults.dictionary(forKey: Self.refsStorageKey) as? [String: [String: String]] {
            refs = saved
        }
        #if DEBUG
        // UI tests reuse one simulator and the same thread ids: each launch starts with no
        // unsent Follow up, so one run's words never land in the next run's composer.
        if UserDefaults.standard.bool(forKey: Self.resetThreadFollowUpsArgument) {
            let kept = text.filter { !$0.key.hasPrefix(OrgThreadFollowUpDraft.prefix) }
            if kept.count != text.count {
                text = kept
                AppPrefs.defaults.set(text, forKey: Self.storageKey)
            }
            let keptRefs = refs.filter { !$0.key.hasPrefix(OrgThreadFollowUpDraft.prefix) }
            if keptRefs.count != refs.count {
                refs = keptRefs
                AppPrefs.defaults.set(refs, forKey: Self.refsStorageKey)
            }
        }
        #endif
        // Durability edge for the debounced persist: iOS only kills the app
        // AFTER backgrounding, so flushing here keeps the "survives a
        // background kill" guarantee intact (a hard crash can lose at most
        // the debounce window of typing).
        LifecycleHub.shared.register(self)
    }

    func draft(_ key: String) -> String { text[key] ?? "" }

    func setDraft(_ value: String, key: String) {
        guard text[key] != value else { return }
        if value.isEmpty { text[key] = nil } else { text[key] = value }
        schedulePersist()
    }

    /// Keeps at most `max` text drafts under `prefix` besides `keeping`, which always stays: a
    /// family of per-item drafts (one note per email) must not crowd the store's 40 out. Sorted
    /// keys, as the persist trim, so the same ones go every time.
    func trimDrafts(prefix: String, keeping: String, max: Int) {
        // Every draft under the prefix, words or pictures: one with pictures and no words yet
        // still counts, so its pictures cannot stay in memory past the cap.
        let keys = Set(text.keys).union(images.keys).union(files.keys)
        let others = keys.filter { $0.hasPrefix(prefix) && $0 != keeping }.sorted()
        guard others.count > max else { return }
        // A dropped draft takes its pictures and files with it.
        var droppedRefs = false
        for key in others.prefix(others.count - max) {
            text[key] = nil
            images[key] = nil
            files[key] = nil
            if refs.removeValue(forKey: key) != nil { droppedRefs = true }
        }
        if droppedRefs { persistRefs() }
        schedulePersist()
    }

    /// The references picked into `key`'s draft (label -> tag).
    func refs(_ key: String) -> [String: String] { refs[key] ?? [:] }

    /// Picks and sends are rare, so this writes at once: a reference picked a moment before a
    /// background kill still sends as its tag after the relaunch.
    func setRefs(_ value: [String: String], key: String) {
        guard refs[key] ?? [:] != value else { return }
        if value.isEmpty { refs[key] = nil } else { refs[key] = value }
        persistRefs()
    }

    func images(_ key: String) -> [SelectedImage] { images[key] ?? [] }

    func setImages(_ value: [SelectedImage], key: String) {
        if value.isEmpty { images[key] = nil } else { images[key] = value }
    }

    func files(_ key: String) -> [ComposerFile] { files[key] ?? [] }

    func setFiles(_ value: [ComposerFile], key: String) {
        if value.isEmpty { files[key] = nil } else { files[key] = value }
    }

    /// Every file any draft holds, so a launch-time sweep keeps their copies.
    var heldFileIDs: Set<String> { Set(files.values.flatMap { $0.map(\.id) }) }

    /// Called after a send hands the content to a store — the store owns
    /// no-loss preservation from that point (failed bubbles keep text + images).
    /// Clears persist IMMEDIATELY (they're rare and must not be resurrected
    /// by a crash inside the debounce window). The references stay: a refused send puts its
    /// words back (`ComposerBar.restoreRefusedDraft`), and its tokens still need their tags;
    /// the box's own controller lets them go once its words were taken.
    func clear(_ key: String) {
        text[key] = nil
        images[key] = nil
        files[key] = nil
        persistNow()
    }

    // MARK: - Debounced persistence (audit MAIN-9)
    //
    // persist() serializes the WHOLE drafts dictionary (40 entries, each
    // unbounded — LongDraftEditor supports 50K+ chars) through the
    // UserDefaults plist bridge synchronously on the MainActor, and setDraft
    // runs per keystroke. Measured 3.4ms/keystroke at the pathological cap —
    // pure waste at typing rate. Keystrokes now coalesce into one write per
    // `persistDebounce`; background flush (above) preserves durability.

    @ObservationIgnored private var persistTask: Task<Void, Never>?
    private static let persistDebounce: Duration = .milliseconds(500)

    #if DEBUG
    /// UserDefaults-write counter for ComposerFreezeTests.
    static let persistWrites = OSAllocatedUnfairLock(initialState: 0)
    #endif

    private func schedulePersist() {
        guard persistTask == nil else { return } // trailing-edge coalesce
        persistTask = Task { [weak self] in
            try? await Task.sleep(for: Self.persistDebounce)
            guard let self, !Task.isCancelled else { return }
            self.persistTask = nil
            self.persistNow()
        }
    }

    private func persistNow() {
        persistTask?.cancel()
        persistTask = nil
        var snapshot = text
        if snapshot.count > Self.maxPersistedDrafts {
            // Deterministic trim (sorted keys) — no timestamps to order by, and
            // an arbitrary dictionary order would drop a different draft each
            // launch.
            for key in snapshot.keys.sorted().prefix(snapshot.count - Self.maxPersistedDrafts) {
                snapshot[key] = nil
            }
            text = snapshot
        }
        #if DEBUG
        Self.persistWrites.withLock { $0 += 1 }
        #endif
        AppPrefs.defaults.set(snapshot, forKey: Self.storageKey)
    }

    private func persistRefs() {
        if refs.count > Self.maxPersistedDrafts {
            // The same deterministic trim as the words.
            for key in refs.keys.sorted().prefix(refs.count - Self.maxPersistedDrafts) { refs[key] = nil }
        }
        AppPrefs.defaults.set(refs, forKey: Self.refsStorageKey)
    }
}

extension ComposerDrafts: LifecycleSuspendable {
    func suspendForBackground() { persistNow() }
    func resumeForForeground() {}
}

// MARK: - Disconnect

extension ComposerDrafts {
    /// Forget every draft and attached picture, on disk too (`LocalDataReset`).
    func clearAll() {
        persistTask?.cancel()
        persistTask = nil
        text = [:]
        images = [:]
        files = [:]
        refs = [:]
        ComposerFileStore.removeAll()
        AppPrefs.defaults.removeObject(forKey: Self.storageKey)
        AppPrefs.defaults.removeObject(forKey: Self.refsStorageKey)
    }
}
