import SwiftUI

/// The three views of an Org node beside its chat, as on the web Org page's side bar: Threads
/// first (his own requests), then Tasks and Brief.
enum OrgNodeTab: String, CaseIterable, Identifiable, Hashable {
    case threads, tasks, brief
    var id: String { rawValue }
    var label: String {
        switch self {
        case .threads: return "Threads"
        case .tasks: return "Tasks"
        case .brief: return "Brief"
        }
    }
    var symbol: String {
        switch self {
        case .threads: return "bubble.left.and.text.bubble.right"
        case .tasks: return "checklist"
        case .brief: return "doc.text"
        }
    }
}

/// Which node page to show, and on which view: an item for `navigationDestination`.
struct OrgNodeRoute: Hashable, Identifiable {
    let nodeId: String
    let name: String
    let isMain: Bool
    let sessionId: String?
    var tab: OrgNodeTab = .threads
    var threadId: String? = nil
    /// When a push or a link asked for this (nil for the bar's own buttons). A second request
    /// for the page already shown is told apart by it, a repeated tap of one thread included.
    var requestedAt: Date? = nil
    var id: String { "\(nodeId)|\(tab.rawValue)|\(threadId ?? "")" }
}

/// The node a chat belongs to, as its page needs it.
struct OrgNodeIdentity: Equatable {
    let id: String
    let name: String
    let isMain: Bool
}

/// An Org node's chat as the host of its page. The bar's buttons set `route`; when `follows`
/// (the Chat tab's copy of the chat), it also follows `OrgNodePageLink`: with no page up it
/// pushes one for a request, and with the page up it leaves the request to that page, which
/// observes the same mailbox. Nothing here hands a new value to a page already shown.
struct OrgNodePageHost: ViewModifier {
    @Binding var route: OrgNodeRoute?
    let node: OrgNodeIdentity?
    let sessionId: String
    let follows: Bool
    let link: OrgNodePageLink
    /// The page he had open over this chat before the app was relaunched (`ViewMemory`), put
    /// back once by the launch's restore. Given only by that restore.
    var restore: OrgNodeTab? = nil
    /// The chat stops covering itself (`SessionConversationView.coveredUntilPage`): the restored
    /// page is on top, or it will not go up.
    var uncover: () -> Void = {}
    @Environment(\.orgPagePlace) private var orgPagePlace
    @State private var pages = OrgPagesOnScreen.shared
    @State private var restoreTried = false
    /// The route this host pushed for a request: its own push, not a move of his.
    @State private var requested: OrgNodeRoute?
    /// A request taken while another chat's page was still leaving the stack.
    @State private var waiting: OrgNodePageLink.Request?

    func body(content: Content) -> some View {
        content
            .navigationDestination(item: $route) { route in
                OrgNodePage(route: route, followsLinks: follows, link: link)
                    // Said again here: a pushed page is not promised the environment of its host.
                    .environment(\.orgPagePlace, orgPagePlace)
            }
            .onAppear {
                follow()
                restoreKept()
            }
            // The chat learns late that it is an Org node's (the task read by id).
            .onChange(of: node?.id) {
                follow()
                restoreKept()
            }
            .onChange(of: link.pending) { follow() }
            // The other chat's page has left: the one waiting goes up.
            .onChange(of: pages.sessions) { pushWaiting(force: false) }
            // Back from the page, or a page he opened from the bar, is his own move: an open on
            // its way gives way to it (2026-11-08 review, round 2: a slow push came back after
            // he had gone Back to the chat).
            .onChange(of: route) { old, new in
                guard follows else { return }
                if new == nil, old != nil {
                    // No page over this chat any more, whatever the page's state still says.
                    pages.gone(sessionId)
                    // Taken down for another chat's page (`OrgPagesOnScreen.lower`), not his Back.
                    if pages.tookDown(sessionId) { return }
                    OrgUserNavigation.shared.moved("org page back")
                } else if let new, new != requested {
                    OrgUserNavigation.shared.moved("org page opened")
                }
            }
    }

    private func follow() {
        let action = OrgNodePageLinkModel.hostAction(
            link.pending, follows: follows, sessionId: sessionId, nodeId: node?.id, presentedNodeId: route?.nodeId)
        guard action == .pushPage, let node, let request = link.take(nodeId: node.id, sessionId: sessionId) else { return }
        // This chat just replaced another chat whose page is still on its way out: two page
        // changes in one update lost the new one, so this one waits for that page to leave. A page
        // that never says it left holds it a second at most.
        if follows, pages.othersThan(sessionId) {
            waiting = request
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                pushWaiting(force: true)
            }
            return
        }
        push(request)
    }

    /// The kept page goes back up over the restored chat, once the chat's own push has settled
    /// (pushed in the same moment, Back took both off and left no chat under them). A push or a
    /// link in this run wins over the place kept from before: anything asked for an Org node
    /// since launch, or a request waiting for this chat, and it does not go up. It is this host's
    /// own push (`requested`), never a move of his, so it cancels no open on its way.
    private func restoreKept() {
        guard let restore, !restoreTried, node != nil else { return }
        restoreTried = true
        guard route == nil else { uncover(); return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            guard let node, route == nil, link.pending == nil, !OrgNodeLink.shared.askedThisRun else {
                uncover()
                return
            }
            let next = OrgNodeRoute(nodeId: node.id, name: node.name, isMain: node.isMain, sessionId: sessionId, tab: restore)
            requested = next
            // Under the chat's cover nobody sees the chat, so the page lands without sliding in,
            // and the cover leaves in the same moment.
            var still = Transaction()
            still.disablesAnimations = true
            withTransaction(still) {
                route = next
                uncover()
            }
        }
    }

    private func pushWaiting(force: Bool) {
        guard let request = waiting, force || !pages.othersThan(sessionId) else { return }
        waiting = nil
        push(request)
    }

    private func push(_ request: OrgNodePageLink.Request) {
        guard let node else { return }
        let next = OrgNodeRoute(
            nodeId: node.id, name: node.name, isMain: node.isMain, sessionId: sessionId,
            tab: request.tab, threadId: request.threadId, requestedAt: request.at)
        requested = next
        guard request.instant else {
            route = next
            return
        }
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) { route = next }
    }
}

/// An Org node's page on the phone: one of Threads, Tasks and Brief at a time, picked at the top.
/// Its chat stays a Back away.
struct OrgNodePage: View {
    let route: OrgNodeRoute
    /// The Chat tab's copy takes the requests `OrgNodePageLink` holds for its node.
    let followsLinks: Bool
    let link: OrgNodePageLink
    /// The view shown and the thread asked for: the route's as the page opens, then each newer
    /// request's this page takes from `link` (`OrgNodePageFocusModel`).
    @State private var page: OrgNodePageFocusModel.State
    /// The request whose thread the Threads view has scrolled to (it owes each request one reveal).
    @State private var revealedAt: Date?
    /// What the page shows over itself (a task's session, a Follow up composer). Owned here, so
    /// a request this page takes takes it down and the page underneath is what he sees.
    @State private var cover: OrgNodePageCover?
    @State private var threads: OrgThreadsStore
    @State private var openNoted = false
    @Environment(TasksStore.self) private var tasks
    @Environment(\.orgPagePlace) private var orgPagePlace
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.dismiss) private var dismiss
    @State private var pages = OrgPagesOnScreen.shared
    /// This page's place among the Chat tab's pages on the stack (`OrgPagesOnScreen`).
    @State private var stackEntry = OrgPageStackEntry()
    /// Optional: a page hosted where the app's connection is not in the environment (a test's
    /// host, a preview) still opens; it then only misses the re-read when the app comes back online.
    @Environment(ConnectionStore.self) private var connection: ConnectionStore?

    init(route: OrgNodeRoute, followsLinks: Bool = false, link: OrgNodePageLink? = nil,
         cover: OrgNodePageCover? = nil) {
        self.route = route
        self.followsLinks = followsLinks
        self.link = link ?? .shared
        _page = State(initialValue: OrgNodePageFocusModel.initial(route))
        _cover = State(initialValue: cover)
        _threads = State(initialValue: OrgThreadsStore(taskId: route.nodeId))
    }

    private var node: WalnutTask? { tasks.tasks.first { $0.id == route.nodeId } }

    var body: some View {
        VStack(spacing: 0) {
            viewPicker
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            Divider()
            Group {
                switch page.tab {
                case .threads:
                    OrgThreadsView(store: threads, name: route.name, sessionId: route.sessionId,
                                   focus: page.focus, revealedAt: $revealedAt, cover: $cover,
                                   nodeShown: node?.userStatus?.threads?.shown)
                case .tasks:
                    OrgNodeTasksView(nodeId: route.nodeId, isMain: route.isMain) { cover = .task($0) }
                case .brief:
                    OrgBriefView(taskId: route.nodeId, name: route.name)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(route.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // What the phone last read for this node first (offline too), then the server's.
            await threads.hydrate()
            await threads.load()
        }
        // The view on screen is the page a relaunch puts back over the chat (`ViewMemory`).
        .onChange(of: page.tab) { _, picked in
            guard let key = orgPagePlace.keyId(route.nodeId) else { return }
            ViewMemory.write(picked, "org", "page", id: key)
        }
        .onAppear {
            noteOpenedForRequest()
            takeLinkRequest()
            // On the stack from now until its state goes; another tab in front does not end it.
            if followsLinks, let sessionId = route.sessionId { stackEntry.register(sessionId) }
        }
        // Another chat replaces this page's chat: the page goes down first, at once, so the stack
        // is never asked to swap the chat under a page that is still up. The page does it itself,
        // because it is on screen and the chat under it is not.
        .onChange(of: pages.lowering, initial: true) { _, lowering in
            guard followsLinks, let sessionId = route.sessionId, lowering == sessionId else { return }
            var instant = Transaction()
            instant.disablesAnimations = true
            withTransaction(instant) { dismiss() }
        }
        // A read that answered says the server is reachable: the app's offline line and the
        // open's notice follow it at once, not the reachability probe's next turn.
        .onChange(of: threads.lastRead) { _, read in
            if read?.failed == false { connection?.reportReachability(true, source: "org-threads-rest") }
        }
        // Back online after a read that failed: read again, so the page stops saying it is old.
        .onChange(of: connection?.online) { _, online in
            if online == true, threads.lastRead?.failed == true { Task { await threads.load() } }
        }
        // While its read has failed, the page on screen asks again every few seconds: the app's
        // own reachability probe backs off to tens of seconds, and a pull reads only from the top
        // of the list, which a reveal has scrolled away from (2026-11-08 fleet run: Walnut was
        // back and the page still said it showed the phone's copy). Off screen, it stops.
        .task(id: threads.lastRead?.failed == true) {
            while threads.lastRead?.failed == true, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(OrgThreadsStore.retrySeconds))
                guard !Task.isCancelled, threads.lastRead?.failed == true else { return }
                if !threads.loading { await threads.load() }
            }
        }
        // A newer request for this node while its page is up (another thread's push, the same
        // one tapped again, a push while Tasks or Brief is in front): the page takes it from the
        // mailbox it observes, its view comes forward and its thread is read afresh, then shown.
        .onChange(of: link.pending) { takeLinkRequest() }
        // The node's own row moves when its threads change (its status carries their counts).
        .onChange(of: node?.userStatus?.threads) { Task { await threads.load() } }
        .sheet(item: $cover) { cover in
            coverView(cover)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        // A container, so the page's identifier stays its own: on the bare stack it replaced every
        // identifier inside it (the view switch read `org.node.page`, never `org.node.tabs`).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("org.node.page")
    }

    /// Three segments side by side at ordinary sizes. At the accessibility sizes three labels
    /// never fit one row (each read "T…", and the row grew taller than the page's content), so the
    /// picker collapses to one full-width button naming the view shown, with the others in its menu.
    @ViewBuilder private var viewPicker: some View {
        if OrgNodeBarLayout.collapses(typeSize) {
            Menu {
                Picker("View", selection: $page.tab) {
                    ForEach(OrgNodeTab.allCases) { t in
                        Label(label(t), systemImage: t.symbol).tag(t)
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: page.tab.symbol)
                    Text(label(page.tab)).lineLimit(1).minimumScaleFactor(0.7)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up.chevron.down").font(.footnote)
                }
                .font(.body.weight(.medium))
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(Color(uiColor: .tertiarySystemFill).opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .dynamicTypeSize(...OrgNodeBarLayout.typeCap)
            .accessibilityLabel("View: \(label(page.tab))")
            .accessibilityIdentifier("org.node.tabs")
        } else {
            Picker("View", selection: $page.tab) {
                ForEach(OrgNodeTab.allCases) { t in
                    Text(label(t)).tag(t)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("org.node.tabs")
        }
    }

    @ViewBuilder
    private func coverView(_ cover: OrgNodePageCover) -> some View {
        switch cover {
        case .task(let target):
            TaskSessionSheet(target: target)
        case .followUp(let threadId, let title):
            OrgThreadFollowUpSheet(title: title, draftKey: OrgThreadFollowUpDraft.key(nodeId: route.nodeId, threadId: threadId)) { text, images in
                guard let sessionId = route.sessionId else { return false }
                return await threads.followUp(threadId, sessionId: sessionId, text: text, images: images)
            }
        }
    }

    /// A page pushed for a request says so once, with the view and thread it opened on.
    private func noteOpenedForRequest() {
        guard followsLinks, !openNoted, let at = route.requestedAt else { return }
        openNoted = true
        let request = OrgNodePageLink.Request(
            nodeId: route.nodeId, sessionId: route.sessionId ?? "", tab: route.tab,
            threadId: route.threadId, at: at)
        link.noteDelivered(request, by: .newPage, state: page)
    }

    /// The request for this node's chat, if one waits: applied here, once per request time.
    private func takeLinkRequest() {
        guard OrgNodePageLinkModel.pageTakes(
            link.pending, follows: followsLinks, nodeId: route.nodeId, sessionId: route.sessionId),
              let request = link.take(nodeId: route.nodeId, sessionId: route.sessionId),
              let applied = OrgNodePageFocusModel.apply(request, to: page) else { return }
        page = applied
        // A task's session or a composer opened from this page would hide the Threads view the
        // request brought forward: it goes down first (2026-11-06 gate: a push with a task open
        // from Tasks switched the page underneath and changed nothing he could see).
        cover = OrgNodePageFocusModel.cover(cover, after: applied)
        link.noteDelivered(request, by: .livePage, state: applied, covered: cover != nil)
        Task { await threads.load() }
    }

    private func label(_ t: OrgNodeTab) -> String {
        guard t == .threads else { return t.label }
        let read = threads.threads.map { OrgThreadModel.sections($0, now: AppClock.now()).open.count }
        // A read that brought none of the threads the counts name shows those counts, as its page says.
        // "Threads 0" too, as the bar under the chat reads (the owner: "even if no thread, show 0"),
        // but no number while the page could read none and holds none (`tabCount`).
        guard let shown = OrgThreadsStore.tabCount(read: read, serverCount: threads.shownCount,
                                                   nodeCount: node?.userStatus?.threads?.shown,
                                                   readFailed: threads.lastRead?.failed == true) else { return "Threads" }
        return "Threads \(shown)"
    }
}

/// The row at the top of an Org node's chat that opens its Threads, Tasks and Brief, each its own
/// page. Threads lead and carry the count of the ones for him (coloured when one waits on him).
/// How the Org node's bars give way at the accessibility text sizes (2026-11-08, a QA run at
/// accessibility XXXL: the three buttons of the chat's bar each read "T…", the bar took a sixth
/// of the screen and left the chat about one line tall). From the first accessibility size the
/// bar keeps one row of icons with the threads count, its type capped at the largest standard
/// size, and a long press shows each button's name large (the Large Content Viewer, as the tab
/// bar does); the node page's picker becomes one button with a menu.
enum OrgNodeBarLayout {
    static let typeCap = DynamicTypeSize.xxxLarge
    static func collapses(_ size: DynamicTypeSize) -> Bool { size.isAccessibilitySize }
}

struct OrgNodeBar: View {
    let node: WalnutTask
    let open: (OrgNodeTab) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let counts = node.userStatus?.threads
        let compact = OrgNodeBarLayout.collapses(typeSize)
        HStack(spacing: 8) {
            ForEach(OrgNodeTab.allCases) { t in
                Button { open(t) } label: {
                    HStack(spacing: 5) {
                        Image(systemName: t.symbol).font(compact ? .body : .footnote)
                        if !compact {
                            Text(t.label).font(.subheadline.weight(.medium))
                        }
                        if t == .threads {
                            let n = counts?.shown ?? 0
                            Text("\(n)")
                                .font(.caption.monospacedDigit().weight(.bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                // The drawer's count for the same node (ChatDrawerOrg): one colour for one number.
                                .background(n > 0 ? UserStatePill.color(.needs) : Color(.systemGray3), in: Capsule())
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: compact ? 44 : 36)
                    .background(Color(uiColor: .tertiarySystemFill).opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(t == .threads ? "Threads, \(counts?.shown ?? 0)" : t.label)
                .accessibilityShowsLargeContentViewer {
                    Label(t == .threads ? "Threads \(counts?.shown ?? 0)" : t.label, systemImage: t.symbol)
                }
                .accessibilityIdentifier("org.bar.\(t.rawValue)")
            }
        }
        .dynamicTypeSize(...OrgNodeBarLayout.typeCap)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
        // A visible edge: the chat scrolls under the bar, and a line cut by it must read as scrolled.
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color(uiColor: .separator)).frame(height: 0.5)
        }
        .shadow(color: .black.opacity(0.08), radius: 4, y: 2)
        .zIndex(1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("org.bar")
    }
}
