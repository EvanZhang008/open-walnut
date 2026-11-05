import Foundation
import ActivityKit

/// The lock-screen work card, shared by the app (which starts and ends it, WorkCardController)
/// and the widget extension (which draws it, WorkCardLiveActivity). One ActivityKit Live
/// Activity shows how many tasks are Working, Need you and were Completed since the card
/// began; the server keeps it current with silent content pushes
/// (src/core/push/work-card.ts, `WorkCardState` there is `ContentState` here, field for field).

/// The three lists the card counts, in the order it draws them.
enum WorkCardList: String, CaseIterable, Codable, Identifiable {
    case working, needs, completed

    var id: String { rawValue }

    /// The names every surface uses for these states (src/core/user-status.ts USER_STATE_LABELS).
    var label: String {
        switch self {
        case .working: return "Working"
        case .needs: return "Needs you"
        case .completed: return "Completed"
        }
    }

    var systemImage: String {
        switch self {
        case .working: return "hammer.circle.fill"
        // A raised hand: the user's turn, not an error.
        case .needs: return "hand.raised.circle.fill"
        case .completed: return "checkmark.circle.fill"
        }
    }
}

struct WorkCardAttributes: ActivityAttributes {
    /// What the server pushes. Times are seconds since 1970: ActivityKit decodes a `Date` in
    /// its own reference epoch, so the server sends plain numbers.
    struct ContentState: Codable, Hashable {
        var working: Int
        var needs: Int
        var completed: Int
        /// When the stretch began: Completed counts from here.
        var since: Double
        /// When the server read these numbers.
        var updatedAt: Double
        /// The newest Needs you task's title, nil when nothing needs the user.
        var needsTitle: String?
        /// That task's id: a tap on its title opens it (older servers send none).
        var needsTaskId: String?
        /// Set on the card's last face only: when it ended, so it reads "Finished", not running.
        var endedAt: Double?

        var sinceDate: Date { Date(timeIntervalSince1970: since) }
        var updatedDate: Date { Date(timeIntervalSince1970: updatedAt) }
        var endedDate: Date? { endedAt.map { Date(timeIntervalSince1970: $0) } }

        func count(_ list: WorkCardList) -> Int {
            switch list {
            case .working: return working
            case .needs: return needs
            case .completed: return completed
            }
        }

        /// The list a tap on the whole card opens: what needs the user first, else what runs.
        var primaryList: WorkCardList { needs > 0 ? .needs : .working }

        /// The same numbers, ignoring when they were read: what changes the card's face.
        func sameFace(as other: ContentState) -> Bool {
            working == other.working && needs == other.needs && completed == other.completed
                && since == other.since && needsTitle == other.needsTitle && needsTaskId == other.needsTaskId
        }
    }
}

/// The card's links into the app: `walnut://work?list=needs`. The app registers the
/// `walnut` scheme (project.yml CFBundleURLTypes) and opens the list on any of them.
enum WorkCardLink {
    static let scheme = "walnut"
    static let host = "work"

    /// `task`: a task in that list to open over it (the Needs you title's).
    static func url(_ list: WorkCardList, task: String? = nil) -> URL {
        var c = URLComponents()
        c.scheme = scheme
        c.host = host
        c.queryItems = [URLQueryItem(name: "list", value: list.rawValue)]
            + (task.map { [URLQueryItem(name: "task", value: $0)] } ?? [])
        return c.url!
    }

    /// The task a card link names, nil when it names none.
    static func task(from url: URL) -> String? {
        guard list(from: url) != nil else { return nil }
        let v = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "task" })?.value
        return v?.isEmpty == false ? v : nil
    }

    /// The list a card link names, nil when the URL is not a card link. A card link with no
    /// list, or one this build does not know, opens Working.
    static func list(from url: URL) -> WorkCardList? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == host else { return nil }
        let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "list" })?.value ?? ""
        return WorkCardList(rawValue: raw) ?? .working
    }
}
