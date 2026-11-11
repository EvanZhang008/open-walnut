import SwiftUI
import UIKit

/// The comment box: the lines it is on, the words, and the two ways out (into
/// the review, or straight to the agent). Half-typed words are never lost to a
/// swipe: the sheet holds while it has any, and Cancel asks first.
struct DiffCommentComposer: View {
    let target: CommentComposerTarget
    let onAdd: (String) -> Void
    let onSendNow: (String) async -> Bool
    let onSave: (String) -> Void

    @State private var text: String
    @State private var sending = false
    @State private var sendFailed = false
    @State private var askDiscard = false
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss
    /// The quote's height grows with the text size (96 points at the default).
    @ScaledMetric(relativeTo: .caption) private var quoteHeight: CGFloat = 96

    init(target: CommentComposerTarget, onAdd: @escaping (String) -> Void,
         onSendNow: @escaping (String) async -> Bool, onSave: @escaping (String) -> Void) {
        self.target = target
        self.onAdd = onAdd
        self.onSendNow = onSendNow
        self.onSave = onSave
        _text = State(initialValue: target.editing?.comment ?? "")
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var dirty: Bool { trimmed != (target.editing?.comment ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            // Scrolls, so at the largest text size the buttons stay reachable above the keyboard.
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ReviewLocation(loc: target.loc)
                    if !target.code.isEmpty {
                        // As tall as the lines, up to about four of them; past that it scrolls.
                        ViewThatFits(in: .vertical) {
                            quote
                            ScrollView { quote }.frame(height: min(quoteHeight, 160))
                        }
                        // The code stops growing at the first accessibility size, so the box does too.
                        .frame(maxHeight: min(quoteHeight, 160))
                        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                    }
                    ZStack(alignment: .topLeading) {
                        TextEditor(text: $text)
                            .focused($focused)
                            // While Send Now is out the words are the ones going.
                            .disabled(sending)
                            .frame(minHeight: 110)
                            .scrollContentBackground(.hidden)
                            .padding(6)
                            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                            .accessibilityIdentifier("diff.comment.text")
                        if text.isEmpty {
                            Text("What should the agent know or change here?")
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 14)
                                .allowsHitTesting(false)
                        }
                    }
                    if sendFailed {
                        Label("Not sent. Your comment is still here; try again.", systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(Theme.dangerText)
                    }
                    if target.editing == nil {
                        // Side by side when they fit; stacked, primary first, at large text sizes.
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 12) {
                                sendNowButton
                                Spacer()
                                addButton
                            }
                            VStack(alignment: .leading, spacing: 10) {
                                addButton
                                sendNowButton
                            }
                        }
                        Text("Add to Review keeps it with your other comments; they go to the agent together. Send Now sends only this one.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(target.editing == nil ? "Comment" : "Edit Comment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if dirty { askDiscard = true } else { dismiss() }
                    }
                    .disabled(sending)
                    .accessibilityIdentifier("diff.comment.cancel")
                }
                if target.editing != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { onSave(trimmed) }
                            .disabled(trimmed.isEmpty)
                            .accessibilityIdentifier("diff.comment.save")
                    }
                }
            }
            .confirmationDialog("Discard this comment?", isPresented: $askDiscard, titleVisibility: .visible) {
                Button("Discard", role: .destructive) { dismiss() }
                Button("Keep Writing", role: .cancel) {}
            }
        }
        .holdsNavigation(dirty || sending)
        .onAppear { focused = true }
    }

    private var sendNowButton: some View {
        Button {
            Task { await sendNow() }
        } label: {
            if sending { ProgressView() } else { Text("Send Now") }
        }
        // A plain grey button beside the primary one, not a faded tint.
        .buttonStyle(.bordered)
        .tint(Color(uiColor: .systemGray))
        .foregroundStyle(Color(uiColor: .label))
        .disabled(trimmed.isEmpty || sending)
        .accessibilityIdentifier("diff.comment.sendNow")
    }

    private var addButton: some View {
        Button {
            onAdd(trimmed)
        } label: {
            Label("Add to Review", systemImage: "plus.bubble")
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.tint)
        .disabled(trimmed.isEmpty || sending)
        .accessibilityIdentifier("diff.comment.add")
    }

    private var quote: some View {
        Text(DiffRender.expandTabs(target.code))
            .font(.caption.monospaced())
            // Code grows no more than the diff's does.
            .dynamicTypeSize(...SessionFileDiffView.largestCodeType)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(8)
    }

    private func sendNow() async {
        sending = true
        sendFailed = false
        let ok = await onSendNow(trimmed)
        sending = false
        sendFailed = !ok
    }
}

/// The review: every comment waiting, and the send that takes them all to the
/// agent as one message (or Copy, for elsewhere).
struct DiffReviewSheet: View {
    let review: DiffReview
    let sender: ReviewSender
    let sent: () -> Void
    let show: (DiffReviewComment) -> Void

    /// The last send's outcome, when it was not delivered.
    @State private var outcome: ReviewSendResult?
    @State private var askDiscard = false
    @State private var copied = false
    @State private var showMenu = false
    /// The comment a swipe just removed, for Undo.
    @State private var removed: (comment: DiffReviewComment, index: Int)?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if review.comments.isEmpty {
                    Text("No comments yet. Tap a line in a diff to leave one.")
                        .foregroundStyle(.secondary)
                } else {
                    Section {
                        // No swipe while a send is out: the batch on its way stays as it is.
                        ForEach(review.comments) { commentRow($0).deleteDisabled(review.sending) }
                        .onDelete { offsets in
                            // One at a time on a swipe: the last one can come back.
                            for index in offsets.sorted(by: >) {
                                let comment = review.comments[index]
                                review.remove(comment.id)
                                removed = (comment, index)
                            }
                            let id = removed?.comment.id
                            Task {
                                try? await Task.sleep(for: .seconds(5))
                                if removed?.comment.id == id { removed = nil }
                            }
                        }
                    } footer: {
                        Text("Sent together as one message, in this order. Swipe a comment to remove it.")
                    }
                }
                if let removed {
                    HStack {
                        Text("Comment removed")
                        Spacer()
                        Button("Undo") {
                            review.restore(removed.comment, at: removed.index)
                            self.removed = nil
                        }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("review.undoRemove")
                    }
                }
                notes
            }
            .navigationTitle(review.comments.count == 1 ? "1 Comment" : "\(review.comments.count) Comments")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }.disabled(review.sending)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showMenu = true
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(review.comments.isEmpty || review.sending)
                    .accessibilityLabel("More")
                    .accessibilityIdentifier("review.more")
                    .popover(isPresented: $showMenu, arrowEdge: .top) {
                        DiffMenu(sections: [
                            [DiffMenuItem(id: "review.copy", title: "Copy Review", systemImage: "doc.on.doc") {
                                UIPasteboard.general.string = DiffReviewMessage.review(review.comments)
                                copied = true
                            }],
                            [DiffMenuItem(id: "review.discardAll", title: "Discard All", systemImage: "trash",
                                          destructive: true) {
                                askDiscard = true
                            }],
                        ])
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { sendBar }
            .confirmationDialog("Discard every comment in this review?", isPresented: $askDiscard, titleVisibility: .visible) {
                Button("Discard All", role: .destructive) { review.discardAll() }
                Button("Keep Them", role: .cancel) {}
            }
            .alert("Copied", isPresented: $copied) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("The review is on the clipboard, as the agent would read it.")
            }
        }
        // A swipe down mid-send would leave the send running unseen.
        .holdsNavigation(review.sending)
    }

    private var sendBar: some View {
        Button {
            Task { await sendAll() }
        } label: {
            HStack {
                if review.sending { ProgressView().tint(Theme.onTint) }
                Text(sendTitle)
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.tint)
        .disabled(review.unsent.isEmpty || review.sending)
        .padding(16)
        .background(.bar)
        .accessibilityIdentifier("review.send")
    }

    /// What became of sends that did not go: not sent, waiting in the
    /// conversation, or held by a message this phone can no longer follow.
    @ViewBuilder
    private var notes: some View {
        if outcome == .notSent {
            Label("Not sent. Your comments are still here.", systemImage: "exclamationmark.triangle")
                .foregroundStyle(Theme.dangerText)
        }
        let held = Set(review.comments.compactMap(\.heldBy))
        let unsure = held.filter { sender.state($0) == .unknown }
        if held.count > unsure.count {
            Label("Not delivered yet: the message waits in the conversation and is retried. Its comments stay here until the agent has it.",
                  systemImage: "clock")
                .foregroundStyle(Theme.secondaryOnCard)
                .accessibilityIdentifier("review.held")
        }
        if !unsure.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Label("This phone cannot tell whether the agent got some of these (the app closed before they went). Check the conversation, then send them again or swipe to remove them.",
                      systemImage: "questionmark.circle")
                    .foregroundStyle(Theme.secondaryOnCard)
                Button("Send Them Again") { review.release(unsure) }
                    .fontWeight(.semibold)
                    .disabled(review.sending)
                    .accessibilityIdentifier("review.releaseHeld")
            }
        }
    }

    private var sendTitle: String {
        let count = review.unsent.count
        if count == 0, !review.comments.isEmpty { return "Waiting to Be Delivered" }
        return count == 1 ? "Send to Agent" : "Send \(count) Comments to Agent"
    }

    /// One comment in the list: tap opens its diff at it (not while a send is out:
    /// what it is sending stays as it is).
    private func commentRow(_ comment: DiffReviewComment) -> some View {
        Button {
            show(comment)
        } label: {
            // Plain colors (a button's label would take the tint), dark
            // enough to read on the card: 4.5:1 or more.
            VStack(alignment: .leading, spacing: 4) {
                ReviewLocation(loc: comment.loc)
                if !comment.code.isEmpty {
                    Text(DiffRender.expandTabs(comment.code))
                        .font(.caption.monospaced())
                        .dynamicTypeSize(...SessionFileDiffView.largestCodeType)
                        .foregroundStyle(Theme.secondaryOnCard)
                        .lineLimit(2)
                }
                if comment.heldBy != nil {
                    Label("Waiting to be delivered", systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryOnCard)
                }
                Text(comment.comment)
                    .font(.subheadline)
                    .foregroundStyle(Color.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(review.sending)
        .accessibilityHint("Opens the diff at this comment")
        .accessibilityIdentifier("review.row")
    }

    private func sendAll() async {
        outcome = nil
        guard let result = await review.sendAll(using: sender.send) else { return }
        if result == .delivered { sent() } else { outcome = result }
    }
}

/// Another branch or one commit to compare against.
struct DiffComparePickerView: View {
    let model: SessionChangesModel
    let pick: (DiffCompare) -> Void

    @State private var query = ""

    var body: some View {
        List {
            if let refs = model.refs {
                if refs.repoRoot == nil {
                    Text("This session works in no git repository.").foregroundStyle(.secondary)
                } else {
                    let branches = refs.refs.filter { matches($0.name) }
                    if !branches.isEmpty {
                        Section("Branches") {
                            ForEach(branches, id: \.self) { ref in
                                Button {
                                    pick(ref.name == refs.defaultRef ? .branch(ref: nil) : .branch(ref: ref.name))
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(ref.name).foregroundStyle(Color(uiColor: .label))
                                            Text("Everything your branch changed since it split from \(ref.name)")
                                                .font(.caption).foregroundStyle(Theme.secondaryOnCard)
                                        }
                                        Spacer()
                                        if ref.kind == "remote" {
                                            Text("remote").font(.caption2).foregroundStyle(Theme.secondaryOnCard)
                                        }
                                        if ref.name == refs.current {
                                            Text("current").font(.caption2.weight(.semibold)).foregroundStyle(Theme.tint)
                                        }
                                        if isCompared(ref.name == refs.defaultRef ? .branch(ref: nil) : .branch(ref: ref.name)) {
                                            Image(systemName: "checkmark").foregroundStyle(Theme.tint)
                                                .accessibilityLabel("Compared now")
                                        }
                                    }
                                }
                            }
                        }
                    }
                    let commits = refs.commits.filter { matches($0.subject ?? "") || $0.sha.hasPrefix(query.lowercased()) }
                    if !commits.isEmpty {
                        Section("Commits") {
                            ForEach(commits, id: \.sha) { commit in
                                Button {
                                    pick(.commit(sha: commit.sha))
                                } label: {
                                    HStack {
                                    // Explicit colors: a button's label takes the tint otherwise.
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(commit.subject ?? commit.sha).foregroundStyle(Color(uiColor: .label)).lineLimit(2)
                                        HStack(spacing: 6) {
                                            Text(String(commit.sha.prefix(7))).font(.caption.monospaced())
                                            if let author = commit.author { Text(author).font(.caption) }
                                            if let time = commit.time {
                                                // "1 hour ago", not a running timer.
                                                Text(Date(timeIntervalSince1970: time).formatted(.relative(presentation: .named)))
                                                    .font(.caption)
                                            }
                                        }
                                        .foregroundStyle(Theme.secondaryOnCard)
                                    }
                                    Spacer()
                                    if isCompared(.commit(sha: commit.sha)) {
                                        Image(systemName: "checkmark").foregroundStyle(Theme.tint)
                                            .accessibilityLabel("Compared now")
                                    }
                                    }
                                }
                                .accessibilityIdentifier("compare.commit.\(commit.sha.prefix(7))")
                            }
                        }
                    }
                }
            } else if let error = model.refsError {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Could not read the branches").font(.headline)
                    Text(error).font(.footnote).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await model.loadRefs() } }.buttonStyle(.bordered)
                }
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
        }
        // A field under the title, as the app's other searches: left to iOS 26, a sheet
        // folds it into a round bottom-bar button with no glyph that reads as nothing.
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Branch, commit or message")
        .navigationTitle("Compare With")
        .navigationBarTitleDisplayMode(.inline)
        .task { if model.refs == nil { await model.loadRefs() } }
    }

    /// The comparison on the page now (a short sha matches its full one).
    private func isCompared(_ option: DiffCompare) -> Bool {
        if case .commit(let a) = option, case .commit(let b) = model.compare {
            return a.hasPrefix(b) || b.hasPrefix(a)
        }
        return option == model.compare
    }

    private func matches(_ text: String) -> Bool {
        query.isEmpty || text.localizedCaseInsensitiveContains(query)
    }
}

/// Where a comment is: the file and its lines first ("PricingTable.tsx:L1-L2"),
/// whole, and the folder under it, which gives way first.
struct ReviewLocation: View {
    let loc: String

    var body: some View {
        let parts = Self.split(loc)
        VStack(alignment: .leading, spacing: 1) {
            // Breaks where the name has a seam ("Pricing" / "Table.tsx:L1-L2"), not mid-name.
            Text(ChangedFileRow.breakable(parts.name))
                .font(.caption.weight(.semibold).monospaced())
                .foregroundStyle(Theme.secondaryOnCard)
                .lineLimit(2)
                .truncationMode(.middle)
            if let folder = parts.folder {
                Text(folder)
                    .font(.caption2.monospaced())
                    .foregroundStyle(Theme.secondaryOnCard)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
        // Code-like text grows no more than the diff's does.
        .dynamicTypeSize(...SessionFileDiffView.largestCodeType)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(loc)
    }

    /// "src/a/B.tsx:L1-L2" -> ("B.tsx:L1-L2", "src/a").
    static func split(_ loc: String) -> (name: String, folder: String?) {
        guard let slash = loc.lastIndex(of: "/") else { return (loc, nil) }
        let folder = String(loc[..<slash])
        return (String(loc[loc.index(after: slash)...]), folder.isEmpty ? nil : folder)
    }
}
