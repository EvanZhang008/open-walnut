import SwiftUI
import UIKit

/// The ONE way a passing notice reaches the screen (2026-11-20: the user asked for one generic
/// notification system for the whole app, so a new notice is never built again). Every popup that says
/// something for a moment (a task pinned, Apple Health turned on, a photo upload under way, an Org
/// chat that did not open, a session reconnecting) posts a `NoticeItem` here; the center decides
/// the order, how many show, and when each goes, and `NoticeWindow` draws them as `NoticeCard`s at
/// the top of the screen, over any sheet. No screen draws a toast of its own
/// (`NoticeCenterGuardTests`).
///
/// The rules (pinned in `NoticeCenterTests`):
///  - newest nearest the top edge; a post with an id already up replaces it and comes to the top;
///  - at most `maxInSight` in sight, the rest folded into one "N more" line;
///  - a notice's clock counts only while it is in sight and the app is in front, so one that
///    came while the app was away, or folded under newer ones, is still there to read;
///  - an error stays at least `errorMinimum` seconds, whatever its poster asked; info `infoSeconds`;
///  - a dismiss (its X, a swipe up, its clock) runs the poster's `onDismiss`.
@MainActor
@Observable
final class NoticeCenter {
    static let shared = NoticeCenter(drivesClock: true)

    static let maxInSight = 3
    /// An info or done notice: long enough to read one line.
    static let infoSeconds: TimeInterval = 3
    /// A warning: a little longer, it may ask for something.
    static let warnSeconds: TimeInterval = 5
    /// An error never goes fast: it says something did not happen.
    static let errorMinimum: TimeInterval = 8
    /// How often the clock counts.
    static let tickSeconds: TimeInterval = 0.25

    struct Entry: Identifiable {
        var item: NoticeItem
        /// Seconds it has been in sight since it was posted.
        var seen: TimeInterval = 0
        var id: String { item.id }
    }

    /// Newest first.
    private(set) var entries: [Entry] = []
    /// The "N more" line was tapped: every notice shows until there are `maxInSight` or fewer again.
    var showsAll = false

    private let drivesClock: Bool
    @ObservationIgnored private var clock: Task<Void, Never>?
    /// Told true on every post and false when the last notice goes (`NoticeWindow` shows and
    /// hides; a post before the app had a window to show it in is shown with the next one).
    @ObservationIgnored var onPresenceChange: ((Bool) -> Void)?

    /// `drivesClock`: false in tests, which call `tick` themselves.
    init(drivesClock: Bool = false) {
        self.drivesClock = drivesClock
    }

    // MARK: - What shows

    var inSight: [NoticeItem] {
        (showsAll ? entries : Array(entries.prefix(Self.maxInSight))).map(\.item)
    }

    /// How many are folded into the "N more" line.
    var folded: Int { showsAll ? 0 : max(0, entries.count - Self.maxInSight) }

    func item(_ id: String) -> NoticeItem? { entries.first { $0.id == id }?.item }

    /// How long a notice stays in sight, nil while it waits for a dismiss.
    static func lifetime(of item: NoticeItem) -> TimeInterval? {
        let asked: TimeInterval?
        switch item.life {
        case .untilDismissed: return nil
        case .seconds(let s): asked = s
        case .automatic:
            switch item.tone {
            case .error: asked = errorMinimum
            case .warn: asked = warnSeconds
            case .live: return nil
            case .ok, .muted: asked = infoSeconds
            }
        }
        guard let asked else { return nil }
        return item.tone == .error ? max(asked, errorMinimum) : asked
    }

    // MARK: - The one way in

    /// Show `item`; one with the same id is replaced, comes to the top and starts its clock again.
    func post(_ item: NoticeItem) {
        let isNew = !entries.contains { $0.id == item.id }
        entries.removeAll { $0.id == item.id }
        entries.insert(Entry(item: item), at: 0)
        if entries.count <= Self.maxInSight { showsAll = false }
        if isNew, item.announces {
            AccessibilityNotification.Announcement(item.spokenText).post()
        }
        AppLog.info("notice", "posted", ["id": item.id, "tone": item.tone.rawValue])
        startClock()
        onPresenceChange?(true)
    }

    /// Change a notice that is up, in place: its order and clock stay (an upload's "3 of 5").
    /// Nothing happens once it is gone, so a notice he closed does not come back with the next step.
    func update(_ id: String, _ change: (inout NoticeItem) -> Void) {
        guard let i = entries.firstIndex(where: { $0.id == id }) else { return }
        var item = entries[i].item
        change(&item)
        item.id = id
        entries[i].item = item
    }

    /// Take a notice away: its X, a swipe, its clock, or its poster saying it no longer holds.
    func dismiss(_ id: String) {
        guard let i = entries.firstIndex(where: { $0.id == id }) else { return }
        let gone = entries.remove(at: i)
        if entries.count <= Self.maxInSight { showsAll = false }
        gone.item.onDismiss?()
        if entries.isEmpty { stopClock(); onPresenceChange?(false) }
    }

    func dismissAll() {
        for id in entries.map(\.id) { dismiss(id) }
    }

    // MARK: - The clock

    /// Count `dt` seconds for every notice in sight (only while `visible`: the app in front), and
    /// dismiss those whose time is up.
    func tick(_ dt: TimeInterval, visible: Bool) {
        guard visible, dt > 0 else { return }
        let sight = Set(inSight.map(\.id))
        var due: [String] = []
        for i in entries.indices where sight.contains(entries[i].id) {
            entries[i].seen += dt
            if let life = Self.lifetime(of: entries[i].item), entries[i].seen >= life { due.append(entries[i].id) }
        }
        for id in due { dismiss(id) }
    }

    private func startClock() {
        guard drivesClock, clock == nil else { return }
        clock = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.tickSeconds))
                guard let self, !Task.isCancelled else { return }
                self.tick(Self.tickSeconds, visible: UIApplication.shared.applicationState == .active)
            }
        }
    }

    private func stopClock() {
        clock?.cancel()
        clock = nil
    }
}

/// What a status says by its colour (the web's `NoticeTone`): on its way, done, a warning, an
/// error, or nothing in particular.
enum NoticeTone: String, Equatable {
    case live, ok, warn, error, muted

    /// The dot's colour and the avatar tile's.
    var color: Color {
        switch self {
        case .live: return Color(uiColor: .systemBlue)
        case .ok: return Color(uiColor: .systemGreen)
        case .warn: return Color(uiColor: .systemOrange)
        case .error: return Color(uiColor: .systemRed)
        case .muted: return Color(uiColor: .systemGray)
        }
    }

    /// The status word's colour: muted for news, the readable tone where the colour means something.
    var wordColor: Color {
        switch self {
        case .live, .muted: return .secondary
        case .ok: return Theme.doneText
        case .warn: return Theme.reviewText
        case .error: return Theme.dangerText
        }
    }

    /// A glyph for the avatar tile when the poster names none.
    var symbol: String {
        switch self {
        case .live: return "arrow.triangle.2.circlepath"
        case .ok: return "checkmark"
        case .warn: return "exclamationmark"
        case .error: return "exclamationmark.triangle.fill"
        case .muted: return "info"
        }
    }
}

/// How long a notice stays in sight.
enum NoticeLife: Equatable {
    /// By its tone: info and done `infoSeconds`, a warning `warnSeconds`, an error `errorMinimum`,
    /// a live one (on its way) until its poster dismisses it.
    case automatic
    /// This long in sight (an error never less than `errorMinimum`).
    case seconds(TimeInterval)
    /// Until its X, a swipe, or its poster takes it away.
    case untilDismissed
}

/// The avatar tile: a glyph on the tone's colour, or a name's letters.
enum NoticeAvatar: Equatable {
    case symbol(String)
    case initials(String)

    /// A name's letters ("Growth VP" is GV), or a person glyph for a name with no letters.
    static func initials(of name: String) -> NoticeAvatar {
        let words = name.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        let letters = words.prefix(2).compactMap(\.first).map(String.init).joined()
        return letters.isEmpty ? .symbol("person.fill") : .initials(letters)
    }
}

/// A button under a notice's words.
struct NoticeAction: Identifiable {
    let title: String
    var role: ButtonRole?
    let run: @MainActor () -> Void
    var id: String { title }
}

/// One notice: who it is from, its status as a dot and a word, and a preview of two lines.
struct NoticeItem: Identifiable {
    /// One per subject: a post with the same id replaces the one up.
    var id: String
    /// Bold: who it is from, or what it is about.
    var title: String
    /// The status word beside the dot ("Delivered", "Uploading", "Couldn't open").
    var status: String?
    var tone: NoticeTone
    /// Under the title, two lines at most (a tap on a notice with no `onTap` shows the rest).
    var preview: String?
    var avatar: NoticeAvatar?
    var life: NoticeLife = .automatic
    var actions: [NoticeAction] = []
    /// What UI tests find it by; its X is `<accessibilityId>.close`.
    var accessibilityId: String?
    /// VoiceOver reads a new notice aloud when it comes.
    var announces = true
    /// A tap on the notice's words: open what it is about.
    var onTap: (@MainActor () -> Void)?
    /// It left the screen, by any way (X, swipe, clock, `dismiss`).
    var onDismiss: (@MainActor () -> Void)?

    init(id: String, title: String, status: String? = nil, tone: NoticeTone, preview: String? = nil,
         avatar: NoticeAvatar? = nil, life: NoticeLife = .automatic,
         actions: [NoticeAction] = [], accessibilityId: String? = nil, announces: Bool = true,
         onTap: (@MainActor () -> Void)? = nil, onDismiss: (@MainActor () -> Void)? = nil) {
        self.id = id
        self.title = title
        self.status = status
        self.tone = tone
        self.preview = preview
        self.avatar = avatar
        self.life = life
        self.actions = actions
        self.accessibilityId = accessibilityId
        self.announces = announces
        self.onTap = onTap
        self.onDismiss = onDismiss
    }

    var shownAvatar: NoticeAvatar { avatar ?? .symbol(tone.symbol) }

    /// The whole card as VoiceOver reads it: title, status, preview.
    var spokenText: String {
        [title, status, preview].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: ", ")
    }
}
