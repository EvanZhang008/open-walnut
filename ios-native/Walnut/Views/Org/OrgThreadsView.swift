import SwiftUI

/// An Org node's Threads on the phone: the user's own requests to Main or a VP, one card per
/// subject, as the web's Threads view (`web/src/components/org/OrgThreads.tsx`). What is for him
/// now leads; snoozed, in progress and closed threads wait behind one quiet line each.
struct OrgThreadsView: View {
    let store: OrgThreadsStore
    /// The node's name ("Walnut VP", "CEO").
    let name: String
    /// The node's chat, for Follow up; nil when it has none yet.
    let sessionId: String?
    /// The thread a push or a link asked for, by request: shown open, scrolled to and marked
    /// for a moment, once per request (`OrgThreadRevealModel`).
    var focus: OrgThreadFocus? = nil
    /// The request already revealed; the node's page keeps it, so a tab switch does not scroll again.
    var revealedAt: Binding<Date?> = .constant(nil)
    /// What the node's page shows over itself. A card asks for a task's session here and the
    /// page presents it, so a request the page takes can take it down.
    let cover: Binding<OrgNodePageCover?>

    /// How many threads the node's own status counts for him (`user_status.threads.shown`).
    var nodeShown: Int? = nil

    private var focusThreadId: String? { focus?.threadId }

    /// The folds he opened while on this page, per node ("<node>/<fold>"). Plain view state, never
    /// kept: coming back shows every fold folded again, Needs you and Done open above them, as the
    /// web does (2026-11-21, the user: "the rest are auto collapsed", and folded again next time).
    @State private var openFolds: Set<String> = []
    /// The card just revealed, marked until a moment after (`highlightSeconds`).
    @State private var highlight: OrgThreadFocus?
    /// DEBUG: the card the UI tests read as just revealed (`testMarkSeconds`).
    @State private var testMark: OrgThreadFocus?
    /// The thread asked for is not on the page any more.
    @State private var missingShown = false
    /// The thread asked for is not on the list, and its read by id failed.
    @State private var uncheckedShown = false
    /// Cards have been in sight on this view, so a later reveal scrolls in view instead of hiding them.
    @State private var cardsShown = false
    /// The jump to the thread of a view that has not shown its cards yet is under way.
    @State private var scrolling = false
    /// The hold for a reveal ran its limit (`holdSeconds`); the cards show whatever the read does.
    @State private var holdExpired = false
    /// Where the requested thread's card sits in the list's viewport, and that viewport's height:
    /// a reveal checks the jump landed (`land`).
    @State private var focusTop: OrgThreadRevealModel.CardTop?
    @State private var listHeight: CGFloat = 0
    /// A reveal checking its jump landed; his own scroll or jump ends it.
    @State private var landing: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private typealias Fold = OrgThreadRevealModel.Fold

    private func foldBinding(_ fold: Fold) -> Binding<Bool> {
        let key = "\(store.taskId)/\(fold.rawValue)"
        return Binding(
            get: { openFolds.contains(key) },
            set: { on in
                if on { openFolds.insert(key) } else { openFolds.remove(key) }
            }
        )
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { ctx in
            let now = ctx.date.addingTimeInterval(AppClock.demoOffset)
            content(now: now)
        }
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        let all = store.threads ?? []
        let sections = OrgThreadModel.sections(all, now: now)
        let shared = OrgThreadModel.sharedAnswers(all)
        let broughtNone = OrgThreadRevealModel.broughtNone(
            threads: store.threads, sections: sections, serverCount: store.shownCount, nodeCount: nodeShown)
        let key = revealKey(sections, broughtNone: broughtNone)
        // A view opened for a thread keeps its cards out of sight until it can show that thread,
        // so it does not show other cards first and then jump (2026-11-06 gate). A read that
        // brought none of his threads shows its retry at once, as a failed one shows its error.
        let hides = OrgThreadRevealModel.hidesCards(
            owes: OrgThreadRevealModel.owes(focus, revealedAt: revealedAt.wrappedValue), outcome: key.outcome,
            lastReadFailed: (store.lastRead?.failed ?? false) || broughtNone, scrolling: scrolling, cardsShown: cardsShown,
            waitedTooLong: holdExpired)
        ScrollViewReader { proxy in
            ScrollView {
                // A plain stack: only the open cards render (the rest sit behind folds), and a
                // lazy stack re-measuring folded Markdown as cards came into view never settled.
                VStack(alignment: .leading, spacing: 12) {
                    if missingShown {
                        revealNotice(OrgThreadRevealModel.missingText, detail: OrgThreadRevealModel.missingDetail,
                                     symbol: "tray", id: "org.threads.missing") { missingShown = false }
                    }
                    if uncheckedShown {
                        revealNotice(OrgThreadRevealModel.uncheckedText, detail: nil,
                                     symbol: "wifi.exclamationmark", id: "org.threads.unchecked") { uncheckedShown = false }
                    }
                    if let error = store.error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(Theme.needsText)
                            .accessibilityIdentifier("org.threads.error")
                    }
                    // Nothing read and no copy on the phone (offline on a first visit): the thread
                    // the notification named, in its own words.
                    if store.threads == nil, store.error != nil, let focus,
                       let preview = OrgNodeLink.shared.preview(focus.threadId) {
                        pushPreview(title: preview.title, ask: preview.ask)
                    }
                    if store.threads == nil {
                        if store.error == nil {
                            ProgressView("Loading threads…")
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        }
                    } else if sections.open.isEmpty, let expected = OrgThreadModel.unreadCount(serverCount: store.shownCount, nodeCount: nodeShown, read: sections.open.count) {
                        unreadable(expected)
                    } else if sections.open.isEmpty {
                        emptyText(sections)
                    }
                    // Watching first: the ones he watches, each also in its own group below
                    // (2026-11-23, the user: a watch is its own category, like a task's).
                    watchingGroup(sections, shared: shared, now: now)
                    // Needs you, then Done: always open, each under its head with its count, as
                    // the web draws them (each in its own order). No row of tabs or chips.
                    ForEach(OrgThreadModel.openGroups, id: \.self) { g in
                        openGroup(g, sections: sections, shared: shared, now: now)
                    }
                    // The rest, each folded to its name and count until he taps its head, and
                    // folded again next time (`openFolds`).
                    ForEach(Fold.allCases, id: \.self) { f in
                        foldGroup(f, sections: sections, shared: shared, now: now, proxy: proxy)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                // Room under the last section, so a fold opened or a thread revealed near the end
                // can come to the top, and nothing ends under the floating tab bar.
                .padding(.bottom, 240)
                .opacity(hides ? 0 : 1)
            }
            .coordinateSpace(.named(Self.scrollSpace))
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listHeight = $0 }
            .overlay(alignment: .top) {
                if hides {
                    ProgressView()
                        .padding(.top, 40)
                        .accessibilityIdentifier("org.threads.opening")
                }
            }
            .refreshable { await store.refresh() }
            .onScrollPhaseChange { _, phase in
                guard phase == .interacting else { return }
                // He scrolls: a reveal still checking its jump stops putting the thread back.
                endLanding()
                #if DEBUG
                testMark = nil
                #endif
            }
            // Each request once: when it comes, and again as reads land until one has it.
            .onChange(of: key, initial: true) { _, key in
                reveal(key, sections: sections, proxy: proxy)
            }
            .onChange(of: hides, initial: true) { _, hidden in
                if !hidden { cardsShown = true }
            }
            .task {
                try? await Task.sleep(for: .seconds(OrgThreadRevealModel.holdSeconds))
                holdExpired = true
            }
        }
        #if DEBUG
        // The last reveal, kept until the next one (`DebugRevealRecord`).
        .overlay(alignment: .topLeading) { DebugRevealRecord.Marker() }
        #endif
        // A container, so the list's identifier does not replace those inside it (the cards' and folds').
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("org.threads")
    }

    private func card(_ t: OrgThread, shared: Set<String>, now: Date, snoozed: Bool, compact: Bool = false) -> some View {
        let focused = t.id == focusThreadId
        return OrgThreadCard(
            thread: t, all: store.threads ?? [], shared: shared, name: name, now: now, snoozed: snoozed,
            busy: store.busyThreadId == t.id, canFollowUp: sessionId != nil,
            startsOpen: t.id == focusThreadId, compact: compact, followUpSentAt: store.followUpSentAt[t.id],
            followUpKey: OrgThreadFollowUpDraft.key(nodeId: store.taskId, threadId: t.id), nodeTaskId: store.taskId, nodeSessionId: sessionId,
            highlighted: highlight?.threadId == t.id,
            highlightFocus: highlight?.threadId == t.id ? highlight : nil,
            testMarked: testMark?.threadId == t.id,
            onEdit: { edit in Task { await store.edit(t.id, edit) } },
            onOpenTask: { cover.wrappedValue = .task($0) },
            onFollowUp: { text, images in
                guard let sessionId else { return false }
                return await store.followUp(t.id, sessionId: sessionId, text: text, images: images)
            },
            onPick: { label in
                // A choice tapped is his answer in words, filed under the thread like a Follow up.
                guard let sid = sessionId else { return }
                Task { _ = await store.followUp(t.id, sessionId: sid, text: label) }
            },
            onWhole: { await store.loadWhole(t.id) }
        )
        // The requested card's place in the viewport, for the reveal to check its jump.
        // Nil on every other card, so only the requested one reports, and it reports again as it
        // becomes the requested one.
        .onGeometryChange(for: CGFloat?.self) { focused ? $0.frame(in: .named(Self.scrollSpace)).minY : nil } action: { top in
            if let top { focusTop = .init(id: t.id, top: top) }
        }
    }

    /// The list's viewport, for the cards' places in it.
    private static let scrollSpace = "org.threads.scroll"

    private struct RevealKey: Equatable {
        let focus: OrgThreadFocus?
        let outcome: OrgThreadRevealModel.Outcome?
    }

    private func revealKey(_ sections: OrgThreadModel.Sections, broughtNone: Bool) -> RevealKey {
        RevealKey(focus: focus, outcome: focus.map {
            OrgThreadRevealModel.outcome($0, threads: store.threads, sections: sections, lastRead: store.lastRead,
                                         broughtNone: broughtNone, probe: store.probes[$0.threadId],
                                         byIdOnly: store.byIdOnly)
        })
    }

    /// The notification's words for a thread the page cannot read yet.
    private func pushPreview(title: String?, ask: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("From the notification")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if let title { Text(title).font(.headline) }
            if let ask { Text(ask).font(.subheadline) }
            Text("The whole thread shows when Walnut can be reached.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.tint, lineWidth: 1.5))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("org.threads.pushPreview")
    }

    /// What became of the thread a push asked for, when it is not on the page: a card at the top
    /// of the list, in words, with a close button (2026-11-08 review: one grey footnote was easy
    /// to miss, and said nothing of why).
    private func revealNotice(_ text: String, detail: String?, symbol: String, id: String,
                              close: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .font(.body)
                .foregroundStyle(Theme.tint)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(text)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { withAnimation(reduceMotion ? nil : .snappy) { close() } } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: OrgOpenNotice.closeSide, height: OrgOpenNotice.closeSide)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.top, -12)
            .padding(.trailing, -10)
            .accessibilityLabel("Dismiss")
            .accessibilityIdentifier("\(id).close")
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.tintSoft.opacity(0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.tint.opacity(0.35), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(id)
        .id(Self.noticeAnchor)
    }

    /// Where a reveal notice sits, so a page scrolled down brings it into view.
    private static let noticeAnchor = "reveal.notice"

    private func scrollToNotice(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.async {
            withAnimation(reduceMotion ? nil : .default) { proxy.scrollTo(Self.noticeAnchor, anchor: .top) }
        }
    }

    /// The requested thread: the fold it sits in opens first, then it scrolls to the top and is
    /// marked for a moment. A thread a fresh read no longer has gets one line saying so.
    private func reveal(_ key: RevealKey, sections: OrgThreadModel.Sections, proxy: ScrollViewProxy) {
        guard let focus = key.focus, let outcome = key.outcome,
              OrgThreadRevealModel.owes(focus, revealedAt: revealedAt.wrappedValue) else { return }
        switch outcome {
        case .wait:
            // An earlier request's "no longer open" is not this one's.
            missingShown = false
            uncheckedShown = false
            return
        case .probe:
            missingShown = false
            uncheckedShown = false
            // Not on the list: asked by its id; the answer comes back through the store.
            Task { await store.probe(focus.threadId) }
            return
        case .unchecked:
            // Not marked revealed: a pull that reads the list again asks for it again.
            missingShown = false
            uncheckedShown = true
            scrollToNotice(proxy)
            AccessibilityNotification.Announcement(OrgThreadRevealModel.uncheckedText).post()
        case .missing:
            revealedAt.wrappedValue = focus.at
            testMark = nil
            missingShown = true
            uncheckedShown = false
            scrollToNotice(proxy)
            AccessibilityNotification.Announcement(OrgThreadRevealModel.missingText).post()
        case .show(let fold):
            revealedAt.wrappedValue = focus.at
            missingShown = false
            uncheckedShown = false
            if let fold { foldBinding(fold).wrappedValue = true }
            // Cards not in sight yet: the jump is instant and they show once it has landed.
            let instant = !cardsShown
            if instant { scrolling = true }
            DispatchQueue.main.async {
                withAnimation(reduceMotion || instant ? nil : .default) { proxy.scrollTo(focus.threadId, anchor: .top) }
                land(focus, instant: instant, proxy: proxy)
            }
            // The keyboard goes, as the Follow up sheet once closed: a box he was writing in on
            // another card keeps its words in its draft, and the thread asked for is in sight.
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            withAnimation(reduceMotion ? nil : .easeIn(duration: 0.2)) { highlight = focus }
            testMark = focus
            #if DEBUG
            DebugRevealRecord.shared.revealed(focus)
            #endif
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(OrgThreadRevealModel.testMarkSeconds))
                if testMark == focus { testMark = nil }
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(OrgThreadRevealModel.highlightSeconds))
                guard highlight == focus else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.6)) { highlight = nil }
            }
        }
    }

    /// Checks the jump to `focus` landed, and jumps again until it has: a jump made while the
    /// list was not laid out yet in its place (a page going up as a sheet left) was undone by the
    /// layout that followed, and the list showed its top with the thread far below (2026-11-08
    /// fleet run: "frame y 3835, viewport 187 to 791"). Done once the card has been in view on
    /// two checks in a row, or after `landSeconds`; his own scroll or jump ends it at once.
    private func land(_ focus: OrgThreadFocus, instant: Bool, proxy: ScrollViewProxy) {
        landing?.cancel()
        landing = Task { @MainActor in
            let deadline = Date().addingTimeInterval(OrgThreadRevealModel.landSeconds)
            // An animated jump is left to finish before it is judged.
            if !instant { try? await Task.sleep(for: .milliseconds(500)) }
            var inView = 0
            var previous: OrgThreadRevealModel.CardTop?
            while !Task.isCancelled, Date() < deadline {
                let now = focusTop
                if OrgThreadRevealModel.landed(now, threadId: focus.threadId, viewport: listHeight, previous: previous) {
                    inView += 1
                    if scrolling { scrolling = false }
                    if inView >= 2 { break }
                } else {
                    inView = 0
                    proxy.scrollTo(focus.threadId, anchor: .top)
                }
                previous = now
                try? await Task.sleep(for: .milliseconds(60))
            }
            guard !Task.isCancelled else { return }
            if scrolling { scrolling = false }
            landing = nil
        }
    }

    private func endLanding() {
        landing?.cancel()
        landing = nil
        if scrolling { scrolling = false }
    }

    /// Every closed thread the server counts but the ones under Closed: the Archived fold's number.
    private func archivedTotal(_ s: OrgThreadModel.Sections) -> Int {
        max((store.closedCount ?? 0) - s.closed.count, s.archived.count)
    }

    /// Watching: every thread he watches, oldest watch first, each a row that opens in place; Move up
    /// and Move down (its context menu) place it, as the web's drag does.
    @ViewBuilder
    private func watchingGroup(_ sections: OrgThreadModel.Sections, shared: Set<String>, now: Date) -> some View {
        let list = sections.watching
        if !list.isEmpty {
            HStack(spacing: 6) {
                Image(systemName: "eye.fill")
                    .font(.footnote)
                    .foregroundStyle(Theme.tint)
                Text("Watching")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text("\(list.count)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
            .padding(.top, 4)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("org.threads.group.watching")
            ForEach(Array(list.enumerated()), id: \.element.id) { i, t in
                card(t, shared: shared, now: now, snoozed: sections.snoozed.contains { $0.id == t.id }, compact: true)
                    .contextMenu {
                        if i > 0 { Button("Move up") { move(list, from: i, to: i - 1) } }
                        if i < list.count - 1 { Button("Move down") { move(list, from: i, to: i + 1) } }
                    }
                    .id("watching-\(t.id)")
            }
        }
    }

    private func move(_ list: [OrgThread], from: Int, to: Int) {
        guard let at = OrgThreadModel.watchPlace(list, from: from, to: to, now: Date()) else { return }
        let id = list[from].id
        Task { await store.edit(id, .watchAt(at)) }
    }

    /// A group always open (Needs you, Done): its head, then its cards; nothing when it has none.
    @ViewBuilder
    private func openGroup(_ g: OrgThreadModel.Group, sections: OrgThreadModel.Sections, shared: Set<String>, now: Date) -> some View {
        let list = OrgThreadModel.openCards(g, sections.open, now: now)
        if !list.isEmpty {
            groupHead(g, count: list.count)
            ForEach(list) { t in card(t, shared: shared, now: now, snoozed: false).id(t.id) }
        }
    }

    /// A folded group: its head, and its cards while he has it open.
    @ViewBuilder
    private func foldGroup(_ f: Fold, sections: OrgThreadModel.Sections, shared: Set<String>, now: Date, proxy: ScrollViewProxy) -> some View {
        let list = f.threads(in: sections)
        // Archived: the server's count of every closed one but Closed's; the fold lists the newest the read brought.
        let count = f == .archived ? archivedTotal(sections) : list.count
        let open = foldBinding(f)
        fold(f, count: count, open: open, proxy: proxy)
        if open.wrappedValue {
            ForEach(list) { t in
                card(t, shared: shared, now: now, snoozed: sections.snoozed.contains { $0.id == t.id }, compact: true).id(t.id)
            }
            if f == .archived, count > list.count {
                Text("The newest \(list.count) are here; all \(count) are on the web.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("org.threads.closed.more")
            }
        }
    }

    /// The head of a group always open (Needs you, Done): its name and its count, never a button.
    private func groupHead(_ g: OrgThreadModel.Group, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(g.label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
            Text("\(count)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .monospacedDigit()
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("org.threads.group.\(g.rawValue)")
    }

    /// A folded group's head: its name and count, a row he taps to open or close it (2026-11-04
    /// review: not a caption). A group with no thread draws nothing.
    @ViewBuilder
    private func fold(_ f: Fold, count: Int, open: Binding<Bool>, proxy: ScrollViewProxy) -> some View {
        if count > 0 {
            Button {
                endLanding()
                let opening = !open.wrappedValue
                withAnimation(.snappy) { open.wrappedValue.toggle() }
                // Opened near the bottom, its cards would start under the tab bar and the tap look
                // like nothing (the web's 2026-11-21 review): the head goes to the top, its cards
                // under it, once they have laid out (scrolled at once, a short group stayed put).
                guard opening else { return }
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(150))
                    withAnimation(reduceMotion ? nil : .default) { proxy.scrollTo("fold.\(f.rawValue)", anchor: .top) }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(f.group.label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Spacer(minLength: 0)
                    Text("\(count)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    Image(systemName: open.wrappedValue ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(Color(uiColor: .secondarySystemGroupedBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open.wrappedValue ? "Shown" : "Hidden")
            .accessibilityIdentifier("org.threads.fold.\(f.rawValue)")
            .id("fold.\(f.rawValue)")
        }
    }

    /// The node's own status counts threads for him that this read did not bring: never "No open
    /// threads" then (2026-11-06: a header counting four over an empty page), but that they could
    /// not be read, with a retry.
    private func unreadable(_ expected: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Couldn't read the threads")
                .font(.headline)
            Text("\(name) has \(expected) \(expected == 1 ? "thread" : "threads") for you, but this read brought none. Try again in a moment.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Try Again") { Task { await store.load() } }
                .buttonStyle(.walnut(.secondary))
                .accessibilityIdentifier("org.threads.retry")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 24)
        .accessibilityIdentifier("org.threads.unreadable")
    }

    private func emptyText(_ s: OrgThreadModel.Sections) -> some View {
        let quiet = !s.working.isEmpty || !s.waiting.isEmpty || !s.snoozed.isEmpty || !s.known.isEmpty
        return VStack(alignment: .leading, spacing: 6) {
            Text(quiet ? "Nothing for you now" : "No open threads")
                .font(.headline)
            Text(quiet
                 ? "\(name) is on the ones below. Each comes back here when there is news."
                 : "Each request you send \(name) becomes a thread here. Asks about the same thing stay in one thread.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 24)
        .accessibilityIdentifier("org.threads.empty")
    }
}

/// One thread: its state and title, the node's summary, its tasks the summary does not name, the
/// answers he has not reacted to, the whole conversation one tap away, and what he can do.
struct OrgThreadCard: View {
    let thread: OrgThread
    let all: [OrgThread]
    let shared: Set<String>
    let name: String
    let now: Date
    let snoozed: Bool
    let busy: Bool
    let canFollowUp: Bool
    var startsOpen = false
    /// A thread with nothing for him (in progress, closed): one row until he taps it open.
    var compact = false
    /// His last Follow up on it from this phone, shown on the card for a few minutes.
    var followUpSentAt: Date? = nil
    /// This thread's Follow up draft (`OrgThreadFollowUpDraft.key`).
    var followUpKey = ""
    /// The node's own task (left out of `@`) and its chat (whose commands `/` lists).
    var nodeTaskId: String? = nil
    var nodeSessionId: String? = nil
    /// Just revealed for a push or a link: marked for a moment so the eye finds it.
    var highlighted = false
    /// The reveal `highlighted` is for (DEBUG: noted once its outline is drawn).
    var highlightFocus: OrgThreadFocus? = nil
    /// DEBUG: wears the UI tests' reveal mark.
    var testMarked = false
    let onEdit: (OrgThreadEdit) -> Void
    /// A task chip was tapped: the node's page opens its session over itself.
    let onOpenTask: (TaskOpenTarget) -> Void
    /// His Follow up from the box on the card, into the node's chat filed under this thread:
    /// true once the server took it.
    var onFollowUp: (String, [SelectedImage]) async -> Bool = { _, _ in false }
    /// A choice of a thread waiting on him was tapped: its label goes as his answer.
    var onPick: (String) -> Void = { _ in }
    /// Read this thread whole: its list read cut answers he already reacted to (`clipped`).
    var onWhole: () async -> Void = {}

    @Environment(TasksStore.self) private var tasks
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var conversation = false
    @State private var expanded = false
    @State private var pickedKey: String? = nil

    private var t: OrgThread { thread }
    private var closed: Bool { t.closed != nil }
    private var watched: Bool { OrgThreadModel.watchedNow(t) }
    private var known: Bool { OrgThreadModel.isKnown(t) }
    /// His view lists it (the server's `shown`): an answered one reads Done, else Waiting / Snoozed.
    private var inView: Bool { OrgThreadModel.inView(t, shared: shared, now: now) }

    var body: some View {
        if compact && !expanded && !startsOpen {
            compactRow
        } else {
            card
        }
    }

    /// A folded row's second line: when a snoozed thread comes back, else its state and age.
    private var rowLine: String {
        if snoozed, let sn = t.snoozed { return "Snoozed until \(OrgThreadModel.backAt(sn.until, now: now))" }
        return "\(watched ? "Watching · " : "")\(OrgThreadModel.stateLabel(t, inView: inView, now: now)) · \(timeAgo)"
    }

    private var compactRow: some View {
        Button {
            withAnimation(.snappy) { expanded = true }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                // A closed thread wears a check; one still in progress its state's dot.
                Image(systemName: closed ? "checkmark.circle.fill" : "circle.fill")
                    .font(closed ? .footnote : .caption2)
                    .foregroundStyle(closed ? Theme.doneText : stateColor)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(rowLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                // One rule with the section rows: ">" folded, "v" open (r9 review).
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows the whole thread")
        .accessibilityIdentifier("org.thread.row")
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if snoozed, let s = t.snoozed {
                Label("Snoozed until \(OrgThreadModel.backAt(s.until, now: now))", systemImage: "moon.zzz")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("org.thread.snoozedUntil")
            }
            if let follows = t.follows, let earlier = all.first(where: { $0.id == follows }) {
                Text("Asks again about \u{201C}\(earlier.title)\u{201D}")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let line = OrgThreadModel.ackCardLine(t) {
                // His Acknowledge: the AI is deciding, or where it went and why.
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("org.thread.ackLine")
            }
            if known && OrgThreadModel.placedSinceAck(t) == nil {
                // In Acknowledged: the line says it all until it is placed.
                EmptyView()
            } else if known {
                // Placed in Working or Waiting: what it waits on, in place of the summary.
                OrgThreadKnownBlock(thread: t, name: name)
            } else if let reply = t.reply?.trimmingCharacters(in: .whitespacesAndNewlines), !reply.isEmpty {
                OrgFoldedMarkdown(markdown: reply, budget: OrgThreadCardLayout.summaryBudget, id: "org.thread.summary", source: OrgThreadModel.summarySource(t))
            }
            chips
            if !conversation {
                let unread = OrgThreadModel.unread(t, shared: shared)
                ForEach(unread) { x in OrgThreadAnswer(exchange: x, name: name, now: now, quote: x.opener == nil) }
            }
            if let sent = followUpSentAt, now.timeIntervalSince(sent) < 600 {
                Label("Follow up sent \u{00B7} \(RelativeTime.short(date: sent, relativeTo: max(now, sent)))", systemImage: "checkmark.circle.fill")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.doneText)
                    .accessibilityIdentifier("org.thread.followUp.sent")
            }
            conversationToggle()
            if conversation {
                OrgThreadConversation(thread: t, shared: shared, name: name, now: now)
                // A conversation that runs screens long closes from its end too.
                if OrgThreadCardLayout.closesFromEnd(t) { conversationToggle(atEnd: true) }
            }
            // Its choices and keys first, the box under them (2026-11-20, the user: "butotn shoudl be
            // before inbox"), then Snooze and the watch eye at the right of the last line (2026-11-21, the
            // user's pick of ten whole-card designs: "2 is good"), all in the phone's one button family.
            optionButtons
            keys
            if canFollowUp, !closed { followUpBox }
            tools
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The reveal's tint sits behind the text and buttons, never over them: a tint on top
        // made the card read as disabled for its 2.5 s (2026-11-06 gate). Only the outline is
        // drawn over the card.
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(uiColor: .secondarySystemGroupedBackground))
                if highlighted {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.tintSoft.opacity(OrgThreadRevealModel.highlightTint))
                }
            }
        }
        .overlay {
            if highlighted {
                RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.tint, lineWidth: 2.5)
                    .allowsHitTesting(false)
            } else if t.state == "needs" && !closed {
                RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.danger.opacity(0.45), lineWidth: 1)
            }
        }
        #if DEBUG
        // The reveal mark, for the UI tests to read (draws nothing).
        .overlay(alignment: .topTrailing) { if testMarked { DebugRevealMarker(threadId: t.id) } }
        // The outline itself, while it is drawn (the tests check the eye's mark, not only theirs).
        .overlay(alignment: .topLeading) { if highlighted { DebugRevealMarker(threadId: t.id, visible: true, outlineOf: highlightFocus) } }
        #endif
        .opacity(closed ? 0.75 : 1)
        .onAppear { if startsOpen, OrgThreadModel.unread(t, shared: shared).isEmpty { conversation = true } }
        // Opened (its Conversation, or a folded row) with a cut answer in it: the whole thread.
        // Keyed by the cut too: a refresh that brings the cut copy back while it is open reads it whole again.
        .task(id: "\(conversation || expanded)-\(OrgThreadModel.hasCutAnswer(t))") {
            if conversation || expanded, OrgThreadModel.hasCutAnswer(t) { await onWhole() }
        }
        // Asked for while its card is already on the page (a push for the page that is up).
        .onChange(of: startsOpen) { _, open in
            if open, OrgThreadModel.unread(t, shared: shared).isEmpty { conversation = true }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("org.thread.\(t.id)")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            if OrgThreadCardLayout.headerStacks(typeSize) {
                stackedHeaderTop
            } else {
                // One row while it fits at its natural width, else the stacked form: a row
                // squeezed to fit broke the state inside its word and cut "Opened by" short.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) {
                        stateMark
                        stateText.lineLimit(1)
                        if !meta.isEmpty {
                            Text("\u{00B7}").foregroundStyle(.tertiary).font(.caption)
                            Text(meta)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        headerButtons
                    }
                    stackedHeaderTop
                }
            }
            Text(t.title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("org.thread.title")
        }
    }

    /// The state on its own line beside the buttons, and when and who under it, wrapping at words.
    private var stackedHeaderTop: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                stateMark
                stateText
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)
                Spacer(minLength: 0)
                headerButtons
            }
            if !meta.isEmpty {
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// When, and who opened it: "18m ago · Opened by Growth VP".
    private var meta: String {
        OrgThreadCardLayout.metaLine(timeAgo: timeAgo, openedBy: t.opener != nil ? name : nil)
    }

    /// The same mark folded or open: a check once closed, else its state's colour.
    private var stateMark: some View {
        Image(systemName: closed ? "checkmark.circle.fill" : "circle.fill")
            .font(closed ? .caption : .system(size: 8))
            .foregroundStyle(closed ? Theme.doneText : stateColor)
            .accessibilityHidden(true)
    }

    private var stateText: some View {
        // A watched thread wears the eye beside its state, in its own group and in Watching.
        (watched ? Text("\(Image(systemName: "eye.fill")) \(Text(verbatim: OrgThreadModel.stateLabel(t, inView: inView, now: now)))") : Text(OrgThreadModel.stateLabel(t, inView: inView, now: now)))
            .font(.caption.weight(.semibold))
            .foregroundStyle(t.state == "needs" && !closed ? Theme.needsText : .secondary)
    }

    @ViewBuilder
    private var headerButtons: some View {
        if compact && expanded {
            Button { withAnimation(.snappy) { expanded = false } } label: {
                Image(systemName: "chevron.down")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 36, height: 28)
                    .walnutTouchTarget()
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Fold this thread")
            .accessibilityIdentifier("org.thread.fold")
        }
    }

    /// The group's dot, as the web's GROUP_DOT (thread-badge.ts): only Needs you asks for him.
    private var stateColor: Color {
        if closed { return .secondary }
        switch OrgThreadModel.group(t, inView: inView, now: now) {
        case .needs: return Theme.danger
        case .working: return Theme.success
        default: return .secondary
        }
    }

    private var timeAgo: String {
        guard let d = WalnutTask.parseISO(OrgThreadModel.shownAt(t)) else { return "" }
        return RelativeTime.short(date: d, relativeTo: now)
    }

    static let chipGap: CGFloat = 6

    @ViewBuilder
    private var chips: some View {
        let named = OrgThreadModel.namedTasks(in: t.reply)
        let ids = (t.tasks ?? []).filter { !named.contains($0) }
        if !ids.isEmpty {
            let titles = ids.map { id in
                tasks.tasks.first { $0.id == id }.map {
                    AskProjectName.displayTitle($0.title, project: $0.project, orgRole: $0.orgRole)
                } ?? id
            }
            OrgChipFlow(spacing: Self.chipGap) {
                ForEach(ids, id: \.self) { id in
                    let task = tasks.tasks.first { $0.id == id }
                    let title = task.map { AskProjectName.displayTitle($0.title, project: $0.project, orgRole: $0.orgRole) } ?? id
                    // Two chips with one title say their state, so they can be told apart.
                    let twin = titles.filter { $0 == title }.count > 1
                    Button { onOpenTask(TaskOpenTarget(id: id, title: title)) } label: {
                        HStack(spacing: 5) {
                            if let task { Circle().fill(UserStatePill.color(TeamStatusModel.state(of: task))).frame(width: 7, height: 7) }
                            Text(title).lineLimit(1)
                            if twin, let task {
                                Text("· \(TeamStatusModel.state(of: task).label)").foregroundStyle(.secondary).fixedSize()
                            }
                        }
                        .font(.footnote)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
                        .walnutTouchTarget()
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("org.thread.task")
                }
            }
            // The chips wrap 6 pt apart: each touch reaches half the gap toward its neighbour.
            .walnutTouchRoom(.gaps(horizontal: Self.chipGap, vertical: Self.chipGap))
        }
    }

    /// `atEnd`: the second toggle under a long open conversation (its own id, so the two are told apart).
    @ViewBuilder
    private func conversationToggle(atEnd: Bool = false) -> some View {
        let count = t.messages.count + (t.opener == nil ? 0 : 1)
        if count > 0 {
            Button {
                withAnimation(.snappy) { conversation.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: conversation ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                    Text(conversation ? "Hide the conversation" : "Conversation · \(count) \(count == 1 ? "message" : "messages")")
                }
                .font(.footnote)
                .foregroundStyle(Theme.tint)
                .frame(minHeight: 32)
                // 10 pt from the card's other lines, which keep to their frames (the chips reach 3).
                .walnutTouchTarget()
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(atEnd ? "org.thread.conversation.end" : "org.thread.conversation")
        }
    }

    /// It waits on him: its choices, the recommended one first, and no Acknowledge, which is for a
    /// card that asks no choice (2026-11-20, the user: "Acknowledge is for when I do not need to
    /// make any choice").
    private var waitsOnHim: Bool { t.one_card == true && t.state == "needs" && !closed }
    private var choices: [OrgThread.Option] {
        let all = t.options ?? []
        return all.filter { $0.recommended == true } + all.filter { $0.recommended != true }
    }
    /// The choices one tap answered: off until they change, so a second tap never answers twice.
    private var choicesKey: String { t.id + "|" + (t.options ?? []).map { "\($0.id)=\($0.label)" }.joined(separator: "|") }

    @ViewBuilder
    private var optionButtons: some View {
        if waitsOnHim, canFollowUp, !choices.isEmpty {
            // Each a row of its own, full width; the recommended one filled in the accent (the family's option).
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                ForEach(choices) { o in
                    Button { pickedKey = choicesKey; onPick(o.label) } label: {
                        WalnutOptionLabel(label: o.label, detail: o.detail, recommended: o.recommended == true)
                    }
                    .buttonStyle(.walnut(.option(recommended: o.recommended == true)))
                    .disabled(busy || pickedKey == choicesKey)
                    .accessibilityIdentifier("org.thread.option.\(o.id)")
                }
            }
        }
    }

    /// Its keys: Reopen on a closed card (grey), else Acknowledge, the card's one accent key, on a
    /// card that asks no choice. From XXXL up a key takes the whole line, so no label is squeezed
    /// into its letters.
    @ViewBuilder
    private var keys: some View {
        let wide = OrgThreadCardLayout.actionsStack(typeSize)
        if let c = t.closed {
            HStack {
                Text("\(c.how == "acked" ? OrgThreadModel.Group.done.label : "Dropped")\(c.by == "human" ? "" : " by \(name)") \(WalnutTask.parseISO(c.at).map { RelativeTime.short(date: $0, relativeTo: now) } ?? "")")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
                Button { onEdit(.reopen) } label: { actionLabel("Reopen", fullWidth: false) }
                    .buttonStyle(.walnut(.secondary, size: .small))
                    .disabled(busy)
                    .accessibilityIdentifier("org.thread.reopen")
            }
        } else if !known && !waitsOnHim {
            // Acknowledged already: the AI places it (server thread-known.ts), no second button.
            Button { onEdit(.acknowledge) } label: { actionLabel("Acknowledge", fullWidth: wide) }
                .buttonStyle(.walnut(.primary, size: .small, fullWidth: wide))
                .disabled(busy)
                .accessibilityIdentifier("org.thread.ack")
        }
    }

    /// The last line of an open card: Snooze and the watch eye, quiet, at the right (under the box).
    @ViewBuilder
    private var tools: some View {
        if !closed {
            HStack(spacing: 4) {
                if busy { ProgressView().controlSize(.small) }
                Spacer(minLength: 0)
                snoozeMenu
                watchButton
            }
            .disabled(busy)
        }
    }

    private var watchButton: some View {
        Button { onEdit(.watch(!watched)) } label: {
            // Blue while it watches: the accent of a selected thing, on the family's quiet tool.
            Image(systemName: watched ? "eye.fill" : "eye")
                .foregroundStyle(watched ? Theme.tint : Theme.secondaryOnCard)
        }
        .buttonStyle(.walnut(.tool, size: .small))
        // 4 pt right of Snooze, which is wide and keeps to its frame: the rest of 44 pt on the right.
        .walnutTouchRoom(WalnutTouchRoom(leading: 4))
        .accessibilityLabel(watched ? "Stop watching" : "Watch")
        .accessibilityIdentifier("org.thread.watch")
    }

    /// An action's label: on one line, its word whole (`OrgThreadCardLayout.actionLabel`).
    private func actionLabel(_ text: String, fullWidth: Bool) -> some View {
        Text(text)
            .lineLimit(OrgThreadCardLayout.actionLabelLines)
            .minimumScaleFactor(OrgThreadCardLayout.actionLabelMinScale)
            .fixedSize(horizontal: !fullWidth, vertical: false)
            .frame(maxWidth: fullWidth ? .infinity : nil)
    }

    /// His Follow up, always on an open card (2026-11-20, the user: "why thead nede to click
    /// follow up, just have. ainbox bar there"): the shared reply box with `@`, `/`, pictures and
    /// the mic, its own draft per thread, never focused by itself (a page shows many). One send
    /// per thread at a time, across the boxes that show it (`OrgThreadFollowUpSends`).
    private var followUpScope: ComposerSuggestController.Scope {
        let session = nodeSessionId.flatMap { id in tasks.sessions.first { $0.id == id } }
        return .init(selfTaskId: nodeTaskId, commands: nodeSessionId != nil,
                     commandsCwd: session?.cwd, commandsHost: session?.host)
    }

    /// The Follow up box's placeholder: whole on an iPhone at the default text size.
    static let followUpPlaceholder = "Follow up\u{2026}"

    private var followUpBox: some View {
        let key = followUpKey
        // The web's words ("Follow up on this request") were cut on a 402 pt phone beside the
        // box's keys ("Follow up on this requ…", 2026-11-26): the short words fit whole.
        return ReplyBox(
            placeholder: Self.followUpPlaceholder, draftKey: key, idPrefix: OrgThreadFollowUpDraft.idPrefix(threadId: t.id),
            scope: followUpScope,
            fieldLabel: "Follow up on \u{201C}\(t.title)\u{201D}",
            voiceBox: "thread-follow-up",
            draftFamily: (OrgThreadFollowUpDraft.prefix, OrgThreadFollowUpDraft.kept),
            busy: OrgThreadFollowUpSends.shared.inFlight.contains(key),
            failureNote: "Not sent. Your words and pictures are still here.",
            // A picture alone is a Follow up too.
            requiresWords: false
        ) { text, images in
            guard OrgThreadFollowUpSends.shared.begin(key) else { return false }
            defer { OrgThreadFollowUpSends.shared.end(key) }
            return await onFollowUp(text, images)
        }
    }

    /// "Snooze ▾" (or "Snoozed ▾"), the family's quiet tool as on the ask card.
    private var snoozeMenu: some View {
        Menu {
            snoozeChoices
            if snoozed {
                Divider()
                Button("Unsnooze") { onEdit(.snooze("")) }
            }
        } label: {
            WalnutMenuLabel(title: snoozed ? "Snoozed" : "Snooze")
        }
        .buttonStyle(.walnut(.tool, size: .small))
        .accessibilityIdentifier("org.thread.snooze")
    }

    private var snoozeChoices: some View {
        ForEach(OrgThreadModel.snoozeChoices(now: now), id: \.label) { choice in
            Button(choice.label) { onEdit(.snooze(ISO8601DateFormatter().string(from: choice.until))) }
        }
    }
}

/// One answer of the node's on a card or in the conversation: who and when, his words it answers
/// (on a card), and the answer folded to a few lines with Expand.
struct OrgThreadAnswer: View {
    let exchange: OrgThreadModel.Exchange
    let name: String
    let now: Date
    var quote: Bool
    /// Folded to its opening on a card; whole inside the open conversation, which he opened to read.
    var folded = true

    var body: some View {
        let text: String
        let at: String
        let by: String
        if let o = exchange.opener {
            text = o.text; at = o.at; by = "\(name) opened this · \(OrgThreadModel.fromLabel(o))"
        } else {
            text = exchange.answer.map(OrgThreadModel.answerText) ?? ""; at = exchange.answer?.at ?? ""; by = name
        }
        let shown = TimelineTurnMarker.strip(MessageAboutTag.strip(text))
        let source = OrgThreadModel.source(of: exchange)
        return VStack(alignment: .leading, spacing: 4) {
            Text("\(by) · \(clock(at))")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if quote, !exchange.messages.isEmpty {
                Text(OrgThreadModel.quote(exchange))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if folded {
                OrgFoldedMarkdown(markdown: shown, budget: 80, id: "org.thread.answer.body", source: source)
            } else {
                LetterMarkdownBody(markdown: shown)
                    .linked(from: source)
                    .markdownBodyFont(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("org.thread.answer.body")
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.tintSoft.opacity(exchange.known ? 0.4 : 1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("org.thread.answer")
    }

    private func clock(_ at: String) -> String {
        guard let d = WalnutTask.parseISO(at) else { return "" }
        let time = d.formatted(date: .omitted, time: .shortened)
        return Calendar.current.isDate(d, inSameDayAs: now) ? time : "\(d.formatted(.dateTime.month(.abbreviated).day())), \(time)"
    }
}

/// The whole conversation of a thread, numbered: each of his messages and the answer under it.
struct OrgThreadConversation: View {
    let thread: OrgThread
    let shared: Set<String>
    let name: String
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(OrgThreadModel.exchanges(thread)) { x in
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(x.messages.enumerated()), id: \.element.id) { i, m in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("\(x.n + i)")
                                .font(.caption.monospacedDigit().weight(.semibold))
                                .foregroundStyle(.secondary)
                                .frame(minWidth: 16, alignment: .trailing)
                            VStack(alignment: .leading, spacing: 2) {
                                if m.via == "follow-up" {
                                    Text("Follow up").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                                } else if m.via == "letter" {
                                    Text("Answering \u{201C}\(m.about ?? "a letter")\u{201D}").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                                }
                                if !m.text.isEmpty {
                                    Text(m.text)
                                        .font(.subheadline)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                // Pictures render as the chat renders them (the web card does the same).
                                ForEach(Array((m.images ?? []).enumerated()), id: \.offset) { _, path in
                                    AttachmentImageView(raw: path, alt: "")
                                        .frame(maxWidth: 220, alignment: .leading)
                                        .accessibilityIdentifier("org.thread.message.image")
                                }
                            }
                        }
                    }
                    if x.answer != nil || x.opener != nil {
                        OrgThreadAnswer(exchange: x, name: x.messages.contains { shared.contains($0.id) } ? "\(name) · one reply to this and another thread" : name, now: now, quote: false, folded: false)
                    } else {
                        Text(thread.closed == nil ? "\(name) has not answered yet" : "No answer")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .accessibilityIdentifier("org.thread.messages")
    }
}

/// Where an unsent Follow up is kept: the app's composer draft store, one draft per thread, so the
/// box on a card that scrolled away, a push that opened another thread or a page left and opened
/// again gives his words and pictures back (2026-11-08 review: a push dropped a half-written
/// Follow up). Gone once the server took it.
enum OrgThreadFollowUpDraft {
    nonisolated static let prefix = "thread-follow-up:"
    /// Drafts kept for threads he left unsent, besides the one in hand.
    nonisolated static let kept = 10

    nonisolated static func key(nodeId: String, threadId: String) -> String { "\(prefix)\(nodeId)/\(threadId)" }

    /// The box's identifiers on a thread's card (`<this>.input`, `<this>.send`, ...): one per
    /// thread, so each card's field and Send are told apart.
    nonisolated static func idPrefix(threadId: String) -> String { "org.thread.followUp.\(threadId)" }
}

/// The Follow ups on their way, by draft key: one at a time per thread, across boxes (a card
/// that left the screen while its send was on its way, then came back, offered Send for the same
/// words a second time).
@Observable
@MainActor
final class OrgThreadFollowUpSends {
    static let shared = OrgThreadFollowUpSends()
    private(set) var inFlight: Set<String> = []
    private init() {}

    /// False when one is already on its way for `key`.
    func begin(_ key: String) -> Bool { inFlight.insert(key).inserted }
    func end(_ key: String) { inFlight.remove(key) }
}

/// Chips that wrap onto the next line instead of running off the screen.
/// Measuring and placing break lines with ONE rule (`lines`) at the width the measure was
/// given: placing at a bounds width a fraction of a point narrower once broke a third line the
/// measure never counted, and that line sat on the team rows below it (2026-11-06, r9).
struct OrgChipFlow: Layout {
    var spacing: CGFloat = 6

    /// The chips' indices per line at `width`, a line taking a chip while it fits within half a point.
    static func lines(_ sizes: [CGSize], width: CGFloat, spacing: CGFloat) -> [[Int]] {
        var out: [[Int]] = []
        var x: CGFloat = 0
        for (i, size) in sizes.enumerated() {
            if !out.isEmpty, x > 0, x + size.width > width + 0.5 {
                out.append([i]); x = size.width + spacing
            } else {
                if out.isEmpty { out.append([]) }
                out[out.count - 1].append(i); x += size.width + spacing
            }
        }
        return out
    }

    /// The block's height: every line's tallest chip, with `spacing` between lines.
    static func height(_ sizes: [CGSize], lines: [[Int]], spacing: CGFloat) -> CGFloat {
        let rows = lines.map { $0.map { sizes[$0].height }.max() ?? 0 }
        return rows.reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
    }

    struct Cache { var width: CGFloat? = nil }

    func makeCache(subviews: Subviews) -> Cache { Cache() }

    private func sizes(_ subviews: Subviews, width: CGFloat) -> [CGSize] {
        subviews.map { $0.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let width = proposal.width ?? .infinity
        let sizes = sizes(subviews, width: width)
        let lines = Self.lines(sizes, width: width, spacing: spacing)
        // Typed in steps: as one expression it took the compiler past its time limit on CI.
        let lineWidths: [CGFloat] = lines.map { (line: [Int]) -> CGFloat in
            let chips: CGFloat = line.map { sizes[$0].width }.reduce(0, +)
            let gaps: CGFloat = spacing * CGFloat(max(0, line.count - 1))
            return chips + gaps
        }
        let widest: CGFloat = lineWidths.max() ?? 0
        if width.isFinite { cache.width = width }
        return CGSize(width: width.isFinite ? width : widest, height: Self.height(sizes, lines: lines, spacing: spacing))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        // The width the block was measured at, so its lines are the ones its height counted.
        let width = max(bounds.width, proposal.width ?? cache.width ?? bounds.width)
        let sizes = sizes(subviews, width: width)
        var y = bounds.minY
        for line in Self.lines(sizes, width: width, spacing: spacing) {
            var x = bounds.minX
            let rowHeight = line.map { sizes[$0].height }.max() ?? 0
            for i in line {
                subviews[i].place(at: CGPoint(x: x, y: y),
                                  proposal: ProposedViewSize(width: min(sizes[i].width, width), height: sizes[i].height))
                x += sizes[i].width + spacing
            }
            y += rowHeight + spacing
        }
    }
}

/// Markdown folded to its opening paragraphs, with Expand / Collapse under it when there is
/// more (`OrgThreadModel.preview`). Folded by its text, never by a measured height: a table
/// inside a height-measured fold re-laid itself out forever (2026-11-04, a VP's 46 answers
/// with tables froze the page). A link or a task pill inside keeps its own tap.
struct OrgFoldedMarkdown: View {
    let markdown: String
    let budget: Int
    let id: String
    /// Who wrote this text: a path in it opens on that machine, never by guess.
    var source: LinkSource = .unknown
    @State private var whole = false

    var body: some View {
        let preview = OrgThreadModel.preview(markdown, budget: budget)
        VStack(alignment: .leading, spacing: 4) {
            LetterMarkdownBody(markdown: whole || preview == nil ? markdown : preview!)
                .linked(from: source)
                .markdownBodyFont(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier(id)
            if preview != nil { FoldToggle(whole: $whole, id: id) }
        }
    }
}

/// Expand / Collapse under text folded by its length (`OrgThreadModel.preview`): a thread's
/// answer, an ask's why on a task row.
struct FoldToggle: View {
    @Binding var whole: Bool
    let id: String

    var body: some View {
        Button {
            withAnimation(.snappy) { whole.toggle() }
        } label: {
            HStack(spacing: 3) {
                Image(systemName: whole ? "chevron.up" : "chevron.down").font(.caption2.weight(.bold))
                Text(whole ? "Collapse" : "Expand")
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.tint)
            .frame(minHeight: 32)
            // 4 pt under the text it folds, whose links keep to their frames.
            .walnutTouchTarget(WalnutTouchRoom(top: 4))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("\(id).expand")
    }
}
