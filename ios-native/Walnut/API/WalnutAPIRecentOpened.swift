import Foundation

/// The person's one "recently opened" list, synced on every surface (web, Mac app, phone):
/// the ui-prefs key `walnut-todo-recent-opened`, `[{id, at}]` newest first, one entry per
/// task, at most 50. A write is merged by the server as a union (each task keeps its newest
/// `at`), so a phone sends only its own opens and never overwrites another device's.
struct RecentOpenedEntry: Codable, Equatable, Sendable {
    let id: String
    let at: String
}

extension WalnutAPI {
    static let recentOpenedKey = "walnut-todo-recent-opened"

    private struct PrefValue: Codable { let v: String; let ts: Double }
    private struct PrefsBody: Codable { let prefs: [String: PrefValue] }
    /// What a read gets back. `v` is null when a device deleted the key (the web's crash
    /// recovery syncs `{v: null}` for every `walnut-todo-*` key it clears), so it is
    /// optional here: a null reads as an empty list, never as a failed read.
    private struct ReadValue: Decodable { let v: String?; let ts: Double? }
    private struct PrefsRead: Decodable { let prefs: [String: ReadValue]? }
    private struct Ack: Decodable {}

    /// The synced list as the server holds it (`[]` when nobody opened anything yet).
    func recentOpened() async throws -> [RecentOpenedEntry] {
        let key = Self.recentOpenedKey
        let read: PrefsRead = try await sendAbsolute(
            "GET", "/api/ui-prefs?key=\(key)", body: nil as [String: String]?, retrySafe: true)
        return Self.recentOpened(from: read)
    }

    /// The list in a ui-prefs read body: `[]` when the key is absent or deleted (`v: null`).
    static func decodeRecentOpenedRead(_ body: Data) throws -> [RecentOpenedEntry] {
        recentOpened(from: try JSONDecoder().decode(PrefsRead.self, from: body))
    }

    private static func recentOpened(from read: PrefsRead) -> [RecentOpenedEntry] {
        guard let raw = read.prefs?[recentOpenedKey]?.v, let data = raw.data(using: .utf8) else { return [] }
        return decodeRecentOpened(data)
    }

    /// Record opens (one, or several when the phone's own old list is handed over once).
    func recordRecentOpened(_ entries: [RecentOpenedEntry]) async throws {
        guard !entries.isEmpty else { return }
        let value = String(decoding: try JSONEncoder().encode(entries), as: UTF8.self)
        let body = PrefsBody(prefs: [Self.recentOpenedKey: PrefValue(v: value, ts: (Date().timeIntervalSince1970 * 1000).rounded())])
        let _: Ack = try await sendAbsolute("PUT", "/api/ui-prefs", body: body)
    }

    /// Lenient: an entry without an id or a time is skipped, never the whole list.
    static func decodeRecentOpened(_ data: Data) -> [RecentOpenedEntry] {
        guard let items = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard let id = item["id"] as? String, !id.isEmpty, let at = item["at"] as? String else { return nil }
            return RecentOpenedEntry(id: id, at: at)
        }
    }
}

extension WalnutAPI: RecentOpenedTransport {}
