import Foundation
import Observation

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
    }

    func draft(_ key: String) -> String { text[key] ?? "" }

    func setDraft(_ value: String, key: String) {
        guard text[key] != value else { return }
        if value.isEmpty { text[key] = nil } else { text[key] = value }
        persist()
    }

    func images(_ key: String) -> [SelectedImage] { images[key] ?? [] }

    func setImages(_ value: [SelectedImage], key: String) {
        if value.isEmpty { images[key] = nil } else { images[key] = value }
    }

    /// Called after a send hands the content to a store — the store owns
    /// no-loss preservation from that point (failed bubbles keep text + images).
    func clear(_ key: String) {
        text[key] = nil
        images[key] = nil
        persist()
    }

    private func persist() {
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
        UserDefaults.standard.set(snapshot, forKey: Self.storageKey)
    }
}
