import Foundation
import Observation

/// Opens an Org node's page from anywhere: a thread push, a link. Same shape as
/// `ContentActionLink`: the caller drops the request here, `MainTabView` brings Chat forward, and
/// `ChatView` opens the node's chat with its page (Threads, scrolled to the thread) on top.
///
/// The gate for what is presented over the app sits HERE, before the request reaches any page:
/// what may close closes first (`PresentationLowering`), and a sheet that holds his unsaved work
/// (`holdsNavigation`) holds the request until he saves or closes it. Nothing under that sheet
/// moves meanwhile, so the views that host it (a task's session, the node's chat) stay
/// (2026-11-08 review, round 2: a push tore down the session behind a description he was editing).
@Observable
@MainActor
final class OrgNodeLink {
    static let shared = OrgNodeLink()

    /// A request older than this is dropped: a tab that never came forward must not jump minutes
    /// after the tap.
    nonisolated static let requestTTL: TimeInterval = 120

    /// The longest a request waits behind a sheet holding his work: after that the tap is too old.
    nonisolated static let holdLimit: TimeInterval = 30 * 60

    struct Request: Equatable {
        /// The node's task (the CEO's or a VP's).
        let taskId: String
        let tab: OrgNodeTab
        let threadId: String?
        let requestedAt: Date
        /// The notification's own words (the thread's title, its ask), for a page that has nothing
        /// else to show yet.
        var title: String? = nil
        var ask: String? = nil
    }

    private(set) var pending: Request?
    /// Something asked for an Org node's page in this run (a push, a link, a tap): a launch's
    /// restore of the page kept from before gives way to it (`OrgNodePageHost.restore`).
    @ObservationIgnored private(set) var askedThisRun = false
    /// A request waiting behind a sheet that holds his work (the sheet says so: `holdsNavigation`).
    private(set) var held: Request?
    @ObservationIgnored private var holdWatch: Task<Void, Never>?
    /// A request waiting for the sheets the gate closed to leave (`awaitLowered`).
    @ObservationIgnored private var lowering: Task<Void, Never>?
    /// The notification's words per thread, for the page that opens on it (`preview`).
    @ObservationIgnored private var previews: [String: (title: String?, ask: String?)] = [:]

    private init() {}

    /// Open the node `taskId` on `tab` (Threads by default), its thread `threadId` in view.
    func open(taskId: String, threadId: String? = nil, tab: OrgNodeTab = .threads, title: String? = nil,
              ask: String? = nil, now: Date = Date()) {
        guard !taskId.isEmpty else { return }
        askedThisRun = true
        if let threadId, title != nil || ask != nil { previews[threadId] = (title, ask) }
        AppLog.info("org", "node page requested", ["taskId": taskId, "threadId": threadId ?? "", "tab": tab.rawValue])
        go(Request(taskId: taskId, tab: tab, threadId: threadId, requestedAt: now, title: title, ask: ask), heldSince: nil)
    }

    /// What the notification said about `threadId`, if a tap brought it.
    func preview(_ threadId: String) -> (title: String?, ask: String?)? { previews[threadId] }

    /// Disconnect: the notifications' words go with the pairing.
    func forgetPreviews() {
        previews.removeAll()
        held = nil
        holdWatch?.cancel()
        holdWatch = nil
        lowering?.cancel()
        lowering = nil
    }

    /// Through the gate: published, or held while a sheet keeps his work. The newest request wins.
    /// `settled`: the wait for what the gate closed is over (`awaitLowered`).
    private func go(_ request: Request, heldSince: Date?, settled: Bool = false) {
        lowering?.cancel()
        lowering = nil
        let plan = PresentationLowering.lowerForNavigation("org node link")
        if plan == .keep {
            held = request
            AppLog.info("org", "node page request held: a sheet holds unsaved work", ["taskId": request.taskId])
            watchHold(since: heldSince ?? Date())
            return
        }
        holdWatch?.cancel()
        holdWatch = nil
        held = nil
        if plan != .show, !settled {
            awaitLowered(request, heldSince: heldSince)
            return
        }
        pending = request
    }

    /// The longest a request waits for the sheets it closed to finish leaving. The wait ends on
    /// the sheet being gone, not on this clock: it is a last resort for a sheet that never goes.
    nonisolated static let lowerWait: TimeInterval = 6
    /// After that last resort, how long the request still watches for the sheet to go, to land
    /// its page again once it has (2026-11-08 review, round 3: a slow dismiss could still land the
    /// page under the sheet).
    nonisolated static let relandWatch: TimeInterval = 20

    /// Through the gate again once what it closed has left the screen. A page pushed while a
    /// sheet was still sliding away went up under it and was laid out again once the sheet was
    /// gone, which put its list back at the top: the thread was marked but not in view
    /// (2026-11-08 fleet run: a push over Task Details, the Tasks draft, a note just cancelled).
    private func awaitLowered(_ request: Request, heldSince: Date?) {
        lowering = Task { [weak self] in
            let deadline = Date().addingTimeInterval(Self.lowerWait)
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: 50_000_000)
                guard let self, !Task.isCancelled else { return }
                switch PresentationLowering.current() {
                case .show:
                    self.go(request, heldSince: heldSince, settled: true)
                    return
                case .keep:
                    // A sheet holding his work came up meanwhile: the request waits for it.
                    self.go(request, heldSince: heldSince)
                    return
                case .closeFirst:
                    // Something else came up meanwhile: it closes too, within the same wait.
                    PresentationLowering.lowerForNavigation("org node link, again")
                case .wait:
                    continue
                }
            }
            guard let self, !Task.isCancelled else { return }
            // A sheet that never finished leaving: the tap goes ahead all the same, and lands
            // again once the sheet is gone.
            self.go(request, heldSince: heldSince, settled: true)
            self.relandOnceClear(request)
        }
    }

    /// The request went out with a sheet still leaving: once nothing is over the app any more,
    /// it goes through the gate again with a fresh time, so its page takes it on the screen he
    /// sees and its thread is revealed there. A newer request (`go` cancels this) or a move of his
    /// since ends it.
    private func relandOnceClear(_ request: Request) {
        let moves = OrgUserNavigation.shared.serial
        lowering = Task { [weak self] in
            let deadline = Date().addingTimeInterval(Self.relandWatch)
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard let self, !Task.isCancelled else { return }
                guard OrgUserNavigation.shared.serial == moves else { return }
                guard PresentationLowering.current() == .show else { continue }
                AppLog.info("org", "node page request lands again: the sheet has gone", ["taskId": request.taskId])
                let again = Request(taskId: request.taskId, tab: request.tab, threadId: request.threadId,
                                    requestedAt: Date(), title: request.title, ask: request.ask)
                self.go(again, heldSince: nil, settled: true)
                return
            }
        }
    }

    /// Asks again twice a second until the sheet that holds his work is saved or closed.
    private func watchHold(since: Date) {
        guard holdWatch == nil else { return }
        holdWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self, !Task.isCancelled, let request = self.held else { return }
                guard Date().timeIntervalSince(since) < Self.holdLimit else {
                    self.held = nil
                    self.holdWatch = nil
                    return
                }
                guard PresentationLowering.current() != .keep else { continue }
                self.holdWatch = nil
                // Its clock starts now: the wait was his, not the tab's.
                let fresh = Request(taskId: request.taskId, tab: request.tab, threadId: request.threadId,
                                requestedAt: Date(), title: request.title, ask: request.ask)
                self.go(fresh, heldSince: since)
                return
            }
        }
    }

    func consume(now: Date = Date()) -> Request? {
        guard let request = pending else { return nil }
        pending = nil
        return ContentActionLink.isFresh(request.requestedAt, now: now, ttl: Self.requestTTL) ? request : nil
    }
}

/// He moved somewhere himself on the Chat tab outside `ChatView`'s own stack (Back from a node's
/// page, a page opened from a chat's bar): an open on its way gives way (`ChatView.userNavigated`).
@Observable
@MainActor
final class OrgUserNavigation {
    static let shared = OrgUserNavigation()
    private(set) var serial = 0
    private init() {}

    func moved(_ why: String) {
        serial &+= 1
        AppLog.info("org", "user navigation", ["why": why])
    }
}

/// The Chat tab's node pages ON ITS STACK, by the chat they belong to: a page counts from its
/// first appearance until it leaves the stack (its state goes, or its chat's host sees it gone),
/// not while it is merely out of sight. Another tab in front fires the page's onDisappear, and a
/// push for another VP then swapped the chat under a page still on the stack (2026-11-08 review,
/// round 3). A chat that opens its page for a request waits until another chat's page has left
/// the stack: two page changes in one update lost the new one (a push for VP B with VP A's page up).
@Observable
@MainActor
final class OrgPagesOnScreen {
    static let shared = OrgPagesOnScreen()
    private(set) var sessions: [String: Int] = [:]
    private init() {}

    /// The chat whose page is asked to go down now: another chat replaces it, and does so only
    /// once that page has left (`ChatView.presentOnRequest`). Swapping the chat under a page that
    /// was still up left that page on screen and the new chat never showed (2026-11-08 fleet run:
    /// a push for Design VP with Growth VP's page up stayed on Growth VP's page). The PAGE takes
    /// itself down: it is what is on screen, while the chat under it is not, and a view off screen
    /// in a navigation stack is not updated (v11 fleet run: the chat's host never saw the ask).
    private(set) var lowering: String?
    /// Chats whose page is asked down for a swap, so their host does not take its leaving for
    /// his Back. Marked when asked, not when the page has left: the chat's host can see its page
    /// gone before the page says it left, and took that for his Back, which ended the swap (v12
    /// fleet run: the page went down and the app stayed on the old chat).
    @ObservationIgnored private var tookDownFor: Set<String> = []

    /// The pages counted per chat, each by its own entry: a page that left the stack late (its
    /// state went after its chat had opened a new one) takes only itself off.
    @ObservationIgnored private var entries: [String: Set<UUID>] = [:]
    nonisolated static let anyEntry = UUID()

    func appeared(_ sessionId: String, entry: UUID = OrgPagesOnScreen.anyEntry) {
        entries[sessionId, default: []].insert(entry)
        sessions[sessionId] = entries[sessionId]?.count
        tookDownFor.remove(sessionId)
    }

    func left(_ sessionId: String, entry: UUID = OrgPagesOnScreen.anyEntry) {
        entries[sessionId]?.remove(entry)
        if entries[sessionId]?.isEmpty == true { entries[sessionId] = nil }
        let n = entries[sessionId]?.count
        if sessions[sessionId] != n { sessions[sessionId] = n }
        if n == nil, lowering == sessionId { lowering = nil }
    }

    /// `sessionId`'s page went down because it was asked to (`lower`), not by his Back. Once.
    func tookDown(_ sessionId: String) -> Bool { tookDownFor.remove(sessionId) != nil }

    /// A page of `sessionId`'s chat is on screen.
    func has(_ sessionId: String) -> Bool { sessions[sessionId] != nil }

    /// Ask `sessionId`'s page to go down (it dismisses itself, without animation).
    func lower(_ sessionId: String) {
        tookDownFor.insert(sessionId)
        lowering = sessionId
    }

    func endLowering() { lowering = nil }

    /// `sessionId`'s chat sees no page over it any more (its host's route went nil): whatever
    /// the pages still count for it is gone.
    func gone(_ sessionId: String) {
        entries[sessionId] = nil
        guard sessions[sessionId] != nil else { return }
        sessions[sessionId] = nil
        if lowering == sessionId { lowering = nil }
    }

    /// A page of a chat other than `sessionId` is still on screen.
    func othersThan(_ sessionId: String) -> Bool { sessions.keys.contains { $0 != sessionId } }
}

/// One node page's place in `OrgPagesOnScreen`: counted once, from the page's first appearance,
/// until the page's state goes (it left the stack). Held in the page's `@State`, so a tab that
/// hides the page keeps it counted.
final class OrgPageStackEntry {
    private let entry = UUID()
    private var sessionId: String?

    @MainActor
    func register(_ sessionId: String) {
        guard self.sessionId == nil else { return }
        self.sessionId = sessionId
        OrgPagesOnScreen.shared.appeared(sessionId, entry: entry)
    }

    deinit {
        guard let id = sessionId else { return }
        let entry = entry
        Task { @MainActor in OrgPagesOnScreen.shared.left(id, entry: entry) }
    }

}

/// One chat replacing another that has its node's page up (`ChatView.presentOnRequest`): the
/// old page goes down (`lowering`), the next chat goes up in place and its page after it
/// (`pushing`), then `done`; `dropped` when a move of his ended it, `longWay` when it went back
/// through the chat list because the swap in place did not take. Only a move of his ends it.
struct OrgChatSwap {
    enum Phase: String { case lowering, pushing, done, dropped, longWay }
    var target: WalnutSession
    var page: OrgNodePageLink.Request?
    /// The chat it replaces.
    let from: String
    let token = UUID()
    var phase: Phase = .lowering

    /// How long the old page has to go down before the swap goes ahead anyway.
    static let lowerSeconds: Double = 1
    /// How long the next chat's page has to come up before it is asked for again.
    static let pushSeconds: Double = 1.5
}

/// The second half of an open: a request `ChatView` matched to the node's chat, waiting for the
/// page that applies it. Observed by the pages themselves, never handed down as a parameter:
/// SwiftUI does not reliably pass a new value into a page a `navigationDestination` already
/// shows (2026-11-06 gate, round 4: with the VP's page up, each tap read the node's detail and
/// stopped there; no read of its threads followed, so nothing moved on screen).
///
/// Who takes a request (`OrgNodePageLinkModel`): the node's page already on screen applies it
/// itself (its view to Threads, the thread focused, a fresh read, one reveal per request time);
/// the node's chat with no page up pushes one for it. Only the Chat tab's copies follow it.
@Observable
@MainActor
final class OrgNodePageLink {
    static let shared = OrgNodePageLink()

    nonisolated static let requestTTL: TimeInterval = OrgNodeLink.requestTTL

    struct Request: Equatable {
        /// The node's task (the CEO's or a VP's).
        let nodeId: String
        /// The node's chat the request was matched to.
        let sessionId: String
        let tab: OrgNodeTab
        let threadId: String?
        let at: Date
        /// Its page goes up without the push animation: the chat it belongs to replaced another
        /// chat's page in the same step (`ChatView.presentOnRequest`).
        var instant = false
    }

    /// Which page applied a request: the one already on screen, or one pushed for it.
    enum Taker: String, Equatable { case livePage, newPage }

    /// The last request a page applied, and the view and thread that page shows for it. Read
    /// by the tests (the page's own state, as the page set it) and written to the log.
    struct Delivery: Equatable {
        let request: Request
        let by: Taker
        let tab: OrgNodeTab
        let focus: OrgThreadFocus?
        /// Something the page had opened over itself is still up once it applied the request.
        var covered = false
    }

    /// The request no page has applied yet; a newer one replaces it.
    private(set) var pending: Request?
    private(set) var lastDelivery: Delivery?

    /// `shared` in the app; a test makes its own.
    init() {}

    func post(_ request: Request) {
        pending = request
        AppLog.info("org", "node page focus posted", [
            "taskId": request.nodeId, "sessionId": request.sessionId,
            "threadId": request.threadId ?? "", "tab": request.tab.rawValue,
        ])
    }

    /// Take the pending request when it is for this node's chat, and fresh. A stale one is dropped.
    func take(nodeId: String, sessionId: String?, now: Date = Date()) -> Request? {
        guard let request = pending, request.nodeId == nodeId, request.sessionId == sessionId else { return nil }
        pending = nil
        return ContentActionLink.isFresh(request.at, now: now, ttl: Self.requestTTL) ? request : nil
    }

    /// Drop `request` if it still waits (its open failed or was overtaken). A newer one stays.
    func withdraw(_ request: Request) {
        if pending == request { pending = nil }
    }

    /// The Chat tab moved to another chat (or back to the chat itself): a request for any other
    /// chat no longer belongs to what is on screen, so the same chat opened later from the drawer
    /// opens on the chat, not on that thread again.
    func drop(unlessSession sessionId: String?) {
        if let request = pending, request.sessionId != sessionId { pending = nil }
    }

    func noteDelivered(_ request: Request, by: Taker, state: OrgNodePageFocusModel.State, covered: Bool = false) {
        lastDelivery = Delivery(request: request, by: by, tab: state.tab, focus: state.focus, covered: covered)
        AppLog.info("org", "node page focus applied", [
            "taskId": request.nodeId, "threadId": request.threadId ?? "",
            "tab": state.tab.rawValue, "by": by.rawValue, "covered": covered ? "yes" : "no",
        ])
    }
}

/// Which page applies a pending request. Pure; pinned in `OrgNodePageLinkTests`.
enum OrgNodePageLinkModel {
    enum HostAction: Equatable {
        /// Not this chat's request, or not a chat that follows links.
        case none
        /// No page is up for the node: the chat pushes one with the request.
        case pushPage
        /// The node's page is up: it applies the request itself (`pageTakes`).
        case leaveToPage
    }

    /// What the node's chat does. `presentedNodeId`: the node whose page this chat shows now.
    static func hostAction(
        _ request: OrgNodePageLink.Request?, follows: Bool, sessionId: String, nodeId: String?,
        presentedNodeId: String?
    ) -> HostAction {
        guard follows, let request, let nodeId, request.nodeId == nodeId, request.sessionId == sessionId else {
            return .none
        }
        return presentedNodeId == nodeId ? .leaveToPage : .pushPage
    }

    /// Whether the node's page on screen takes the request.
    static func pageTakes(
        _ request: OrgNodePageLink.Request?, follows: Bool, nodeId: String, sessionId: String?
    ) -> Bool {
        guard follows, let request else { return false }
        return request.nodeId == nodeId && request.sessionId == sessionId
    }
}

/// Which chat an Org node open (a thread push) can show at once, from what the phone already
/// holds, before the node's record is read: the page opens with no wait, offline too, and the
/// read behind it moves to a newer chat only when the node has one (2026-11-08 review: with the
/// page up, a push waited on a network round trip with nothing on screen, and did nothing
/// offline). Pure; pinned in `OrgNodePageLinkTests`.
enum OrgOpenPlan {
    /// `shown`: the chat on screen now. `knownIds`: the node's own session ids from its last
    /// read (newest last, `TasksStore.knownSessionIds`). `sessions`: the session rows the phone has.
    static func localSession(
        taskId: String, shown: WalnutSession?, knownIds: [String]?, sessions: [WalnutSession]
    ) -> WalnutSession? {
        guard !taskId.isEmpty else { return nil }
        // The node's chat on screen is the one he is in.
        if let shown, shown.taskId == taskId { return shown }
        // The node's own list names its sessions; the newest one the phone has a row for.
        for id in (knownIds ?? []).reversed() {
            if let row = sessions.first(where: { $0.id == id }) { return row }
        }
        // Else its most recently active row.
        return sessions.filter { $0.taskId == taskId }.max { activity($0) < activity($1) }
    }

    private static func activity(_ s: WalnutSession) -> Date {
        WalnutTask.parseISO(s.lastActiveAt) ?? WalnutTask.parseISO(s.startedAt) ?? .distantPast
    }

    /// What the read of the node's record does once the page is open from `local`: nothing when
    /// it names the chat on screen (or none, or he went elsewhere meanwhile), else open that one.
    static func follows(current: String?, local: String?, shown: String?) -> Bool {
        guard let current, !current.isEmpty, current != local else { return false }
        // He is no longer on the chat the open put up: what he picked stays.
        if let local, shown != local { return false }
        return true
    }
}

extension WalnutSession {
    /// This session as its task's: the task id (and title) filled in when the row lacks them. A
    /// session read by id on a cold start, before the task list is in, came back with no task, so
    /// its chat did not know it was an Org node's and never opened the node's page (2026-11-08
    /// review); the open has just read the task, so it says whose it is.
    func claimed(byTask owner: String, title ownerTitle: String?) -> WalnutSession {
        guard !owner.isEmpty, taskId?.isEmpty ?? true else { return self }
        return WalnutSession(
            id: id, title: title, taskId: owner, taskTitle: taskTitle ?? ownerTitle, project: project,
            host: host, processStatus: processStatus, model: model, mode: mode, startedAt: startedAt,
            lastActiveAt: lastActiveAt, messageCount: messageCount, cwd: cwd, pinned: pinned,
            focusTier: focusTier, description: description
        )
    }
}
