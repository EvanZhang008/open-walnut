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
    /// What the node's page shows over itself. A card asks for a task's session or its Follow up
    /// here and the page presents it, so a request the page takes can take it down.
    let cover: Binding<OrgNodePageCover?>

    /// How many threads the node's own status counts for him (`user_status.threads.shown`).
    var nodeShown: Int? = nil

    private var focusThreadId: String? { focus?.threadId }

    // Snoozed and In progress stay as he left them, per node (the web keeps a view per node);
    // Closed is history, so every visit starts with it folded.
    @AppStorage("org.threads.openFolds", store: AppPrefs.defaults) private var openFolds = ""
    @State private var showClosed = false
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

    private func isOpen(_ fold: String) -> Bool {
        openFolds.split(separator: " ").contains(Substring("\(store.taskId)/\(fold)"))
    }

    private func foldBinding(_ fold: String) -> Binding<Bool> {
        if fold == "closed" { return $showClosed }
        let key = "\(store.taskId)/\(fold)"
        return Binding(
            get: { isOpen(fold) },
            set: { on in
                var keys = openFolds.split(separator: " ").map(String.init).filter { $0 != key }
                if on { keys.append(key) }
                openFolds = keys.suffix(40).joined(separator: " ")
            }
        )
    }

    private var showSnoozed: Bool { isOpen("snoozed") }
    private var showInProgress: Bool { isOpen("inProgress") }

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
                    ForEach(sections.open) { t in
                        card(t, shared: shared, now: now, snoozed: false).id(t.id)
                    }
                    fold("\(sections.snoozed.count) snoozed", count: sections.snoozed.count, open: foldBinding("snoozed"), id: "snoozed")
                    if showSnoozed {
                        ForEach(sections.snoozed) { t in card(t, shared: shared, now: now, snoozed: true, compact: true).id(t.id) }
                    }
                    fold("\(sections.inProgress.count) in progress, nothing for you", count: sections.inProgress.count, open: foldBinding("inProgress"), id: "inProgress")
                    if showInProgress {
                        ForEach(sections.inProgress) { t in card(t, shared: shared, now: now, snoozed: false, compact: true).id(t.id) }
                    }
                    // The count of them all; the fold lists the newest the read brought.
                    let closedCount = max(store.closedCount ?? 0, sections.closed.count)
                    fold(OrgThreadModel.closedFoldLabel(count: closedCount, closed: sections.closed, now: now),
                         count: sections.closed.count, open: foldBinding("closed"), id: "closed")
                    if showClosed {
                        ForEach(sections.closed) { t in card(t, shared: shared, now: now, snoozed: false, compact: true).id(t.id) }
                        if closedCount > sections.closed.count {
                            Text("The newest \(sections.closed.count) are here; all \(closedCount) are on the web.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .accessibilityIdentifier("org.threads.closed.more")
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                // Room under the last section, so a jump can bring even the last fold to the top
                // and nothing ends under the floating tab bar.
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
            // Pinned under the page's switch while it lists threads, so a jump is one tap from
            // anywhere in the list (r10 review: it scrolled away with the cards), and the page keeps
            // one header as a snooze or an acknowledge takes a card away (r8 review).
            .safeAreaInset(edge: .top, spacing: 0) {
                let bar = OrgThreadRevealModel.jumpBar(
                    threadsRead: store.threads != nil, sections: sections, broughtNone: broughtNone, hides: hides)
                if bar != .none {
                    // Out of sight with the cards while a reveal holds them, but in its place, so
                    // the page does not move under the thread it just jumped to.
                    jumps(sections, proxy: proxy)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 4)
                        .background(.bar)
                        .overlay(alignment: .bottom) { Divider() }
                        // The bar's whole band, for the UI tests to measure what it covers.
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("org.threads.jumps")
                        .opacity(bar == .held ? 0 : 1)
                        .allowsHitTesting(bar == .shown)
                }
            }
            // At the bottom, above the tab bar: where the eye is after the card's buttons, and off the cards' text.
            .overlay(alignment: .bottom) { noticeView }
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
        // A container, so the list's identifier does not replace those inside it (the jump bar's).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("org.threads")
    }

    /// Where the last action moved its thread, for a moment at the top of the page.
    @ViewBuilder
    private var noticeView: some View {
        if let notice = store.notice {
            Label(notice.text, systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: Capsule())
                .overlay(Capsule().stroke(Color(uiColor: .separator), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
                .padding(.bottom, 12)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityIdentifier("org.threads.notice")
                .task(id: notice.id) {
                    try? await Task.sleep(for: .seconds(3))
                    if store.notice?.id == notice.id { withAnimation(.snappy) { store.notice = nil } }
                }
        }
    }

    private func card(_ t: OrgThread, shared: Set<String>, now: Date, snoozed: Bool, compact: Bool = false) -> some View {
        let focused = t.id == focusThreadId
        return OrgThreadCard(
            thread: t, all: store.threads ?? [], shared: shared, name: name, now: now, snoozed: snoozed,
            busy: store.busyThreadId == t.id, canFollowUp: sessionId != nil,
            startsOpen: t.id == focusThreadId, compact: compact, followUpSentAt: store.followUpSentAt[t.id],
            followUpKept: OrgThreadFollowUpDraft.exists(OrgThreadFollowUpDraft.key(nodeId: store.taskId, threadId: t.id)),
            highlighted: highlight?.threadId == t.id,
            highlightFocus: highlight?.threadId == t.id ? highlight : nil,
            testMarked: testMark?.threadId == t.id,
            onEdit: { edit in Task { await store.edit(t.id, edit) } },
            onOpenTask: { cover.wrappedValue = .task($0) },
            onFollowUpOpen: { cover.wrappedValue = .followUp(threadId: t.id, title: t.title) },
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
            switch fold {
            case .snoozed: foldBinding("snoozed").wrappedValue = true
            case .inProgress: foldBinding("inProgress").wrappedValue = true
            case .closed: showClosed = true
            case nil: break
            }
            // Cards not in sight yet: the jump is instant and they show once it has landed.
            let instant = !cardsShown
            if instant { scrolling = true }
            DispatchQueue.main.async {
                withAnimation(reduceMotion || instant ? nil : .default) { proxy.scrollTo(focus.threadId, anchor: .top) }
                land(focus, instant: instant, proxy: proxy)
            }
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

    /// The count of cards for him, and one tap to each fold below them (2026-11-04 review: a
    /// dozen screens of cards before them).
    private func jumps(_ s: OrgThreadModel.Sections, proxy: ScrollViewProxy) -> some View {
        let items: [(id: String, label: String, count: Int, open: Binding<Bool>)] = [
            ("snoozed", "Snoozed", s.snoozed.count, foldBinding("snoozed")),
            ("inProgress", "In progress", s.inProgress.count, foldBinding("inProgress")),
            ("closed", "Closed", max(store.closedCount ?? 0, s.closed.count), foldBinding("closed")),
        ].filter { $0.count > 0 }
        return HStack(spacing: 8) {
            Text("\(s.open.count) for you")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            ForEach(items, id: \.id) { item in
                Button {
                    endLanding()
                    item.open.wrappedValue = true
                    // After the section has laid out its rows: scrolled at once, a short section
                    // (one snoozed thread) stayed where it was, under the tab bar (r9 review).
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(150))
                        withAnimation { proxy.scrollTo("fold.\(item.id)", anchor: .top) }
                    }
                } label: {
                    Text("\(item.label) \(item.count)")
                        .font(.footnote)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
                        .frame(minHeight: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("org.threads.jump.\(item.id)")
            }
        }
    }

    @ViewBuilder
    private func fold(_ label: String, count: Int, open: Binding<Bool>, id: String) -> some View {
        if count > 0 {
            Button {
                withAnimation(.snappy) { open.wrappedValue.toggle() }
            } label: {
                // A row he taps, not a caption (2026-11-04 review).
                HStack(spacing: 6) {
                    Text(label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Spacer(minLength: 0)
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
            .accessibilityIdentifier("org.threads.fold.\(id)")
            .id("fold.\(id)")
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
                .buttonStyle(.bordered)
                .accessibilityIdentifier("org.threads.retry")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 24)
        .accessibilityIdentifier("org.threads.unreadable")
    }

    private func emptyText(_ s: OrgThreadModel.Sections) -> some View {
        let quiet = !s.inProgress.isEmpty || !s.snoozed.isEmpty
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
    /// A Follow up he started here and did not send is kept (`OrgThreadFollowUpDraft`).
    var followUpKept = false
    /// Just revealed for a push or a link: marked for a moment so the eye finds it.
    var highlighted = false
    /// The reveal `highlighted` is for (DEBUG: noted once its outline is drawn).
    var highlightFocus: OrgThreadFocus? = nil
    /// DEBUG: wears the UI tests' reveal mark.
    var testMarked = false
    let onEdit: (OrgThreadEdit) -> Void
    /// A task chip was tapped: the node's page opens its session over itself.
    let onOpenTask: (TaskOpenTarget) -> Void
    /// Follow up was tapped: the node's page opens the composer over itself.
    let onFollowUpOpen: () -> Void
    /// Read this thread whole: its list read cut answers he already reacted to (`clipped`).
    var onWhole: () async -> Void = {}

    @Environment(TasksStore.self) private var tasks
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var conversation = false
    @State private var expanded = false

    private var t: OrgThread { thread }
    private var closed: Bool { t.closed != nil }
    private var pinned: Bool { OrgThreadModel.pinnedNow(t) }

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
        return "\(OrgThreadModel.stateLabel(t)) · \(timeAgo)"
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
            if let reply = t.reply?.trimmingCharacters(in: .whitespacesAndNewlines), !reply.isEmpty {
                OrgFoldedMarkdown(markdown: reply, budget: 110, id: "org.thread.summary")
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
            if followUpKept, canFollowUp, !closed {
                // A composer closed before Send (Cancel, a swipe, a push that opened another
                // thread) left his words here: Follow up brings them back.
                Label("Your unsent follow up is kept. Tap Follow up to finish it.", systemImage: "square.and.pencil")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("org.thread.followUp.kept")
            }
            conversationToggle()
            if conversation {
                OrgThreadConversation(thread: t, shared: shared, name: name, now: now)
                // A conversation that runs screens long closes from its end too.
                if OrgThreadCardLayout.closesFromEnd(t) { conversationToggle(atEnd: true) }
            }
            actions
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
        Text(OrgThreadModel.stateLabel(t))
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
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Fold this thread")
            .accessibilityIdentifier("org.thread.fold")
        }
        if !closed {
            Button { onEdit(.pin(!pinned)) } label: {
                Image(systemName: pinned ? "pin.fill" : "pin")
                    .font(.footnote)
                    .foregroundStyle(pinned ? Theme.tint : .secondary)
                    .frame(width: 36, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(busy)
            .accessibilityLabel(pinned ? "Unpin" : "Pin to the top")
            .accessibilityIdentifier("org.thread.pin")
        }
    }

    private var stateColor: Color {
        if closed { return .secondary }
        switch t.state {
        case "needs": return Theme.danger
        case "working": return Theme.success
        case "new": return Theme.workingText
        // An answer for him to read: the web's "take a look" blue.
        case "answered": return Theme.workingText
        default: return .secondary
        }
    }

    private var timeAgo: String {
        guard let d = WalnutTask.parseISO(OrgThreadModel.shownAt(t)) else { return "" }
        return RelativeTime.short(date: d, relativeTo: now)
    }

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
            OrgChipFlow(spacing: 6) {
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
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("org.thread.task")
                }
            }
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
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(atEnd ? "org.thread.conversation.end" : "org.thread.conversation")
        }
    }

    @ViewBuilder
    private var actions: some View {
        if let c = t.closed {
            HStack {
                Text("\(c.how == "acked" ? "Acknowledged" : "Dropped")\(c.by == "human" ? "" : " by \(name)") \(WalnutTask.parseISO(c.at).map { RelativeTime.short(date: $0, relativeTo: now) } ?? "")")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Reopen") { onEdit(.reopen) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(busy)
                    .accessibilityIdentifier("org.thread.reopen")
            }
        } else if OrgThreadCardLayout.actionsStack(typeSize) {
            // Large text: one full-width button a row, so no label is squeezed into its letters.
            VStack(alignment: .leading, spacing: 8) {
                actionButtons(fullWidth: true)
                if busy { ProgressView().controlSize(.small) }
            }
            .controlSize(.small)
            .disabled(busy)
        } else {
            // In a row while the labels fit whole, else the stacked form (a long name in another
            // language, a narrow screen), never a label broken inside its word.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    actionButtons(fullWidth: false)
                    Spacer(minLength: 0)
                    if busy { ProgressView().controlSize(.small) }
                }
                VStack(alignment: .leading, spacing: 8) {
                    actionButtons(fullWidth: true)
                    if busy { ProgressView().controlSize(.small) }
                }
            }
            .controlSize(.small)
            .disabled(busy)
        }
    }

    /// An action's label: on one line, its word whole (`OrgThreadCardLayout.actionLabel`).
    private func actionLabel(_ text: String, fullWidth: Bool) -> some View {
        Text(text)
            .lineLimit(OrgThreadCardLayout.actionLabelLines)
            .minimumScaleFactor(OrgThreadCardLayout.actionLabelMinScale)
            .fixedSize(horizontal: !fullWidth, vertical: false)
            .frame(maxWidth: fullWidth ? .infinity : nil)
    }

    @ViewBuilder
    private func actionButtons(fullWidth: Bool) -> some View {
        Button { onEdit(.acknowledge) } label: { actionLabel("Acknowledge", fullWidth: fullWidth) }
            .buttonStyle(.borderedProminent)
            .tint(Theme.tint)
            .accessibilityIdentifier("org.thread.ack")
        if canFollowUp {
            Button { onFollowUpOpen() } label: { actionLabel("Follow up", fullWidth: fullWidth) }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("org.thread.followUp")
        }
        snoozeMenu(fullWidth: fullWidth)
    }

    private func snoozeMenu(fullWidth: Bool) -> some View {
        Menu {
            // The server takes the pin off a thread it snoozes, so a pinned card says so first.
            if pinned {
                Section("Snoozing unpins this thread") { snoozeChoices }
            } else {
                snoozeChoices
            }
            if snoozed {
                Divider()
                Button("Unsnooze") { onEdit(.snooze("")) }
            }
        } label: {
            actionLabel(snoozed ? "Snoozed" : "Snooze", fullWidth: fullWidth)
        }
        .buttonStyle(.bordered)
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
                OrgFoldedMarkdown(markdown: shown, budget: 80, id: "org.thread.answer.body")
            } else {
                LetterMarkdownBody(markdown: shown)
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

/// Where an unsent Follow up is kept: the app's composer draft store, one draft per thread, so a
/// sheet closed by Cancel, a swipe or a push navigation (`PresentationLowering`) gives his words
/// and pictures back when he opens Follow up on that thread again (2026-11-08 review: a push
/// dropped a half-written Follow up). Gone once the server took it.
enum OrgThreadFollowUpDraft {
    nonisolated static let prefix = "thread-follow-up:"
    /// Drafts kept for threads he left unsent, besides the one in hand.
    nonisolated static let kept = 10

    nonisolated static func key(nodeId: String, threadId: String) -> String { "\(prefix)\(nodeId)/\(threadId)" }

    /// Something unsent is kept for this thread (words that are not blank, or a picture).
    @MainActor static func exists(_ key: String, in drafts: ComposerDrafts = .shared) -> Bool {
        !drafts.draft(key).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !drafts.images(key).isEmpty
    }

    /// A send's receipt clears the draft only while the draft is still what was sent: a receipt
    /// that arrives after he wrote more keeps the newer words (2026-11-08 review, round 2).
    nonisolated static func sentIsStillTheDraft(sent: String, sentPictures: [UUID], draft: String, draftPictures: [UUID]) -> Bool {
        draft == sent && draftPictures == sentPictures
    }

    /// What the draft keeps once the server took `sent`: what he wrote after it, never the part
    /// that went out (2026-11-08 review, round 3: "Approve" sent, " and ship it" added on the way,
    /// and the next Send sent "Approve" a second time). Words that do not start with the sent
    /// ones are newer words of his and stay whole; the pictures that went out leave the draft.
    /// `remainder`: the draft kept only what came after the sent words.
    nonisolated static func afterReceipt(sent: String, sentPictures: [UUID], draft: String, draftPictures: [UUID])
        -> (words: String, pictures: [UUID], remainder: Bool) {
        let pictures = draftPictures.filter { !sentPictures.contains($0) }
        guard !sent.isEmpty, draft.hasPrefix(sent) else { return (draft, pictures, false) }
        let rest = String(draft.dropFirst(sent.count))
        let trimmed = String(rest.drop { $0 == " " || $0 == "\n" || $0 == "\t" })
        return (trimmed, pictures, !trimmed.isEmpty)
    }
}

/// The Follow ups on their way, by draft key: one at a time per thread, across composers (a
/// composer closed while its send was on its way, then opened again, offered Send for the same
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

/// Follow up on a thread: his words (and pictures, as the chat takes) go into the node's
/// chat, filed under this thread. Kept in the draft store until sent (`OrgThreadFollowUpDraft`).
struct OrgThreadFollowUpSheet: View {
    let title: String
    /// `OrgThreadFollowUpDraft.key` for this thread.
    let draftKey: String
    let send: (String, [SelectedImage]) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var drafts = ComposerDrafts.shared
    @State private var pictureNotice: String?
    @State private var sends = OrgThreadFollowUpSends.shared
    @State private var failed = false
    /// The words that went out while he kept writing: the draft kept only what came after them.
    @State private var sentNote: String?
    @FocusState private var focused: Bool

    /// A Follow up of this thread is on its way, from this composer or one closed meanwhile.
    private var sending: Bool { sends.inFlight.contains(draftKey) }

    private var text: Binding<String> {
        Binding(get: { drafts.draft(draftKey) }, set: {
            drafts.setDraft($0, key: draftKey)
            drafts.trimDrafts(prefix: OrgThreadFollowUpDraft.prefix, keeping: draftKey, max: OrgThreadFollowUpDraft.kept)
        })
    }

    private var images: Binding<[SelectedImage]> {
        Binding(get: { drafts.images(draftKey) }, set: {
            drafts.setImages($0, key: draftKey)
            drafts.trimDrafts(prefix: OrgThreadFollowUpDraft.prefix, keeping: draftKey, max: OrgThreadFollowUpDraft.kept)
        })
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                TextEditor(text: text)
                    .focused($focused)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 80, maxHeight: .infinity)
                    .padding(8)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(alignment: .topLeading) {
                        if text.wrappedValue.isEmpty {
                            Text("Write your follow up")
                                .font(.body)
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 13)
                                .padding(.vertical, 16)
                                .allowsHitTesting(false)
                        }
                    }
                    .accessibilityIdentifier("org.thread.followUp.input")
                ReplyPictureStrip(images: images, notice: $pictureNotice, idPrefix: "org.thread.followUp")
                ReplyPictureButton(
                    images: images, notice: $pictureNotice, idPrefix: "org.thread.followUp",
                    disabled: sending, onWillPresent: { focused = false }
                )
                if failed {
                    Text("Not sent. Your words are still here.")
                        .font(.footnote)
                        .foregroundStyle(Theme.needsText)
                } else if sending {
                    Text("Your follow up is on its way.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("org.thread.followUp.onItsWay")
                } else if let sentNote {
                    Text(sentNote)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("org.thread.followUp.sentPart")
                }
            }
            // Top-aligned and shrinking with the keyboard: never pushed up under the bar.
            .frame(maxHeight: .infinity, alignment: .top)
            .padding(16)
            .navigationTitle("Follow up")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "Sending…" : "Send") {
                        let key = draftKey
                        guard sends.begin(key) else { return }
                        failed = false
                        sentNote = nil
                        let words = text.wrappedValue, pictures = images.wrappedValue
                        Task {
                            let ok = await send(words, pictures)
                            sends.end(key)
                            guard ok else {
                                failed = true
                                return
                            }
                            // A receipt that comes late (he closed the composer while it was on its
                            // way, came back and wrote more) never takes the newer words with it,
                            // and never leaves the words that went out to be sent again.
                            let after = OrgThreadFollowUpDraft.afterReceipt(
                                sent: words, sentPictures: pictures.map(\.id),
                                draft: drafts.draft(key), draftPictures: drafts.images(key).map(\.id))
                            if after.words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, after.pictures.isEmpty {
                                drafts.clear(key)
                                dismiss()
                                return
                            }
                            drafts.setDraft(after.words, key: key)
                            drafts.setImages(drafts.images(key).filter { after.pictures.contains($0.id) }, key: key)
                            if after.remainder {
                                sentNote = "Sent: \u{201C}\(Self.clip(words))\u{201D}. What you wrote after it is still here."
                            }
                        }
                    }
                    .disabled(sending || (text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.wrappedValue.isEmpty))
                    .accessibilityIdentifier("org.thread.followUp.send")
                }
            }
            .onAppear { focused = true }
        }
    }

    private static func clip(_ words: String) -> String {
        let one = words.trimmingCharacters(in: .whitespacesAndNewlines)
        return one.count > 60 ? String(one.prefix(60)) + "\u{2026}" : one
    }
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
    @State private var whole = false

    var body: some View {
        let preview = OrgThreadModel.preview(markdown, budget: budget)
        VStack(alignment: .leading, spacing: 4) {
            LetterMarkdownBody(markdown: whole || preview == nil ? markdown : preview!)
                .markdownBodyFont(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier(id)
            if preview != nil {
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
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("\(id).expand")
            }
        }
    }
}
