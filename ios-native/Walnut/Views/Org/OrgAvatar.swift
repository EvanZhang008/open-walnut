import SwiftUI
import UIKit

/// The Org avatars the server draws (`GET /api/v1/org/avatars/<taskId>.png`), read with the
/// pairing's Bearer token (AsyncImage cannot send it). One answer serves every view of the same
/// task and size for a minute, the server's own `max-age`; after that the next view that shows it
/// asks again, so an avatar he changed shows on the next open of the page. A 404 (the "Org
/// avatars" experiment is off) is remembered the same way, so the app keeps its own look and lists
/// do not ask again on every row. A failed read keeps what was shown and is tried on the next view.
@MainActor
final class OrgAvatarLoader {
    static let shared = OrgAvatarLoader()

    /// How long an answer stands before a view asks again (the route's `max-age=60`).
    nonisolated static let freshSeconds: TimeInterval = 60

    struct Key: Hashable {
        let server: String
        let taskId: String
        let pixels: Int
    }

    /// One key's picture, observed on its own. An answer for one avatar redraws only the views that
    /// show that one, and an answer the same as the last redraws nothing. With one observed table, every
    /// avatar on screen redrew whenever any answer came in: opening the drawer's Directors fold (each
    /// Director row loads its own avatar since 1c98f414e5) redrew every VP row too, the rows a long
    /// press for their menu lands on.
    @Observable
    @MainActor
    final class Slot {
        fileprivate(set) var image: UIImage?
        @ObservationIgnored fileprivate var data: Data?
        @ObservationIgnored fileprivate var answeredAt: Date?
    }

    @ObservationIgnored private var slots: [Key: Slot] = [:]
    @ObservationIgnored private var inflight: [Key: Task<Void, Never>] = [:]
    private let fetch: (String, Int) async throws -> Data?
    private let now: () -> Date

    init(fetch: @escaping (String, Int) async throws -> Data? = { try await WalnutAPI().orgAvatarPNG(taskId: $0, pixels: $1) },
         now: @escaping () -> Date = { Date() }) {
        self.fetch = fetch
        self.now = now
    }

    /// The pixel size asked for a side of `points` on a screen of `scale`, in the server's range.
    nonisolated static func pixels(points: CGFloat, scale: CGFloat) -> Int {
        let px = Int((points * max(scale, 1)).rounded(.up))
        return min(max(px, WalnutAPI.orgAvatarPixels.lowerBound), WalnutAPI.orgAvatarPixels.upperBound)
    }

    nonisolated static func isFresh(_ at: Date, now: Date) -> Bool {
        now.timeIntervalSince(at) < freshSeconds
    }

    static func key(taskId: String, pixels: Int) -> Key {
        Key(server: AppConfig.serverURL?.absoluteString ?? "", taskId: taskId, pixels: pixels)
    }

    /// What to show now: the last image read for the key, nil while there is none (or the server
    /// said there is none). A view that reads it is redrawn only when this key's picture changes.
    func image(_ key: Key) -> UIImage? { slot(key).image }

    /// The key's slot, made on first use (not observed itself: the slot's picture is).
    private func slot(_ key: Key) -> Slot {
        if let slot = slots[key] { return slot }
        let slot = Slot()
        slots[key] = slot
        return slot
    }

    /// Reads the avatar again unless a fresh answer is already here or a read is under way.
    func refresh(_ key: Key, scale: CGFloat) async {
        if let at = slots[key]?.answeredAt, Self.isFresh(at, now: now()) { return }
        if let running = inflight[key] { return await running.value }
        let fetch = self.fetch
        let task = Task { @MainActor in
            defer { self.inflight[key] = nil }
            do {
                let data = try await fetch(key.taskId, key.pixels)
                // Erased meanwhile (Disconnect): this answer belongs to the pairing that left.
                guard !Task.isCancelled else { return }
                let slot = self.slot(key)
                slot.answeredAt = self.now()
                // The same answer again (a 404 again, the same picture) changes nothing on screen.
                guard data != slot.data else { return }
                slot.data = data
                slot.image = data.flatMap { UIImage(data: $0, scale: max(scale, 1)) }
            } catch {
                // Not an answer about the avatar: keep what shows, ask again on the next view.
            }
        }
        inflight[key] = task
        await task.value
    }

    /// Forget every avatar (Disconnect, `LocalDataReset`). Each key keeps its slot and only forgets
    /// what it held: a view on screen keeps watching the slot it read, so the next pairing's answer
    /// redraws it. A slot dropped here would leave such a view on a slot nothing writes again.
    func eraseAll() {
        for task in inflight.values { task.cancel() }
        inflight = [:]
        for slot in slots.values {
            if slot.image != nil { slot.image = nil }
            slot.data = nil
            slot.answeredAt = nil
        }
    }
}

/// A task's Org avatar, `side` points square in a rounded square, or `fallback` while there is
/// none (still loading, the experiment off, a failed read). Decorative: the name beside it says
/// who it is, so VoiceOver skips it. `gap` is space after the picture only, so a caller with no
/// fallback lays out exactly as before when no avatar comes.
struct OrgAvatar<Fallback: View>: View {
    let taskId: String?
    let side: CGFloat
    var gap: CGFloat = 0
    @ViewBuilder var fallback: () -> Fallback

    @Environment(\.displayScale) private var scale
    @State private var loader = OrgAvatarLoader.shared

    /// Corner radius as a share of the side, the web Org page's rounded square.
    static var cornerShare: CGFloat { 0.26 }

    var body: some View {
        let key = taskId.map { OrgAvatarLoader.key(taskId: $0, pixels: OrgAvatarLoader.pixels(points: side, scale: scale)) }
        Group {
            if let key, let image = loader.image(key) {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
                    .frame(width: side, height: side)
                    .clipShape(RoundedRectangle(cornerRadius: side * Self.cornerShare, style: .continuous))
                    .padding(.trailing, gap)
                    .accessibilityHidden(true)
            } else {
                fallback()
            }
        }
        .task(id: key) {
            guard let key else { return }
            await loader.refresh(key, scale: scale)
        }
    }
}

extension OrgAvatar where Fallback == AnyView {
    /// No fallback: a zero-size placeholder (still a view, so the read starts when it appears).
    init(taskId: String?, side: CGFloat, gap: CGFloat = 0) {
        self.init(taskId: taskId, side: side, gap: gap) {
            AnyView(Color.clear.frame(width: 0, height: 0).accessibilityHidden(true))
        }
    }
}

/// An Org node's name as a navigation title, with its avatar before it when the server has one;
/// with none it reads as the system's inline title.
struct OrgNodeTitle: View {
    let nodeId: String?
    let name: String
    @ScaledMetric(relativeTo: .headline) private var side: CGFloat = 20

    var body: some View {
        HStack(spacing: 0) {
            OrgAvatar(taskId: nodeId, side: min(side, 28), gap: 6)
            Text(verbatim: name)
                .font(.headline)
                .lineLimit(1)
        }
    }
}
