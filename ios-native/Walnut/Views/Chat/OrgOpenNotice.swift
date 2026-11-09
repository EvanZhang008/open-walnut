import Foundation
import Observation
import CoreGraphics

/// An open of an Org node that did not happen (a thread push, a drawer row, Talk to CEO's Open
/// chat). It shows over whichever page of the Chat tab is in front: the chat's own error bar sits
/// under a pushed session, out of sight, and was still there, stale, after he went back (2026-11-06
/// gate). One notice at a time; a later open replaces it, a successful one clears it.
struct OrgOpenNotice: Equatable, Identifiable {
    enum Kind: Equatable {
        /// The open did not happen.
        case failure
        /// The open happened from what the phone holds, and the phone is offline.
        case offline
    }

    let id = UUID()
    let text: String
    var kind: Kind = .failure

    /// The page opened while the phone is offline. `cached`: it shows the node's threads as the
    /// phone last read them; else only what the notification said is there to show.
    static func offline(_ name: String, cached: Bool = true) -> String {
        "You're offline. " + shown(name, cached: cached)
    }

    /// The same, found by the open's own read: the server did not answer.
    static func unreachable(_ name: String, cached: Bool = true) -> String {
        "Couldn't reach Walnut. " + shown(name, cached: cached)
    }

    private static func shown(_ name: String, cached: Bool) -> String {
        cached
            ? "This is \(name) as the phone last saw it; it updates when you're back online."
            : "Showing what the notification said; \(name)'s threads load when you're back online."
    }

    /// The words for a failed open. A task that is gone is not a network problem.
    static func failure(_ name: String, _ error: Error) -> String {
        if case APIError.server(let status, _, _, _, _) = error {
            if status == 501 { return "\(name) can be started only while your Mac is online." }
            if status == 404 { return missingChat }
        }
        return "Couldn't reach \(name): \(error.localizedDescription)"
    }

    static let missingChat = "That chat is no longer available."

    /// The side of the close button's tap area, the platform minimum.
    static let closeSide: CGFloat = 44
}

/// The last time a read of an Org node's threads answered: an offline notice ("You're offline",
/// "Couldn't reach Walnut") goes the moment one does, so its words never outlast the state they
/// describe (2026-11-08 review, round 3: back online, the notice still said it could not connect).
@Observable
@MainActor
final class OrgReadNews {
    static let shared = OrgReadNews()
    private(set) var answeredAt: Date?
    private init() {}

    func answered() { answeredAt = Date() }

    /// A read has answered since `since`.
    func answered(since: Date) -> Bool { (answeredAt ?? .distantPast) >= since }
}

/// How long a notice stays: counted only while it can be seen (the app in front and no sheet
/// over the tab), so one that came under an approval sheet is still there when the sheet goes.
/// Pure; pinned in `OrgOpenNoticeTests`.
struct OrgOpenNoticeClock: Equatable {
    static let visibleFor: TimeInterval = 8
    private(set) var seen: TimeInterval = 0

    /// Count `dt` seconds; true once the notice has been in view long enough to go.
    mutating func tick(_ dt: TimeInterval, visible: Bool) -> Bool {
        if visible { seen += max(0, dt) }
        return seen >= Self.visibleFor
    }
}
