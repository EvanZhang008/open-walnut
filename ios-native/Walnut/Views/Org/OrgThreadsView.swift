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
    /// The thread a push or a link asked for: shown open and scrolled to.
    var focusThreadId: String? = nil

    // Snoozed and In progress stay as he left them, per node (the web keeps a view per node);
    // Closed is history, so every visit starts with it folded.
    @AppStorage("org.threads.openFolds") private var openFolds = ""
    @State private var showClosed = false

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
        ScrollViewReader { proxy in
            ScrollView {
                // A plain stack: only the open cards render (the rest sit behind folds), and a
                // lazy stack re-measuring folded Markdown as cards came into view never settled.
                VStack(alignment: .leading, spacing: 12) {
                    if let error = store.error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(Theme.needsText)
                            .accessibilityIdentifier("org.threads.error")
                    }
                    if store.threads == nil {
                        if store.error == nil {
                            ProgressView("Loading threads…")
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        }
                    } else if sections.open.isEmpty {
                        emptyText(sections)
                    } else if sections.open.count > 2 {
                        jumps(sections, proxy: proxy)
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
                    fold("\(sections.closed.count) closed this week", count: sections.closed.count, open: foldBinding("closed"), id: "closed")
                    if showClosed {
                        ForEach(sections.closed) { t in card(t, shared: shared, now: now, snoozed: false, compact: true).id(t.id) }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            // At the bottom, above the tab bar: where the eye is after the card's buttons, and off the cards' text.
            .overlay(alignment: .bottom) { noticeView }
            .refreshable { await store.load() }
            .onChange(of: store.threads?.count ?? -1) { reveal(focusThreadId, sections: sections, proxy: proxy) }
            .onAppear { reveal(focusThreadId, sections: sections, proxy: proxy) }
        }
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
        OrgThreadCard(
            thread: t, all: store.threads ?? [], shared: shared, name: name, now: now, snoozed: snoozed,
            busy: store.busyThreadId == t.id, canFollowUp: sessionId != nil,
            startsOpen: t.id == focusThreadId, compact: compact, followUpSentAt: store.followUpSentAt[t.id],
            onEdit: { edit in Task { await store.edit(t.id, edit) } },
            onFollowUp: { text, images in
                guard let sessionId else { return false }
                return await store.followUp(t.id, sessionId: sessionId, text: text, images: images)
            }
        )
    }

    /// A thread asked for by id that sits in a folded section opens that section first.
    private func reveal(_ id: String?, sections: OrgThreadModel.Sections, proxy: ScrollViewProxy) {
        guard let id, store.threads != nil else { return }
        if sections.snoozed.contains(where: { $0.id == id }) { foldBinding("snoozed").wrappedValue = true }
        if sections.inProgress.contains(where: { $0.id == id }) { foldBinding("inProgress").wrappedValue = true }
        if sections.closed.contains(where: { $0.id == id }) { showClosed = true }
        DispatchQueue.main.async { withAnimation { proxy.scrollTo(id, anchor: .top) } }
    }

    /// Under a long list, one tap to the folds below it (2026-11-04 review: a dozen screens of
    /// cards before them).
    private func jumps(_ s: OrgThreadModel.Sections, proxy: ScrollViewProxy) -> some View {
        let items: [(id: String, label: String, count: Int, open: Binding<Bool>)] = [
            ("snoozed", "Snoozed", s.snoozed.count, foldBinding("snoozed")),
            ("inProgress", "In progress", s.inProgress.count, foldBinding("inProgress")),
            ("closed", "Closed", s.closed.count, foldBinding("closed")),
        ].filter { $0.count > 0 }
        return HStack(spacing: 8) {
            Text("\(s.open.count) for you")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            ForEach(items, id: \.id) { item in
                Button {
                    item.open.wrappedValue = true
                    DispatchQueue.main.async { withAnimation { proxy.scrollTo("fold.\(item.id)", anchor: .top) } }
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
    let onEdit: (OrgThreadEdit) -> Void
    let onFollowUp: (String, [SelectedImage]) async -> Bool

    @Environment(TasksStore.self) private var tasks
    @State private var conversation = false
    @State private var expanded = false
    @State private var following = false
    @State private var target: TaskOpenTarget?

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
                Image(systemName: "chevron.down")
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
            conversationToggle
            if conversation {
                OrgThreadConversation(thread: t, shared: shared, name: name, now: now)
                // The conversation runs screens long: it closes from its end too.
                conversationToggle
            }
            actions
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            if t.state == "needs" && !closed {
                RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.danger.opacity(0.45), lineWidth: 1)
            }
        }
        .opacity(closed ? 0.75 : 1)
        .onAppear { if startsOpen, OrgThreadModel.unread(t, shared: shared).isEmpty { conversation = true } }
        .sheet(isPresented: $following) {
            OrgThreadFollowUpSheet(title: t.title, send: onFollowUp)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $target) { target in
            TaskSessionSheet(target: target)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("org.thread.\(t.id)")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                // The same mark folded or open: a check once closed, else its state's colour.
                Image(systemName: closed ? "checkmark.circle.fill" : "circle.fill")
                    .font(closed ? .caption : .system(size: 8))
                    .foregroundStyle(closed ? Theme.doneText : stateColor)
                    .accessibilityHidden(true)
                Text(OrgThreadModel.stateLabel(t))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(t.state == "needs" && !closed ? Theme.needsText : .secondary)
                Text("·").foregroundStyle(.tertiary).font(.caption)
                Text(timeAgo)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if t.opener != nil {
                    Text("· Opened by \(name)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if compact && expanded {
                    Button { withAnimation(.snappy) { expanded = false } } label: {
                        Image(systemName: "chevron.up")
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
            Text(t.title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("org.thread.title")
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
            let titles = ids.map { id in tasks.tasks.first { $0.id == id }?.title ?? id }
            OrgChipFlow(spacing: 6) {
                ForEach(ids, id: \.self) { id in
                    let task = tasks.tasks.first { $0.id == id }
                    let title = task?.title ?? id
                    // Two chips with one title say their state, so they can be told apart.
                    let twin = titles.filter { $0 == title }.count > 1
                    Button { target = TaskOpenTarget(id: id, title: task?.title) } label: {
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

    @ViewBuilder
    private var conversationToggle: some View {
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
            .accessibilityIdentifier("org.thread.conversation")
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
        } else {
            HStack(spacing: 8) {
                Button("Acknowledge") { onEdit(.acknowledge) }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.tint)
                    .accessibilityIdentifier("org.thread.ack")
                if canFollowUp {
                    Button("Follow up") { following = true }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("org.thread.followUp")
                }
                snoozeMenu
                Spacer(minLength: 0)
                if busy { ProgressView().controlSize(.small) }
            }
            .controlSize(.small)
            .disabled(busy)
        }
    }

    private var snoozeMenu: some View {
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
            Text(snoozed ? "Snoozed" : "Snooze")
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
            text = exchange.answer?.text ?? ""; at = exchange.answer?.at ?? ""; by = name
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

/// Follow up on a thread: his words (and pictures, as the chat takes) go into the node's
/// chat, filed under this thread.
struct OrgThreadFollowUpSheet: View {
    let title: String
    let send: (String, [SelectedImage]) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var images: [SelectedImage] = []
    @State private var pictureNotice: String?
    @State private var sending = false
    @State private var failed = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                TextEditor(text: $text)
                    .focused($focused)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 80, maxHeight: .infinity)
                    .padding(8)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("org.thread.followUp.input")
                ReplyPictureStrip(images: $images, notice: $pictureNotice, idPrefix: "org.thread.followUp")
                ReplyPictureButton(
                    images: $images, notice: $pictureNotice, idPrefix: "org.thread.followUp",
                    disabled: sending, onWillPresent: { focused = false }
                )
                if failed {
                    Text("Not sent. Your words are still here.")
                        .font(.footnote)
                        .foregroundStyle(Theme.needsText)
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
                        sending = true
                        failed = false
                        Task {
                            let ok = await send(text, images)
                            sending = false
                            if ok { dismiss() } else { failed = true }
                        }
                    }
                    .disabled(sending || (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty))
                    .accessibilityIdentifier("org.thread.followUp.send")
                }
            }
            .onAppear { focused = true }
        }
    }
}

/// Chips that wrap onto the next line instead of running off the screen.
struct OrgChipFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: width, height: nil))
            if x > 0, x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, min(x - spacing, width))
        }
        return CGSize(width: widest, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
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
