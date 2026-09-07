import SwiftUI

/// The Chat tab's left-edge drawer: the wordmark, the agent list (only when
/// there is more than one agent to be on), the active agent's recent
/// conversations, and a floating New chat pill.
///
/// Replaced the conversation sheet (`ConversationListView`, deleted): ALL agent
/// and conversation switching now happens behind the one top-left control, which
/// is why an AGENT tap deliberately leaves the drawer open — Recents below it
/// reloads for that agent, and the next tap is the conversation. A conversation
/// tap and New chat both close, because both of them have answered the question
/// the drawer was opened to ask.
///
/// Rename / pin / delete moved here unchanged (long-press a row); they are the
/// only writes this view can make, and nothing reaches them by accident.
struct ChatDrawer: View {
    @Environment(ChatStore.self) private var chat
    /// Up while a drawer drag is being tracked, and EVERY action in here is behind
    /// it. A leftward close drag starts on a row, the row is a full-width button,
    /// and the finger never leaves its bounds, so SwiftUI still fires it on
    /// release: the drawer would close and switch conversation at once. A binding
    /// rather than a plain `Bool` so each action reads the value at the moment it
    /// runs, whatever SwiftUI did or did not rebuild while the finger was down.
    @Binding var suppressTaps: Bool
    /// Slide the drawer away.
    let close: () -> Void

    @State private var renameTarget: ConversationSummary?
    @State private var renameDraft = ""
    @State private var deleteTarget: ConversationSummary?
    @State private var actionError: String?
    /// Clearance under the last row so the floating pill never covers it. Scaled,
    /// because the pill grows with the text size and at XXXL it is twice as tall.
    @ScaledMetric(relativeTo: .subheadline) private var pillClearance: CGFloat = 84

    /// Leading inset for headers; rows reach the same 20pt via their own 8pt
    /// outer padding plus 12pt inside their selection shape.
    private static let inset: CGFloat = 20

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                // Only when there is a choice: on a server with one agent an
                // "Agents" section is a heading over a single fact.
                if chat.agents.count > 1 { agentsSection }
                recentsSection
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.hidden)
        // Something for a scrolled row to pass BEHIND at the top. A ScrollView
        // deliberately extends under the top safe area and hands it back as a
        // content inset, so at rest there is nothing up there, but a scrolled row
        // then travels behind the clock with bare background between them (the
        // gate caught the clock printed 1:1 over a row title).
        //
        // ZERO height with a background that ignores the top safe area: the inset
        // itself adds nothing, so the at-rest framing is untouched to the pixel,
        // and the background paints exactly the strip the status bar occupies. The
        // same trick carries the composer's material down through the home
        // indicator on the chat side.
        .safeAreaInset(edge: .top, spacing: 0) {
            Color.clear
                .frame(height: 0)
                .background(.bar, ignoresSafeAreaEdges: .top)
        }
        // A real bottom CONTENT INSET, not a trailing spacer: it keeps the last
        // row scrollable clear of the floating pill (so the pill's fade always
        // sits on empty space rather than on a row it has clipped), and it is what
        // the scroll view itself understands, so the same guarantee holds while the
        // page's own bottom inset changes as the tab bar steps aside.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Color.clear.frame(height: pillClearance)
        }
        .refreshable { await chat.refreshConversations() }
        .overlay(alignment: .bottom) { pillDock }
        // `children: .contain` BEFORE the container id: a container identifier
        // REPLACES every descendant's, and the rows are exactly what automation
        // taps (`chat.drawer.conversation.<id>`, `chat.drawer.newChat`).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.drawer")
        .alert("Rename Conversation", isPresented: Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )) {
            TextField("Title", text: $renameDraft)
            Button("Cancel", role: .cancel) { renameTarget = nil }
            Button("Rename") {
                let target = renameTarget
                let title = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                renameTarget = nil
                guard let target, !title.isEmpty else { return }
                Task { actionError = await chat.renameConversation(target.id, title: title) }
            }
        }
        .alert("Delete Conversation?", isPresented: Binding(
            get: { deleteTarget != nil },
            set: { if !$0 { deleteTarget = nil } }
        )) {
            Button("Cancel", role: .cancel) { deleteTarget = nil }
            Button("Delete", role: .destructive) {
                let target = deleteTarget
                deleteTarget = nil
                guard let target else { return }
                Task { actionError = await chat.deleteConversation(target.id) }
            }
        } message: {
            Text(verbatim: "This permanently deletes \"\(deleteTarget?.title ?? "this conversation")\" and its history.")
        }
        .alert("Couldn't update conversation", isPresented: Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )) {
            Button("OK", role: .cancel) { actionError = nil }
        } message: {
            Text(verbatim: actionError ?? "")
        }
    }

    // MARK: - Sections

    private var header: some View {
        Text("Walnut")
            .font(.title2.bold())
            .padding(.horizontal, Self.inset)
            .padding(.top, 10)
            .padding(.bottom, 16)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, Self.inset)
            .padding(.bottom, 4)
    }

    private var agentsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionLabel("Agents")
            ForEach(chat.agents) { agent in
                Button {
                    guard !suppressTaps else { return }
                    // No close(): the Recents list below is scoped to the agent,
                    // so the drawer stays up to show what just changed.
                    chat.switchAgent(agent.id)
                } label: {
                    agentRow(agent)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat.drawer.agent.\(agent.id)")
            }
            Divider()
                .padding(.horizontal, Self.inset)
                .padding(.top, 12)
                .padding(.bottom, 14)
        }
    }

    private func agentRow(_ agent: AgentSummary) -> some View {
        let isActive = agent.id == chat.activeAgentID
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: agent.name)
                .font(.subheadline)
                .fontWeight(isActive ? .semibold : .regular)
                .foregroundStyle(isActive ? Theme.tint : .primary)
                .lineLimit(2)
            Spacer(minLength: 4)
            if isActive {
                Image(systemName: "checkmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.tint)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            isActive ? Theme.tintSoft : Color.clear,
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
    }

    private var recentsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionLabel("Recents")
            if chat.conversations.isEmpty {
                if !chat.loadingList { emptyRecents }
            } else {
                ForEach(Self.uniqueByID(chat.conversations)) { conversation in
                    Button {
                        guard !suppressTaps else { return }
                        chat.select(conversation.id)
                        close()
                    } label: {
                        conversationRow(conversation)
                    }
                    .buttonStyle(.plain)
                    .contextMenu { rowMenu(conversation) }
                    .accessibilityIdentifier("chat.drawer.conversation.\(conversation.id)")
                }
            }
        }
    }

    /// The list `ForEach` iterates, with repeated ids dropped (first occurrence
    /// wins, order untouched).
    ///
    /// The live server's conversation index really does carry duplicate ids, and a
    /// `ForEach` over an `Identifiable` collection with a repeated id is undefined
    /// behaviour in SwiftUI, not a cosmetic double row: the duplicates share view
    /// identity, so state and animations cross between them and rows can be
    /// dropped or reused wrongly. First occurrence wins because the server already
    /// orders this list by recency, so the first copy is the freshest one.
    static func uniqueByID(_ conversations: [ConversationSummary]) -> [ConversationSummary] {
        var seen = Set<String>()
        return conversations.filter { seen.insert($0.id).inserted }
    }

    private var emptyRecents: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("No conversations yet")
                .font(.subheadline)
            Text("Start one and it will appear here.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, Self.inset)
        .padding(.vertical, 8)
    }

    /// Title over one meta line. Stacked rather than title-beside-timestamp
    /// (the sheet's shape) because the drawer is ~82% of a phone at most, and a
    /// trailing timestamp there eats the half of the row a title needs.
    /// TIME ONLY, no message count. The index row's `messageCount` is a send
    /// counter for the conversation's lane-bound CLI session, not a count of what
    /// `/conversations/:id/messages` returns: on the live server 24 of 64 rows
    /// claim "11 messages" and open empty (a server fix for the empty transcript
    /// is separate). A number the row cannot stand behind is worse than no number.
    private func conversationRow(_ conversation: ConversationSummary) -> some View {
        let isActive = conversation.id == chat.activeID
        return VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: conversation.title ?? "New conversation")
                .font(.subheadline)
                .fontWeight(isActive ? .semibold : .regular)
                .foregroundStyle(isActive ? Theme.tint : .primary)
                .lineLimit(2)
            Text(verbatim: RelativeTime.short(conversation.updatedAt))
                .font(.caption)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            isActive ? Theme.tintSoft : Color.clear,
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
    }

    /// Long-press actions: rename / pin / delete. The v1 list has no pinned
    /// flag, so both pin directions are offered (idempotent server-side).
    @ViewBuilder
    private func rowMenu(_ conversation: ConversationSummary) -> some View {
        Button {
            renameDraft = conversation.title ?? ""
            renameTarget = conversation
        } label: {
            Label("Rename", systemImage: "pencil")
        }
        Button {
            Task { actionError = await chat.setConversationPinned(conversation.id, pinned: true) }
        } label: {
            Label("Pin", systemImage: "pin")
        }
        Button {
            Task { actionError = await chat.setConversationPinned(conversation.id, pinned: false) }
        } label: {
            Label("Unpin", systemImage: "pin.slash")
        }
        Divider()
        Button(role: .destructive) {
            deleteTarget = conversation
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    /// The pill plus the fade it floats on. Without the fade a pinned button over
    /// a scrolling list reads as a collision with whatever row is behind it.
    private var pillDock: some View {
        ZStack(alignment: .bottom) {
            LinearGradient(
                colors: [
                    Color(.secondarySystemBackground).opacity(0),
                    Color(.secondarySystemBackground),
                ],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: pillClearance)
            .allowsHitTesting(false)
            newChatPill
        }
    }

    /// Floating, pinned to the bottom of the drawer: starting a new chat is the
    /// one action here that is not "go back to something", so it does not belong
    /// in the scrolling history above it.
    ///
    /// `startNewConversation()` is LOCAL — it selects "no conversation" and the
    /// row is created server-side on the first send — so this button cannot
    /// litter the server with empty threads.
    private var newChatPill: some View {
        Button {
            guard !suppressTaps else { return }
            chat.startNewConversation()
            close()
        } label: {
            Label("New chat", systemImage: "plus")
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .foregroundStyle(Theme.onTint)
                .background(Theme.tint, in: Capsule())
        }
        .buttonStyle(.plain)
        .padding(.bottom, 14)
        .accessibilityIdentifier("chat.drawer.newChat")
    }
}
