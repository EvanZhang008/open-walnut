import SwiftUI
import UIKit
import Observation

/// What the comment box is open for: new lines, or a comment being edited.
struct CommentComposerTarget: Identifiable {
    let id = UUID()
    let loc: String
    let code: String
    /// The lines a new comment is on (empty when editing).
    let lines: [DiffLine]
    /// Set when editing a comment already in the review.
    let editing: DiffReviewComment?
}

/// One file's diff: unified, colored, folded around the changes. Tap a line to
/// select it, tap another to stretch the selection, then Comment. Comments wait
/// in the review (or go now) and show as cards under their lines.
struct SessionFileDiffView: View {
    let file: SessionChangedFile
    let files: [SessionChangedFile]
    let model: SessionChangesModel
    let review: DiffReview
    let sender: ReviewSender
    let openReview: () -> Void
    let open: (SessionChangedFile) -> Void
    /// Switch the page to Uncommitted (an edit the session's history cannot rebuild).
    let showUncommitted: () -> Void

    /// The content on screen (the list's record until a read brings it).
    @State private var shownFile: SessionChangedFile?
    @State private var render: DiffRender?
    /// A read is out while a copy (or the last read) shows.
    @State private var refreshing = false
    @State private var refreshError: String?
    @State private var scroll = DiffScrollState()
    @State private var rows: [DiffRow] = []
    @State private var fromCopy: Date?
    @State private var loadError: String?
    @State private var opened: [Range<Int>] = []
    @State private var selection: ClosedRange<Int>?
    @State private var selectionAnchor: Int?
    @State private var composer: CommentComposerTarget?
    @State private var limit = SessionFileDiffView.pageRows
    @State private var notice: String?
    @State private var reloadToken = 0
    /// A row to bring into view (the review opened this diff at a comment).
    @State private var focusRow: String?
    @State private var showMore = false
    /// The card just removed, for Undo (and where it stood in the review).
    @State private var removed: (comment: DiffReviewComment, index: Int)?
    @AppStorage("diff.wrapLines") private var wrap = false
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Rows drawn before "Show more": a 20,000-line rewrite opens at once and
    /// draws the rest when asked.
    static let pageRows = 1500

    /// Past these the code grows no more (one line of it would no longer fit
    /// a phone's width), and the header and bars stay a few lines tall.
    static let largestCodeType = DynamicTypeSize.accessibility1
    static let largestChromeType = DynamicTypeSize.accessibility2

    var body: some View {
        VStack(spacing: 0) {
            header
                .dynamicTypeSize(...Self.largestChromeType)
            Divider()
            content
                .dynamicTypeSize(...Self.largestCodeType)
        }
        .navigationTitle(file.fileName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { diffToolbar }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar.dynamicTypeSize(...Self.largestChromeType) }
        .sheet(item: $composer) { target in
            DiffCommentComposer(target: target, onAdd: { text in
                addComment(target, text)
            }, onSendNow: { text in
                await sendNow(target, text)
            }, onSave: { text in
                if let editing = target.editing { review.edit(editing.id, comment: text) }
                composer = nil
            })
            // Full height at the largest text sizes: half a screen holds only a line or two.
            .presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.medium, .large])
            .presentationDragIndicator(.visible)
            .presentationBackground(Color(uiColor: .systemBackground))
        }
        // Reload (the same file on screen) reads again; another file opens fresh.
        .task(id: "\(file.filePath)\u{1}\(reloadToken)") { await load(refresh: shownFile?.filePath == file.filePath) }
        // The review asked for a comment in the diff already open.
        .onChange(of: model.focus?.lineKey) { _, key in
            if key != nil, let render { takeFocus(render) }
        }
    }

    // MARK: - Header and bars

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            // At the largest text sizes the counts go under the path, which keeps its width.
            let stacked = typeSize.isAccessibilitySize
            (stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 8))) {
                HStack(spacing: 8) {
                    ChangeStatusMark(status: file.status)
                    Text(file.relPath)
                        .font(.footnote.monospaced())
                        .lineLimit(stacked ? 3 : 2)
                        .truncationMode(.head)
                        .textSelection(.enabled)
                }
                if !stacked { Spacer(minLength: 4) }
                HStack(spacing: 8) {
                    if refreshing, render != nil { ProgressView().controlSize(.mini) }
                    if let render, !render.diff.isEmpty, !render.diff.approximate {
                        LineCounts(additions: render.diff.additions, deletions: render.diff.deletions)
                    } else if let a = file.additions, let d = file.deletions {
                        // A rewrite too large to align shows as all removed, then all
                        // added: the list's count says how much really changed.
                        LineCounts(additions: a, deletions: d)
                    }
                }
            }
            if file.status == "renamed", let old = file.oldRelPath {
                Text("Renamed from \(old)").font(.caption).foregroundStyle(.secondary)
            }
            if let since = fromCopy {
                let age = RelativeDateTimeFormatter().localizedString(for: since, relativeTo: Date())
                Label(refreshing ? "The copy saved \(age). Checking for a newer one\u{2026}"
                                 : "Offline. This is the copy saved \(age).",
                      systemImage: refreshing ? "clock.arrow.circlepath" : "wifi.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("diff.offline")
            } else if let refreshError {
                Label("Could not reload: \(refreshError)", systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("diff.reloadError")
            }
            if shownFile?.partial == true, render?.diff.isEmpty == false {
                Label("This file changed after the session edited it, so this diff is rebuilt as well as Walnut could.",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(Theme.reviewText)
                    .accessibilityIdentifier("diff.partial")
            }
            if let cut = render?.cutLines, cut > 0 {
                Text(cut == 1 ? "1 line is longer than \(DiffRender.maxShownCharacters.formatted()) characters and is cut there. Select it, then Copy, to copy all of it."
                              : "\(cut) lines are longer than \(DiffRender.maxShownCharacters.formatted()) characters and are cut there. Select one, then Copy, to copy all of it.")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("diff.cutNote")
            }
            if render?.diff.approximate == true {
                Text("Most of this file was rewritten, so its middle shows as removed, then added.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let render, !render.diff.isEmpty {
                // Always there, two lines high whatever it says: the diff under it
                // never jumps when a tap selects or Clear unselects.
                Text(Self.hint(selection))
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(typeSize.isAccessibilitySize ? 3 : 2, reservesSpace: true)
                    .accessibilityIdentifier("diff.hint")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ToolbarContentBuilder
    private var diffToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button {
                step(-1)
            } label: {
                Image(systemName: "chevron.up")
            }
            .disabled(index <= 0)
            .accessibilityLabel("Previous file")
            .accessibilityIdentifier("diff.previousFile")
            Button {
                step(1)
            } label: {
                Image(systemName: "chevron.down")
            }
            .disabled(index < 0 || index >= files.count - 1)
            .accessibilityLabel("Next file")
            .accessibilityIdentifier("diff.nextFile")
            Button {
                showMore = true
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel("More")
            .accessibilityIdentifier("diff.more")
            .popover(isPresented: $showMore, arrowEdge: .top) {
                DiffMenu(sections: [
                    [DiffMenuItem(id: "diff.wrap", title: "Wrap Long Lines", systemImage: "text.word.spacing",
                                  checked: wrap) { wrap.toggle() }],
                    [DiffMenuItem(id: "diff.copyPath", title: "Copy Path", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = file.relPath
                        flash("Path copied")
                     },
                     DiffMenuItem(id: "diff.reload", title: "Reload", systemImage: "arrow.clockwise") {
                        reloadToken += 1
                     }],
                ])
            }
        }
    }

    @ViewBuilder
    private var bottomBar: some View {
        if let selection, let render {
            let lines = selectedLines(selection, render)
            // One row when it fits; at large text sizes the lines go above the buttons.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    selectionLabel(lines)
                    Spacer(minLength: 4)
                    selectionButtons(lines)
                }
                VStack(alignment: .leading, spacing: 8) {
                    selectionLabel(lines)
                    HStack(spacing: 12) {
                        Spacer(minLength: 0)
                        selectionButtons(lines)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
        } else if let removed {
            HStack {
                Text("Comment removed")
                    .font(.subheadline.weight(.medium))
                Spacer()
                Button("Undo") {
                    review.restore(removed.comment, at: removed.index)
                    self.removed = nil
                }
                .font(.subheadline.weight(.semibold))
                .accessibilityIdentifier("diff.undoRemove")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
        } else if let notice {
            Text(notice)
                .font(.subheadline.weight(.medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(.bar)
                .overlay(alignment: .top) { Divider() }
                .accessibilityIdentifier("diff.notice")
        } else if !review.comments.isEmpty {
            ReviewBar(count: review.comments.count, open: openReview)
        }
    }

    private func selectionLabel(_ lines: [DiffLine]) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            // The lines only: the header above names the file.
            Text(DiffReviewMessage.loc(relPath: file.fileName, lines: lines).split(separator: ":").last.map(String.init) ?? "")
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .lineLimit(1)
            Text(lines.count == 1 ? "1 line selected" : "\(lines.count) lines selected")
                .font(.caption).foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private func selectionButtons(_ lines: [DiffLine]) -> some View {
        Button {
            UIPasteboard.general.string = DiffReviewMessage.code(lines)
            selection = nil
            selectionAnchor = nil
            flash(lines.count == 1 ? "Line copied" : "\(lines.count) lines copied")
        } label: {
            Image(systemName: "doc.on.doc")
        }
        .accessibilityLabel(lines.count == 1 ? "Copy Line" : "Copy Lines")
        .accessibilityIdentifier("diff.selection.copy")
        Button("Clear") {
            selection = nil
            selectionAnchor = nil
        }
        .fixedSize()
        .accessibilityIdentifier("diff.selection.clear")
        Button {
            composer = CommentComposerTarget(
                loc: DiffReviewMessage.loc(relPath: file.relPath, lines: lines),
                code: DiffReviewMessage.code(lines), lines: lines, editing: nil)
        } label: {
            Label("Comment", systemImage: "text.bubble")
                .lineLimit(1)
                .fixedSize()
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.tint)
        .accessibilityIdentifier("diff.comment")
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if let render, let shown = shownFile {
            if let empty = DiffEmptyState.of(shown, diff: render.diff) {
                ContentUnavailableView {
                    Label(empty.title, systemImage: empty.symbol)
                } description: {
                    Text(empty.detail)
                } actions: {
                    if empty.offersUncommitted, model.compare != .uncommitted {
                        Button("Show It Against the Last Commit", action: showUncommitted)
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("diff.showUncommitted")
                    }
                }
                .accessibilityIdentifier("diff.empty")
            } else {
                GeometryReader { geo in
                    canvas(render, viewport: geo.size.width, height: geo.size.height)
                }
            }
        } else if let loadError {
            ContentUnavailableView {
                Label("Could not read this diff", systemImage: "exclamationmark.triangle")
            } description: {
                Text(loadError)
            } actions: {
                Button("Try Again") { reloadToken += 1 }.buttonStyle(.bordered)
            }
            .accessibilityIdentifier("diff.error")
        } else {
            ProgressView("Reading the diff\u{2026}")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func canvas(_ render: DiffRender, viewport: CGFloat, height: CGFloat) -> some View {
        let metrics = DiffMetrics(lineCount: render.diff.lines.count, typeSize: min(typeSize, Self.largestCodeType))
        let width = wrap ? viewport : max(viewport, metrics.canvasWidth(widestLine: render.widestLine))
        let comments = review.comments(onFile: file.filePath, compareKey: model.compare.cacheKey)
        let commented = Set(comments.flatMap(\.lineKeys))
        let cards = Dictionary(grouping: comments, by: \.anchorKey)
        let shown = rows.prefix(limit)
        // Folds, cards and "Show more" stay on screen while the lines scroll sideways.
        let pinnedWidth = min(width, viewport)
        return ScrollViewReader { proxy in
            ScrollView(wrap ? [.vertical] : [.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(shown)) { row in
                        switch row {
                        case .line(let i):
                            let line = render.diff.lines[i]
                            DiffLineRow(line: line, styled: render.styled[i], metrics: metrics, wrap: wrap,
                                        width: width, scroll: scroll, selected: selection?.contains(i) == true,
                                        commented: commented.contains(line.key))
                                .contentShape(Rectangle())
                                .onTapGesture { tap(i) }
                                // A long press selects just this line, whatever was selected.
                                .onLongPressGesture(minimumDuration: 0.45) { selectOnly(i) }
                                .accessibilityAction(named: "Comment on This Line") { commentOn(i, line) }
                                .accessibilityAction(named: "Copy Line") { UIPasteboard.general.string = line.text }
                                .accessibilityIdentifier("diff.line.\(line.key)")
                                .id(row.id)
                            ForEach(cards[line.key] ?? []) { card in
                                DiffCommentCard(comment: card, stale: !render.reads(card), edit: {
                                    composer = CommentComposerTarget(loc: card.loc, code: card.code, lines: [], editing: card)
                                }, remove: {
                                    if let index = review.comments.firstIndex(where: { $0.id == card.id }) {
                                        removed = (card, index)
                                        review.remove(card.id)
                                        let id = card.id
                                        Task {
                                            try? await Task.sleep(for: .seconds(5))
                                            if removed?.comment.id == id { removed = nil }
                                        }
                                    }
                                })
                                .frame(width: pinnedWidth, alignment: .leading)
                                .modifier(PinnedToViewport(scroll: scroll, active: !wrap))
                            }
                        case .fold(let range):
                            DiffFoldRow(count: range.count, metrics: metrics) {
                                opened += FileDiff.opening(range)
                                rows = render.diff.rows(opened: opened)
                            }
                            .frame(width: pinnedWidth, alignment: .leading)
                            .modifier(PinnedToViewport(scroll: scroll, active: !wrap))
                            .accessibilityIdentifier("diff.fold.\(range.lowerBound)")
                            .id(row.id)
                        }
                    }
                    if rows.count > limit {
                        Button {
                            limit += Self.pageRows
                        } label: {
                            Text("Show \(min(Self.pageRows, rows.count - limit)) more lines (\(rows.count - limit) left)")
                                .font(.subheadline.weight(.medium))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                        }
                        .frame(width: pinnedWidth)
                        .modifier(PinnedToViewport(scroll: scroll, active: !wrap))
                        .accessibilityIdentifier("diff.showMore")
                    }
                }
                .padding(.bottom, 24)
                // A scroll view centers what is shorter than itself: a short diff starts at the top.
                .frame(minHeight: height, alignment: .topLeading)
            }
            .onScrollGeometryChange(for: CGFloat.self) { geo in
                geo.contentOffset.x
            } action: { _, x in
                scroll.x = max(0, x)
            }
            // initial: the rows (and this reader) appear in the same update that sets it.
            .onChange(of: focusRow, initial: true) { _, target in
                guard let target else { return }
                // After the rows that hold it are laid out.
                Task { @MainActor in
                    withAnimation { proxy.scrollTo(target, anchor: .center) }
                    focusRow = nil
                }
            }
        }
        .accessibilityIdentifier("diff.lines")
    }

    private func commentOn(_ i: Int, _ line: DiffLine) {
        selection = i...i
        selectionAnchor = i
        composer = CommentComposerTarget(
            loc: DiffReviewMessage.loc(relPath: file.relPath, lines: [line]),
            code: line.text, lines: [line], editing: nil)
    }

    private func selectOnly(_ i: Int) {
        selection = i...i
        selectionAnchor = i
        notice = nil
        UISelectionFeedbackGenerator().selectionChanged()
    }

    // MARK: - Actions

    /// The selected lines that are drawn: a run across a fold quotes only what the
    /// person saw, as the web diff does.
    private func selectedLines(_ selection: ClosedRange<Int>, _ render: DiffRender) -> [DiffLine] {
        rows.compactMap { row -> DiffLine? in
            guard case .line(let i) = row, selection.contains(i) else { return nil }
            return render.diff.lines[i]
        }
    }

    private var index: Int { files.firstIndex { $0.filePath == file.filePath } ?? -1 }

    private func step(_ by: Int) {
        let next = index + by
        guard index >= 0, files.indices.contains(next) else { return }
        open(files[next])
    }

    /// A tap selects a line; a second tap takes in the lines between; a tap once
    /// a run is selected starts again from that line (so a stray tap never grows
    /// a run past what was meant), and a tap on the one selected line clears it.
    private func tap(_ i: Int) {
        selection = Self.selecting(i, current: selection, anchor: selectionAnchor)
        selectionAnchor = selection == nil ? nil : (selection?.count == 1 ? i : selectionAnchor)
        notice = nil
    }

    /// What the header says a tap does now.
    static func hint(_ selection: ClosedRange<Int>?) -> String {
        guard let selection else { return "Tap a line to select it, tap another to select the lines between, then Comment." }
        return selection.count == 1 ? "Tap another line to select the lines between, or tap this one again to clear."
                                    : "Tap any line to start a new selection."
    }

    static func selecting(_ i: Int, current: ClosedRange<Int>?, anchor: Int?) -> ClosedRange<Int>? {
        guard let current else { return i...i }
        if current.count == 1 {
            if current.lowerBound == i { return nil }
            let from = anchor ?? current.lowerBound
            return min(from, i)...max(from, i)
        }
        return i...i
    }

    private func addComment(_ target: CommentComposerTarget, _ text: String) {
        review.add(file: file, compare: model.compare, lines: target.lines, comment: text)
        composer = nil
        selection = nil
        selectionAnchor = nil
        flash("Added to your review")
    }

    /// True when the agent has it, or a bubble holds it to retry (the box then
    /// closes); a held one is also kept in the review, marked, until it is delivered,
    /// as the bubble lives only in memory.
    private func sendNow(_ target: CommentComposerTarget, _ text: String) async -> Bool {
        let message = DiffReviewMessage.comment(loc: target.loc, code: target.code, comment: text)
        switch await sender.send(message) {
        case .notSent:
            return false
        case .delivered:
            flash("Sent to the agent")
        case .held(let id):
            review.add(file: file, compare: model.compare, lines: target.lines, comment: text, heldBy: id)
            flash("Not delivered yet. Kept in your review until it is.")
        }
        composer = nil
        selection = nil
        selectionAnchor = nil
        return true
    }

    private func flash(_ text: String) {
        notice = text
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            if notice == text { notice = nil }
        }
    }

    /// The diff: this phone's copy at once when there is one, then the server's.
    /// `refresh` (Reload) reads it again; the diff on screen stays until then.
    private func load(refresh: Bool) async {
        loadError = nil
        refreshError = nil
        if !refresh {
            render = nil
            shownFile = nil
            selection = nil
            selectionAnchor = nil
            opened = []
            limit = Self.pageRows
            if let saved = await model.savedCopy(of: file) {
                guard !Task.isCancelled else { return }
                await show(saved.file, fromCopy: saved.savedAt)
            }
        }
        refreshing = true
        defer { refreshing = false }
        do {
            let read = try await model.content(of: file, refresh: refresh)
            guard !Task.isCancelled else { return }
            // An unchanged answer leaves the page as it is (selection, opened folds).
            if read.file == shownFile, read.fromCopy == fromCopy { return }
            await show(read.file, fromCopy: read.fromCopy)
        } catch {
            guard !Task.isCancelled else { return }
            if render == nil {
                loadError = error.localizedDescription
            } else if fromCopy == nil {
                refreshError = error.localizedDescription
            }
        }
    }

    private func show(_ full: SessionChangedFile, fromCopy: Date?) async {
        let name = file.fileName
        let made = await Task.detached(priority: .userInitiated) {
            DiffRender.make(before: full.before, after: full.after, fileName: name)
        }.value
        guard !Task.isCancelled else { return }
        let sameLines = render?.diff == made.diff
        self.fromCopy = fromCopy
        shownFile = full
        if !sameLines {
            selection = nil
            selectionAnchor = nil
            opened = []
        }
        rows = made.diff.rows(opened: opened)
        render = made
        takeFocus(made)
    }

    /// Open the diff at the comment the review was showing: unfold its lines,
    /// draw far enough, and scroll there.
    private func takeFocus(_ render: DiffRender) {
        guard let focus = model.focus, focus.filePath == file.filePath else { return }
        model.focus = nil
        guard let index = render.indexByKey[focus.lineKey] else { return }
        if !rows.contains(.line(index: index)) {
            opened.append(max(0, index - FileDiff.context)..<min(render.diff.lines.count, index + FileDiff.context + 1))
            rows = render.diff.rows(opened: opened)
        }
        if let at = rows.firstIndex(of: .line(index: index)), at >= limit {
            limit = (at / Self.pageRows + 1) * Self.pageRows
        }
        focusRow = DiffRow.line(index: index).id
    }
}

/// How far the diff has scrolled sideways, for the rows that stay in view. Its
/// own object, so a sideways scroll redraws those rows and not every line.
@MainActor
@Observable
final class DiffScrollState {
    var x: CGFloat = 0
}

/// Keeps a full-width row (a fold, a card) in view while the lines under it
/// scroll sideways.
struct PinnedToViewport: ViewModifier {
    let scroll: DiffScrollState
    let active: Bool

    func body(content: Content) -> some View {
        content.offset(x: active ? scroll.x : 0)
    }
}

/// What a diff with no line to show says instead, never a bare "no change" for
/// what could not be read.
struct DiffEmptyState: Equatable {
    let title: String
    let detail: String
    let symbol: String
    /// The session's edit could not be rebuilt: git's view of the file may help.
    var offersUncommitted = false

    static func of(_ file: SessionChangedFile, diff: FileDiff) -> DiffEmptyState? {
        if file.isBinary {
            return DiffEmptyState(title: "Binary file", detail: "There is no line diff to show for it.", symbol: "doc.zipper")
        }
        guard diff.isEmpty else { return nil }
        if file.partial == true {
            return DiffEmptyState(
                title: "This edit could not be rebuilt",
                detail: "The file changed after the session edited it, so the session's own edit cannot be shown here.",
                symbol: "exclamationmark.triangle", offersUncommitted: true)
        }
        if file.status == "renamed" {
            return DiffEmptyState(title: "Renamed, no line changed",
                                  detail: file.oldRelPath.map { "Moved from \($0) as it was." } ?? "Moved as it was.",
                                  symbol: "arrow.right.doc.on.clipboard")
        }
        if file.before != file.after,
           file.before.replacingOccurrences(of: "\r\n", with: "\n") == file.after.replacingOccurrences(of: "\r\n", with: "\n") {
            // The diff reads CRLF and LF lines alike, so it shows no line: say why.
            return DiffEmptyState(title: "Only line endings changed",
                                  detail: "Every line is the same text; the file switched between Windows (CRLF) and Unix (LF) line endings.",
                                  symbol: "return")
        }
        if file.wsOnly == true {
            return DiffEmptyState(title: "Only whitespace changed", detail: "Every change in this file is spaces, tabs or line ends.",
                                  symbol: "text.alignleft")
        }
        if file.before.isEmpty, file.after.isEmpty {
            // Known empty only when the server counted it so; otherwise the text never came.
            if file.status == "added", file.additions == 0 {
                return DiffEmptyState(title: "Added, empty", detail: "The new file has no lines.", symbol: "doc")
            }
            if file.status == "deleted", file.deletions == 0 {
                return DiffEmptyState(title: "Deleted, it was empty", detail: "The file had no lines.", symbol: "doc")
            }
            return DiffEmptyState(title: "No text to show",
                                  detail: "Walnut could not read this file's text: it may be binary, too large, or unreadable.",
                                  symbol: "doc.questionmark")
        }
        return DiffEmptyState(title: "No line changed", detail: "The two versions have the same lines.", symbol: "doc.text")
    }
}

// MARK: - Metrics

/// Sizes of one diff's columns at the current text size.
@MainActor
struct DiffMetrics {
    let codeFont: UIFont
    let numberWidth: CGFloat
    let markerWidth: CGFloat = 14

    init(lineCount: Int, typeSize: DynamicTypeSize) {
        let traits = UITraitCollection(preferredContentSizeCategory: typeSize.uiContentSizeCategory)
        let size = UIFont.preferredFont(forTextStyle: .caption1, compatibleWith: traits).pointSize
        codeFont = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
        numberWidth = FileSourceLinesView.numberWidth(forLineCount: lineCount, traits: traits) + 6
    }

    var gutterWidth: CGFloat { numberWidth * 2 + markerWidth }

    /// The code font as SwiftUI draws it (the same face and size `codeFont` measures).
    var codeSwiftUIFont: Font { .system(size: codeFont.pointSize, design: .monospaced) }

    /// The no-wrap canvas: wide enough for the widest line.
    func canvasWidth(widestLine: String) -> CGFloat {
        let text = (widestLine.isEmpty ? " " : widestLine) as NSString
        return ceil(text.size(withAttributes: [.font: codeFont]).width) + gutterWidth + 24
    }
}

// MARK: - Rows

struct DiffLineRow: View {
    let line: DiffLine
    let styled: AttributedString
    let metrics: DiffMetrics
    let wrap: Bool
    /// The canvas width: the row's color runs all the way across it.
    let width: CGFloat
    /// How far the canvas scrolled sideways: the line numbers and +/- stay in view.
    let scroll: DiffScrollState
    let selected: Bool
    let commented: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                number(line.oldNumber)
                number(line.newNumber)
                Text(verbatim: marker)
                    .font(metrics.codeSwiftUIFont)
                    .foregroundStyle(markerColor)
                    .frame(width: metrics.markerWidth, alignment: .center)
            }
            .padding(.vertical, 1)
            .frame(maxHeight: .infinity, alignment: .top)
            // Opaque, so the code scrolling under it does not show through.
            .background { ZStack { Color(uiColor: .systemBackground); background } }
            .overlay(alignment: .leading) {
                // A commented line keeps its diff color; the bar says it has a comment.
                if selected || commented {
                    Rectangle().fill(Theme.tint).frame(width: 3)
                }
            }
            .modifier(PinnedToViewport(scroll: scroll, active: !wrap))
            .zIndex(1)
            Text(styled)
                .font(metrics.codeSwiftUIFont)
                .lineLimit(wrap ? nil : 1)
                .fixedSize(horizontal: !wrap, vertical: true)
                .frame(maxWidth: wrap ? .infinity : nil, alignment: .leading)
                .padding(.trailing, 12)
                .padding(.vertical, 1)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: width, alignment: .leading)
        .background(background)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private func number(_ value: Int?) -> some View {
        Text(verbatim: value.map { String($0) } ?? "")
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .frame(width: metrics.numberWidth, alignment: .trailing)
            .padding(.trailing, 2)
            .background(gutter)
    }

    private var marker: String {
        switch line.kind {
        case .added: return "+"
        case .removed: return "\u{2212}"
        case .context: return " "
        }
    }

    private var markerColor: Color {
        switch line.kind {
        case .added: return DiffColors.addedText
        case .removed: return DiffColors.removedText
        case .context: return .secondary
        }
    }

    /// The line's diff color, with the selection laid over it: a selected run
    /// still shows which lines go and which come.
    private var background: some View {
        ZStack {
            kindColor
            if selected { Theme.tint.opacity(0.2) }
        }
    }

    private var kindColor: Color {
        switch line.kind {
        case .added: return DiffColors.addedBackground
        case .removed: return DiffColors.removedBackground
        case .context: return .clear
        }
    }

    private var gutter: Color {
        switch line.kind {
        case .added: return DiffColors.addedGutter
        case .removed: return DiffColors.removedGutter
        case .context: return .clear
        }
    }

    private var accessibilityText: String {
        let kind: String
        switch line.kind {
        case .added: kind = "Added"
        case .removed: kind = "Removed"
        case .context: kind = "Unchanged"
        }
        // What is drawn (a cut line says it is cut), not 50,000 characters to read out.
        let shown = DiffRender.isCut(line.text) ? String(styled.characters) : line.text
        return "\(kind) line \(line.displayNumber): \(shown)\(selected ? ", selected" : "")"
    }
}

struct DiffFoldRow: View {
    let count: Int
    let metrics: DiffMetrics
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.up.and.down")
                    .font(.caption2.weight(.semibold))
                Text(count == 1 ? "Show 1 unchanged line" : "Show \(count) unchanged lines")
                    .font(.caption.weight(.medium))
                Spacer()
            }
            .foregroundStyle(Theme.workingText)
            .padding(.leading, metrics.numberWidth)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(DiffColors.foldBackground)
        }
        .buttonStyle(.plain)
    }
}

/// A comment in the review, under the lines it is on.
struct DiffCommentCard: View {
    let comment: DiffReviewComment
    /// Its lines read differently now (the file changed since): the card says so.
    let stale: Bool
    let edit: () -> Void
    let remove: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "text.bubble.fill")
                .foregroundStyle(Theme.tint)
                .font(.footnote)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(comment.loc.split(separator: ":").last.map(String.init) ?? comment.loc)
                    .font(.caption2.weight(.semibold).monospaced())
                    .foregroundStyle(.secondary)
                Text(comment.comment)
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if stale {
                    Label("These lines changed since you commented. The comment quotes them as they were.",
                          systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(Theme.reviewText)
                        .accessibilityIdentifier("diff.commentCard.stale")
                }
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: edit)
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove comment")
            .accessibilityIdentifier("diff.comment.remove")
        }
        .padding(10)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.tint.opacity(0.35), lineWidth: 1))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("diff.commentCard")
    }
}
