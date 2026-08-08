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

    private static let storageKey = "walnut.composerDrafts"
    /// Cap the persisted set so a long-lived install can't grow it without
    /// bound (one entry per conversation the user ever typed in).
    private static let maxPersistedDrafts = 40

    private init() {
        if let saved = UserDefaults.standard.dictionary(forKey: Self.storageKey) as? [String: String] {
            text = saved
        }
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

    func images(_ key: String) -> [SelectedImage] { images[key] ?? [] }

    func setImages(_ value: [SelectedImage], key: String) {
        if value.isEmpty { images[key] = nil } else { images[key] = value }
    }

    /// Called after a send hands the content to a store — the store owns
    /// no-loss preservation from that point (failed bubbles keep text + images).
    /// Clears persist IMMEDIATELY (they're rare and must not be resurrected
    /// by a crash inside the debounce window).
    func clear(_ key: String) {
        text[key] = nil
        images[key] = nil
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
        UserDefaults.standard.set(snapshot, forKey: Self.storageKey)
    }
}

extension ComposerDrafts: LifecycleSuspendable {
    func suspendForBackground() { persistNow() }
    func resumeForForeground() {}
}
