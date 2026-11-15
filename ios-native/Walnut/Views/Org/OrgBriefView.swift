import SwiftUI

/// An Org node's Brief on the phone: its letter to the user in three sections (Needs you, Working,
/// Waiting / snoozed), under a line saying when it was written and what moved since, as the web's
/// Brief view (`web/src/components/org/OrgBrief.tsx`). Task pills open their session.
///
/// A path in it opens on the machine of whoever wrote the words it sits in (`text_sources`), never on
/// the node's current session: another session, the user, or a task whose ask Walnut added may have
/// written them. A letter whose writers are not one recorded source tags its paths unknown (the viewer's machine picker).
struct OrgBriefView: View {
    let taskId: String
    let name: String

    @State private var reply: OrgBriefReply?
    /// The node `reply` was read for: the view's state outlives a switch to another node.
    @State private var replyFor: String?
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(Theme.needsText)
                }
                if !loaded || (replyFor != taskId && error == nil) {
                    ProgressView("Loading the brief…")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                } else if replyFor == taskId, let letter = reply?.brief {
                    head(letter: letter, fresh: reply?.fresh)
                    MarkdownView(blocks: Self.taggedBlocks(letter), readsSourceTags: true)
                        .accessibilityIdentifier("org.brief.text")
                } else if error == nil {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No brief yet").font(.headline)
                        Text("\(name) writes one when its next turn ends.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 24)
                    .accessibilityIdentifier("org.brief.empty")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .refreshable { await load() }
        .task(id: taskId) { await load() }
        .accessibilityIdentifier("org.brief")
    }

    private func head(letter: OrgBriefReply.Letter, fresh: OrgBriefReply.Fresh?) -> some View {
        TimelineView(.periodic(from: .now, by: 60)) { ctx in
            let now = ctx.date.addingTimeInterval(AppClock.demoOffset)
            let written = WalnutTask.parseISO(letter.at).map { "Written \(RelativeTime.short(date: $0, relativeTo: now))" } ?? "Written"
            let moved = (fresh?.words ?? "").trimmingCharacters(in: .whitespaces)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: fresh?.stale == true ? "clock.badge.exclamationmark" : "clock")
                    .foregroundStyle(fresh?.stale == true ? Theme.warning : .secondary)
                Text(moved.isEmpty ? written : "\(written) · \(moved)")
                    .foregroundStyle(.secondary)
            }
            .font(.footnote)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("org.brief.head")
        }
    }

    /// Two task pills side by side ("<task> <its VP>：…") read as one title in the same colour:
    /// a dot goes between them.
    static func separatingRefs(_ text: String) -> String {
        text.replacingOccurrences(
            of: #"(<task-ref\b[^>]*/>)[ \t]+(?=<task-ref\b)"#, with: "$1 · ", options: .regularExpression)
    }

    /// The letter's blocks as a letter renders them (no remote picture, no local one either), each file link tagged with
    /// the source of its writers in the stored text, so agent markup cannot name a machine.
    static func taggedBlocks(_ letter: OrgBriefReply.Letter) -> [MarkdownBlock] {
        let blocks = LetterMarkdownBody.blocks(for: separatingRefs(letter.text))
        let tag = { (s: AttributedString) in tagLinks(s, text: letter.text, sources: letter.textSources) }
        return blocks.map { block in
            let kind: MarkdownBlock.Kind
            switch block.kind {
            // Drawn as written; its links take the whole letter's agreed writer, as every other link here.
            case .code: return MarkdownBlock(id: block.id, kind: block.kind,
                                             codeSource: letterSource(text: letter.text, sources: letter.textSources))
            case .heading(let level, let text): kind = .heading(level: level, text: tag(text))
            case .paragraph(let text): kind = .paragraph(tag(text))
            case .listItem(let indent, let marker, let text): kind = .listItem(indent: indent, marker: marker, text: tag(text))
            case .taskItem(let indent, let checked, let text, let line): kind = .taskItem(indent: indent, checked: checked, text: tag(text), sourceLine: line)
            case .quote(let lines): kind = .quote(lines: lines.map(tag))
            case .table(let header, let rows): kind = .table(header: header.map(tag), rows: rows.map { $0.map(tag) })
            // A picture would load from a machine guessed before its writer is read: its path as a link instead.
            case .image(let raw, _): kind = .paragraph(tag(MarkdownParser.inline(raw)))
            default: kind = block.kind
            }
            return MarkdownBlock(id: block.id, kind: kind)
        }
    }

    static func tagLinks(_ s: AttributedString, text: String, sources: [OrgBriefReply.Letter.Source]?) -> AttributedString {
        var out = s
        for run in s.runs {
            guard let url = run.link, let ref = FilePreviewLink.reference(from: url) else { continue }
            let one = FilePreviewLink.tagging(AttributedString(s[run.range]), source: pathSource(ref, text: text, sources: sources))
            if let tagged = one.runs.first?.link { out[run.range].link = tagged }
        }
        return out
    }

    /// The one source every writer of the whole letter shares, else unknown. The phone has no trusted
    /// block offsets, so a visible literal copy of a path must not stand in for an encoded link.
    static func pathSource(_ ref: FilePathRef, text: String, sources: [OrgBriefReply.Letter.Source]?) -> LinkSource {
        letterSource(text: text, sources: sources)
    }

    static func letterSource(text: String, sources: [OrgBriefReply.Letter.Source]?) -> LinkSource {
        let length = (text as NSString).length
        guard let spans = sources, !spans.isEmpty, coversExactly(spans, length: length) else { return .unknown }
        return LinkSource.agreed(spans.map { LinkSource.writer(by: $0.by, sessionId: $0.sessionId) })
    }

    /// Spans that are not one exact cover of the text (an older or hand-edited record) name no one.
    static func coversExactly(_ spans: [OrgBriefReply.Letter.Source], length: Int) -> Bool {
        var at = 0
        for span in spans {
            guard span.start == at, span.end > at, span.end <= length else { return false }
            guard span.by == "human" || span.by == "agent" || span.by.hasPrefix("task:") else { return false }
            at = span.end
        }
        return at == length
    }

    private func load() async {
        // A reply for the node shown before must not fill this one's Brief (.task(id:) cancels it).
        let asked = taskId
        do {
            let fetched = try await WalnutAPI().orgBrief(taskId: asked)
            guard !Task.isCancelled else { return }
            reply = fetched
            replyFor = asked
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            if let api = error as? APIError, api.isCancelled { return }
            self.error = reply == nil ? "Couldn't load the brief. Pull to try again." : "Couldn't refresh the brief."
        }
        loaded = true
    }
}
