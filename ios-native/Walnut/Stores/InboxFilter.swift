import Foundation

/// The Inbox tab's filter row, and the list rules behind it.
///
/// Every rule here is the web console's, not a phone reinvention, because the
/// two surfaces show the same letters and must agree about which are unread and
/// which still want a decision:
///
///  - the unread count is the console's Inbox badge (`sectionCounts(...).inbox`
///    in web/src/contexts/notifications/notification-model.ts): live letters
///    whose `read` is false;
///  - Unread lists the console's Unread toggle (`filterInboxLetters` in
///    web/src/components/inbox/inbox-filter.ts): unread letters, plus the ones
///    read WHILE the filter was on (`keep`), so opening a letter does not pull
///    its row out from under the reader's thumb;
///  - Action needed is the console's Needs Action rail for letters: the COUNT is
///    unseen decisions (`isUnseenDecision`), the LIST is open decisions
///    (`isOpenDecision`), i.e. the unseen ones plus the ones read in the last five
///    minutes. Reading a decision is the human taking it on (the console's own
///    reasoning: a count that kept every read, unanswered ask stopped meaning
///    anything);
///  - the order is always the console's `compareLetters`: pinned first, then
///    newest, inside every filter.
///
/// The console has no TYPE filters. Review, Completed and Info are the phone's
/// minimal addition, one per remaining letter type, named with the same labels
/// the rows already carry. `tests/fixtures/inbox-parity/` pins all of this against
/// the web functions themselves (`tests/web/inbox-ios-parity.test.ts` runs them,
/// `InboxFilterParityTests` runs these).
enum InboxFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case unread
    case actionNeeded = "action_needed"
    case review
    case completion
    case info

    var id: String { rawValue }

    /// Chip text. The type chips use the row badges' own words (`LetterKind.label`).
    var title: String {
        switch self {
        case .all: return "All"
        case .unread: return "Unread"
        case .actionNeeded: return "Action needed"
        case .review: return LetterKind.review.label
        case .completion: return LetterKind.completion.label
        case .info: return LetterKind.info.label
        }
    }

    /// The letter `type` a type chip selects, nil for the three state filters.
    var letterType: String? {
        switch self {
        case .review: return "review"
        case .completion: return "completion"
        case .info: return "info"
        case .all, .unread, .actionNeeded: return nil
        }
    }

    /// Where the chosen filter is remembered, per device. Deliberately a plain
    /// local key: the console keeps its Unread toggle per browser for the same
    /// reason (a filter picked on one device must not narrow every other one).
    static let storageKey = "walnut.inbox.filter"

    /// Unknown or missing stored value → All.
    init(stored raw: String?) {
        self = raw.flatMap(InboxFilter.init(rawValue:)) ?? .all
    }
}

/// Pure list derivations for the Inbox tab (no state, no I/O).
enum InboxListing {

    /// The tab badge and the Unread chip's count.
    static func unreadCount(_ letters: [Letter]) -> Int {
        letters.reduce(0) { $0 + (!$1.isArchived && !$1.isRead ? 1 : 0) }
    }

    /// The Action needed chip's count: decisions nobody has looked at yet.
    static func unseenDecisionCount(_ letters: [Letter]) -> Int {
        letters.reduce(0) { $0 + ($1.isUnseenDecision ? 1 : 0) }
    }

    /// The count a chip shows, or nil for a chip that shows none.
    static func count(for filter: InboxFilter, in letters: [Letter]) -> Int? {
        switch filter {
        case .unread: return unreadCount(letters)
        case .actionNeeded: return unseenDecisionCount(letters)
        case .all, .review, .completion, .info: return nil
        }
    }

    /// The rows one filter lists, in inbox order.
    ///
    /// `keep` is the set of letters read while Unread was on (they stay until the
    /// filter changes or the tab is left); `nowMs` is the clock the decision grace
    /// window is judged against, advanced by the view's one timer.
    static func rows(
        _ letters: [Letter], filter: InboxFilter, keep: Set<String>, nowMs: Double
    ) -> [Letter] {
        let ordered = inboxOrder(letters)
        switch filter {
        case .all:
            return ordered
        case .unread:
            return ordered.filter { !$0.isRead || keep.contains($0.id) }
        case .actionNeeded:
            return ordered.filter { $0.isOpenDecision(nowMs: nowMs) }
        case .review, .completion, .info:
            return ordered.filter { $0.type == filter.letterType }
        }
    }

    /// The next moment a read decision leaves Action needed, or nil when none is
    /// inside its grace window. The view arms ONE timer for it instead of polling
    /// (the console's `nextDecisionGraceExpiry`).
    static func nextGraceExpiry(_ letters: [Letter], nowMs: Double) -> Double? {
        var next: Double?
        for letter in letters {
            guard let endsAt = letter.decisionGraceEndsAt, endsAt > nowMs else { continue }
            if next == nil || endsAt < next! { next = endsAt }
        }
        return next
    }

    /// Pinned first, then newest: `Letter.isOrderedBefore`, made STABLE. The
    /// console sorts with JavaScript's stable sort, so two letters with the same
    /// stamp keep the server's order there; Swift's sort promises no stability, and
    /// without the index tiebreak the two surfaces could list a tie differently.
    static func inboxOrder(_ letters: [Letter]) -> [Letter] {
        letters.enumerated().sorted { a, b in
            if Letter.isOrderedBefore(a.element, b.element) { return true }
            if Letter.isOrderedBefore(b.element, a.element) { return false }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// Wall clock in epoch ms, the unit every letter stamp uses.
    static func nowMs(_ date: Date = Date()) -> Double {
        date.timeIntervalSince1970 * 1000
    }
}
