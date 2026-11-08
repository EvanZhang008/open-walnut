import SwiftUI

/// The two pages the session menu's files sheet opens on.
enum SessionFilesPage {
    case browse
    case changes
}

/// Where the Changed page's stack can go.
enum ChangesRoute: Hashable {
    case file(SessionChangedFile)
    case comparePicker
}

/// The session's Changed page: which files it changed (with "+12 -3"), each
/// file's diff a tap away, line comments gathered into one review and sent to
/// the agent as one message (the same text the web Changed tab sends).
///
/// `sender` is the session's own send: a review goes into the conversation like
/// anything typed in the composer, and waits its turn when one is running.
struct SessionChangesSheet: View {
    let session: WalnutSession
    let sender: ReviewSender

    /// Made once, when the sheet first appears: the conversation under it redraws
    /// often while a turn streams, and that must not read the review off disk again.
    @State private var holder: SessionChangesHolder?

    var body: some View {
        Group {
            if let holder {
                SessionChangesPage(model: holder.model, review: holder.review, sender: sender)
            } else {
                Color.clear
            }
        }
        .onAppear {
            if holder == nil { holder = SessionChangesHolder(sessionId: session.id) }
        }
    }
}

/// The Changed page's data for one visit.
@MainActor
final class SessionChangesHolder {
    let model: SessionChangesModel
    let review: DiffReview

    init(sessionId: String) {
        model = SessionChangesModel(sessionId: sessionId)
        review = DiffReview(sessionId: sessionId)
    }
}

struct SessionChangesPage: View {
    let model: SessionChangesModel
    let review: DiffReview
    let sender: ReviewSender

    @State private var path: [ChangesRoute] = []
    @State private var showReview = false
    /// The review went out: once its sheet is down, the page gives way to the conversation.
    @State private var closeAfterReview = false
    /// A comment the review could not open (its file left the comparison).
    @State private var missing: String?
    @State private var showCompareMenu = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NavigationStack(path: $path) {
            list
                .navigationTitle("Changed")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }.accessibilityIdentifier("changes.done")
                    }
                }
                .navigationDestination(for: ChangesRoute.self) { route in
                    switch route {
                    case .file(let file):
                        SessionFileDiffView(
                            file: file, files: model.files, model: model, review: review,
                            sender: sender, openReview: { showReview = true },
                            open: { next in
                                if case .file = path.last { path[path.count - 1] = .file(next) }
                            },
                            showUncommitted: {
                                path.removeAll()
                                Task { await model.setCompare(.uncommitted) }
                            })
                    case .comparePicker:
                        DiffComparePickerView(model: model) { picked in
                            path.removeAll()
                            Task { await model.setCompare(picked) }
                        }
                    }
                }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !review.comments.isEmpty, path.isEmpty {
                ReviewBar(count: review.comments.count) { showReview = true }
            }
        }
        .sheet(isPresented: $showReview, onDismiss: {
            // Back to the conversation, where the review now is.
            if closeAfterReview { dismiss() }
        }) {
            DiffReviewSheet(review: review, sender: sender, sent: {
                closeAfterReview = true
                showReview = false
            }, show: { comment in
                showReview = false
                Task { await open(comment) }
            })
            // Full height at the largest text sizes: half a screen holds only a line or two.
            .presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.medium, .large])
            .presentationDragIndicator(.visible)
            // Opaque at half height too: the list under it showed through the cards.
            .presentationBackground(Color(uiColor: .systemGroupedBackground))
        }
        .alert("Comment not in this comparison", isPresented: Binding(
            get: { missing != nil }, set: { if !$0 { missing = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(missing ?? "")
        }
        .task { await model.load() }
        // A review held by a bubble that retries: settled as that bubble is.
        .task {
            while !Task.isCancelled {
                review.reconcile(sender.state)
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// The diff a comment was left on, at its lines: its comparison first, then its file.
    private func open(_ comment: DiffReviewComment) async {
        if let compare = comment.compare, compare != model.compare {
            path.removeAll()
            await model.setCompare(compare)
        }
        guard let file = model.files.first(where: { $0.filePath == comment.filePath }) else {
            let label = model.compare.label(defaultRef: model.defaultRef)
            missing = "\(comment.relPath) is not in \u{201C}\(label)\u{201D} now. The comment stays in your review; you can still send it."
            return
        }
        model.focus = (comment.filePath, comment.anchorKey)
        path = [.file(file)]
    }

    @ViewBuilder
    private var list: some View {
        List {
            Section {
                compareMenu
                summary
            }
            if let note = statusNote {
                Section { note }
            }
            if model.list == nil {
                Section { placeholder }
            } else if model.files.isEmpty {
                Section {
                    Text(model.compare == .session ? "This session has not changed any files yet."
                         : "Nothing differs in this comparison.")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("changes.empty")
                }
            } else {
                let groups = model.list?.groups ?? []
                ForEach(groups, id: \.repoRoot) { group in
                    Section {
                        ForEach(group.files) { file in
                            NavigationLink(value: ChangesRoute.file(file)) {
                                ChangedFileRow(file: file, comments: review.count(onFile: file.filePath, compareKey: model.compare.cacheKey))
                            }
                            .accessibilityIdentifier("changes.file.\(file.relPath)")
                        }
                    } header: {
                        if groups.count > 1 { Text(group.label) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await model.load(refresh: true) }
        .accessibilityIdentifier("changes.list")
    }

    private var compareMenu: some View {
        Button {
            showCompareMenu = true
        } label: {
            // At the largest text sizes the comparison goes under its label, whole.
            (typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                                          : AnyLayout(HStackLayout(spacing: 6))) {
                Text("Compare")
                    .foregroundStyle(Theme.secondaryOnCard)
                    .lineLimit(1)
                    .fixedSize()
                if !typeSize.isAccessibilitySize { Spacer(minLength: 8) }
                HStack(spacing: 6) {
                    Text(model.compare.label(defaultRef: model.defaultRef))
                        .foregroundStyle(Theme.tint)
                        .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption)
                        .foregroundStyle(Theme.tint)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("changes.compare")
        .popover(isPresented: $showCompareMenu, arrowEdge: .top) {
            DiffMenu(sections: [
                // A branch or commit picked from the list shows here too, checked, first.
                (quickCompares.contains(model.compare) ? quickCompares : [model.compare] + quickCompares).map { option in
                    DiffMenuItem(id: quickCompares.contains(option) ? "changes.compare.\(option.base)" : "changes.compare.current",
                                 title: option.label(defaultRef: model.defaultRef),
                                 checked: option == model.compare) {
                        Task { await model.setCompare(option) }
                    }
                },
                [DiffMenuItem(id: "changes.compare.other", title: "Another Branch or Commit\u{2026}",
                              systemImage: "arrow.triangle.branch") {
                    path.append(.comparePicker)
                }],
            ])
        }
    }

    private var quickCompares: [DiffCompare] {
        [.session, .uncommitted, .remote, .branch(ref: nil)]
    }

    @ViewBuilder
    private var summary: some View {
        let files = model.files.count
        let totals = model.totals
        // At the largest text sizes the counts go on their own line.
        (typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                                      : AnyLayout(HStackLayout(spacing: 8))) {
            Text(model.list == nil ? "Reading changes\u{2026}" : "\(files) \(files == 1 ? "file" : "files") changed")
                .font(.subheadline.weight(.medium))
            HStack(spacing: 8) {
                if totals.counted {
                    LineCounts(additions: totals.additions, deletions: totals.deletions)
                }
                Spacer()
                if model.loading { ProgressView().controlSize(.small) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("changes.summary")
    }

    private var statusNote: AnyView? {
        if let since = model.offlineCopyFrom, !model.loading {
            return AnyView(
                Label("Offline. This is the copy saved \(RelativeDateTimeFormatter().localizedString(for: since, relativeTo: Date())).",
                      systemImage: "wifi.slash")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("changes.offline"))
        }
        if let error = model.loadError, model.list != nil {
            return AnyView(
                Label("Could not refresh: \(error)", systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.secondary))
        }
        return nil
    }

    @ViewBuilder
    private var placeholder: some View {
        if let error = model.loadError {
            VStack(alignment: .leading, spacing: 10) {
                Text("Could not read the changes").font(.headline)
                Text(error).font(.footnote).foregroundStyle(.secondary)
                Button("Try Again") { Task { await model.load() } }
                    .buttonStyle(.bordered)
            }
            .padding(.vertical, 4)
            .accessibilityIdentifier("changes.error")
        } else {
            HStack {
                Spacer()
                ProgressView()
                Spacer()
            }
            .padding(.vertical, 12)
        }
    }
}

// MARK: - Rows

/// "+12 −3" in the colors a diff uses.
struct LineCounts: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 4) {
            Text(verbatim: "+\(additions)").foregroundStyle(DiffColors.addedText)
            Text(verbatim: "\u{2212}\(deletions)").foregroundStyle(DiffColors.removedText)
        }
        .font(.caption.monospacedDigit().weight(.semibold))
        // A number never breaks across lines.
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(additions) added, \(deletions) removed")
    }
}

struct ChangedFileRow: View {
    let file: SessionChangedFile
    let comments: Int
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            // The largest text sizes: the name gets the width, the counts a line of their own.
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    ChangeStatusMark(status: file.status)
                    name(lines: 3)
                }
                if let subtitle { folder(subtitle, lines: 2) }
                HStack(spacing: 10) { marks }
            }
            .padding(.vertical, 2)
        } else {
            HStack(spacing: 10) {
                ChangeStatusMark(status: file.status)
                VStack(alignment: .leading, spacing: 2) {
                    name(lines: 1)
                    if let subtitle { folder(subtitle, lines: 1) }
                }
                Spacer(minLength: 6)
                marks
            }
            .padding(.vertical, 2)
        }
    }

    private func name(lines: Int) -> some View {
        // On more lines than one it breaks where a name has a seam, never with
        // a hyphen ("Pricing-Table.tsx" reads as another name).
        Text(lines > 1 ? Self.breakable(file.fileName) : file.fileName)
            .font(.body.weight(.medium))
            .lineLimit(lines)
            .truncationMode(.middle)
            .accessibilityLabel(file.fileName)
    }

    /// A file name with a zero-width break before each inner capital and after
    /// each ".", "-" and "_": "PricingTable.tsx" may break as "Pricing" / "Table.tsx".
    static func breakable(_ name: String) -> String {
        var out = ""
        var previous: Character?
        for c in name {
            if let p = previous, c.isUppercase, p.isLowercase { out.append("\u{200B}") }
            out.append(c)
            if c == "." || c == "-" || c == "_" { out.append("\u{200B}") }
            previous = c
        }
        return out
    }

    private func folder(_ text: String, lines: Int) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(lines)
            .truncationMode(.head)
    }

    @ViewBuilder
    private var marks: some View {
        if comments > 0 {
            Label("\(comments)", systemImage: "text.bubble.fill")
                .labelStyle(.titleAndIcon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.tint)
                .fixedSize()
                .accessibilityLabel("\(comments) \(comments == 1 ? "comment" : "comments")")
        }
        if let add = file.additions, let del = file.deletions {
            LineCounts(additions: add, deletions: del)
        }
    }

    private var subtitle: String? {
        if file.status == "renamed", let old = file.oldRelPath { return "from \(old)" }
        return file.directory.isEmpty ? nil : file.directory
    }
}

/// A / M / D / R in a small colored square.
struct ChangeStatusMark: View {
    let status: String

    var body: some View {
        Text(verbatim: letter)
            .font(.caption2.weight(.bold).monospaced())
            .foregroundStyle(color)
            // 20 points square at the default size; past it, always round its letter.
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .frame(minWidth: 20, minHeight: 20)
            .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
            // A mark, not text to read: it stops growing at the first accessibility size.
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            .accessibilityLabel(status)
    }

    private var letter: String {
        switch status {
        case "added": return "A"
        case "deleted": return "D"
        case "renamed": return "R"
        default: return "M"
        }
    }

    private var color: Color {
        switch status {
        case "added": return DiffColors.addedText
        case "deleted": return DiffColors.removedText
        case "renamed": return Theme.workingText
        default: return Theme.reviewText
        }
    }
}

/// The bar under the list while comments wait: how many, and the way to them.
struct ReviewBar: View {
    let count: Int
    let open: () -> Void

    var body: some View {
        // One row when it fits; at large text sizes the button goes under the words.
        ViewThatFits(in: .horizontal) {
            HStack {
                label
                Spacer()
                button
            }
            VStack(alignment: .leading, spacing: 8) {
                label
                HStack {
                    Spacer()
                    button
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    private var label: some View {
        HStack(alignment: .firstTextBaseline) {
            Image(systemName: "text.bubble")
                .foregroundStyle(Theme.tint)
            Text("\(count) \(count == 1 ? "comment" : "comments") in your review")
                .font(.subheadline.weight(.medium))
        }
    }

    private var button: some View {
        Button("Review", action: open)
            .fixedSize()
            .buttonStyle(.borderedProminent)
            .tint(Theme.tint)
            .accessibilityIdentifier("changes.review")
    }
}

/// Diff colors, light and dark.
enum DiffColors {
    /// A color for light mode and one for dark (0xRRGGBB each).
    private static func pair(_ light: Int, _ dark: Int) -> Color {
        func rgb(_ v: Int) -> UIColor {
            UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
                    blue: CGFloat(v & 0xFF) / 255, alpha: 1)
        }
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }

    static let addedText = pair(0x1A7F37, 0x3FB950)
    static let removedText = pair(0xCF222E, 0xF85149)
    static let addedBackground = pair(0xE6FFEC, 0x12261E)
    static let removedBackground = pair(0xFFEBE9, 0x2D1517)
    static let addedGutter = pair(0xCCFFD8, 0x1B4721)
    static let removedGutter = pair(0xFFD7D5, 0x5C1E21)
    static let foldBackground = pair(0xEEF3FA, 0x1B2230)
}
