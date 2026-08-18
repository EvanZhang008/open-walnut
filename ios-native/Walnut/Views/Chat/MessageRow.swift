import SwiftUI

/// Decoded bubble thumbnails, keyed by the IMAGE BYTES rather than by message
/// id: the optimistic `local-…` bubble is replaced by the canonical server row a
/// moment after a send, and an id-keyed entry would be missed on that swap, so
/// the thumbnail re-decoded (a visible flicker) on every history refresh.
@MainActor
private final class BubbleThumbCache {
    static let shared = BubbleThumbCache()

    private let images = NSCache<NSString, UIImage>()

    private init() {
        images.totalCostLimit = 32 * 1024 * 1024
    }

    static func key(for data: Data) -> NSString {
        "\(data.count):\(data.hashValue)" as NSString
    }

    func cached(_ data: Data) -> UIImage? {
        images.object(forKey: Self.key(for: data))
    }

    func store(_ image: UIImage, for data: Data) {
        let cost = Int(image.size.width * image.scale * image.size.height * image.scale * 4)
        images.setObject(image, forKey: Self.key(for: data), cost: cost)
    }
}

/// One attached-image thumbnail. The JPEG decode is a ~10-30ms ImageIO call per
/// image; running it inside `body` (as this used to) put it on the MainActor
/// during layout, so a bubble with several photos stalled the first frame of the
/// chat list. Decoding happens in a detached task and the row shows a
/// placeholder until it lands. A cache hit still renders synchronously, so a
/// scroll back over an already-decoded image never flashes the placeholder.
private struct BubbleThumb: View {
    let data: Data

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image = image ?? BubbleThumbCache.shared.cached(data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 200, maxHeight: 200)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color(.tertiarySystemFill))
                    .frame(width: 120, height: 120)
            }
        }
        .task(id: BubbleThumbCache.key(for: data)) {
            if BubbleThumbCache.shared.cached(data) != nil { return }
            let decoded = await Task.detached(priority: .userInitiated) {
                SelectedImage.thumbnail(from: data)
            }.value
            guard let decoded, !Task.isCancelled else { return }
            BubbleThumbCache.shared.store(decoded, for: data)
            image = decoded
        }
    }
}

/// One chat entry — user bubble (right, walnut tint), assistant rich markdown
/// (left), a system-notification card, or a small grey chip for tool/thinking
/// history rows. Failed sends render as a red-outlined bubble with a retry
/// affordance (`onRetry` / `onDiscard` supplied by the owning view).
struct MessageRow: View {
    let message: ChatMessage
    var onRetry: (() -> Void)? = nil
    var onDiscard: (() -> Void)? = nil
    /// Live row only: the store dropped the head of liveText to stay under its
    /// retention cap, so the "earlier output hidden" chip must show even when
    /// the RETAINED text alone wouldn't cross the render window's threshold.
    var liveTextTruncated: Bool = false

    var body: some View {
        switch message.kind {
        case .tool:
            ToolChip(name: message.text, detail: message.detail,
                     resultPreview: message.resultPreview, agent: message.agent)
        case .thinking:
            chip(icon: "sparkles", text: message.text)
        case .notification:
            NotificationCard(message: message)
        case nil:
            if message.isUser {
                userBubble
            } else {
                assistantText
            }
        }
    }

    /// Server-augmented image send, as it comes back in the TRANSCRIPT. Two
    /// wire formats (keep in sync with their emitters):
    ///  - "[Images attached — use the Read tool to view them]\n- /path.png\n\n<text>"
    ///    (src/web/routes/session-chat.ts + session-stream-v1.ts)
    ///  - "The user attached N images. Read these files for visual context:\n/path.png\n\n<text>"
    ///    (src/web/routes/images.ts buildSessionImageContext — older sends)
    /// Rendered raw these were machine-y text bubbles and NO image ever
    /// mounted — the whole reason historical image sends looked blank on the
    /// phone. Parse the path list into remote image views (they ride
    /// /api/v1/media with the session scope) + the human's own text.
    /// Non-image sends (nil here) render unchanged.
    private var imageSendParts: (paths: [String], text: String)? {
        Self.imageSendParts(message.text)
    }

    /// Pure parse of the two wire formats above. `internal` (not private) so
    /// WalnutTests can exercise the real logic instead of a copied replica.
    static func imageSendParts(_ text: String) -> (paths: [String], text: String)? {
        let dashed = text.hasPrefix("[Images attached")
        let bare = text.hasPrefix("The user attached")
            && text.contains("for visual context:")
        guard dashed || bare else { return nil }
        let lines = text.components(separatedBy: "\n")
        var paths: [String] = []
        var bodyStart = lines.count
        for (i, line) in lines.enumerated() where i > 0 {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let candidate = trimmed.hasPrefix("- ") ? String(trimmed.dropFirst(2)) : trimmed
            if candidate.hasPrefix("/"), MarkdownParser.isImagePath(candidate) {
                paths.append(candidate)
                continue
            }
            if trimmed.isEmpty { bodyStart = i + 1; break }
            // Unexpected line inside the header — not the known format; bail.
            return nil
        }
        guard !paths.isEmpty else { return nil }
        let body = lines[min(bodyStart, lines.count)...].joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (paths, body)
    }

    /// Render cap for a user bubble (audit MAIN-10): the optimistic bubble
    /// carries the FULL sent text (retry needs it — never clip the model),
    /// and canonical chat-tab user rows are unclipped server-side too. A
    /// single SwiftUI Text is one CoreText layout of the whole string, so a
    /// 100K+ paste stalls the page per pass. Mirrors the session transcript's
    /// own 4K+"…" clip; the full text stays a Copy away (context menu copies
    /// `message.text`, not the display string).
    static func clipBubbleText(_ text: String) -> String {
        text.count > 4_000 ? String(text.prefix(4_000)) + "…" : text
    }

    /// Soft-tint bubble with primary text (Claude-app style) — the old
    /// saturated brown block read as a wall of color on long messages and
    /// crushed CJK legibility in dark mode.
    private var userBubble: some View {
        let failed = message.failed == true
        let imageSend = imageSendParts
        let displayText = Self.clipBubbleText(imageSend?.text ?? message.text)
        return VStack(alignment: .trailing, spacing: 4) {
            if let images = message.localImages, !images.isEmpty {
                attachedImages(images, dimmed: message.pending == true)
            }
            if let imageSend {
                remoteImages(imageSend.paths)
            }
            if !displayText.isEmpty {
                HStack {
                    Spacer(minLength: 48)
                    Text(displayText)
                        .font(.body)
                        .lineSpacing(3)
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            failed ? Theme.danger.opacity(0.08) : Theme.tintSoft,
                            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
                        )
                        .overlay {
                            if failed {
                                RoundedRectangle(cornerRadius: 20, style: .continuous)
                                    .strokeBorder(Theme.danger.opacity(0.5), lineWidth: 1)
                            }
                        }
                        .opacity(message.pending == true ? 0.65 : 1)
                        .textSelection(.enabled)
                        .contextMenu {
                            if failed {
                                if let onRetry {
                                    Button { onRetry() } label: { Label("Retry", systemImage: "arrow.clockwise") }
                                }
                                Button { UIPasteboard.general.string = message.text } label: {
                                    Label("Copy", systemImage: "doc.on.doc")
                                }
                                if let onDiscard {
                                    Button(role: .destructive) { onDiscard() } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                            } else {
                                Button { UIPasteboard.general.string = message.text } label: {
                                    Label("Copy", systemImage: "doc.on.doc")
                                }
                            }
                        }
                }
            }
            if failed {
                Button {
                    onRetry?()
                } label: {
                    // An automatic retry still pending reads as amber + spinner
                    // ("Waiting for Mac… retrying"); only a spent retry budget
                    // shows the terminal red "Not sent". Tappable either way.
                    if let notice = message.retryNotice {
                        HStack(spacing: 4) {
                            ProgressView().controlSize(.mini)
                            Text(notice).font(.caption)
                        }
                        .foregroundStyle(Theme.warning)
                    } else {
                        Label("Not sent — tap to retry", systemImage: "exclamationmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.danger)
                    }
                }
                .accessibilityIdentifier("chat.retryFailed")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 2)
    }

    /// Thumbnails for images attached to a sent user message (local to this app
    /// session — historical messages carry none). Right-aligned above the text,
    /// each rounded and capped at ~200pt so a tall photo can't dominate.
    private func attachedImages(_ datas: [Data], dimmed: Bool) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Spacer(minLength: 48)
            ForEach(Array(datas.enumerated()), id: \.offset) { _, data in
                BubbleThumb(data: data)
            }
        }
        .opacity(dimmed ? 0.65 : 1)
    }

    /// Thumbnails for a HISTORICAL image send (paths parsed off the server's
    /// "[Images attached …]" transcript prefix). Fetched through the same
    /// AttachmentImageView pipeline as inline assistant images — /api/v1/media
    /// with the current MediaContext session, so they resolve on the primary,
    /// over the daemon channel, or across the cloud bridge alike. Capped like
    /// attachedImages so a tall screenshot can't dominate the timeline.
    private func remoteImages(_ paths: [String]) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Spacer(minLength: 48)
            ForEach(paths, id: \.self) { path in
                AttachmentImageView(raw: path, alt: (path as NSString).lastPathComponent)
                    .frame(maxWidth: 200, maxHeight: 200)
            }
        }
    }

    /// Assistant replies render as full block markdown (headings, lists, code,
    /// tables) via the same parser the Notes reader uses — not inline-only.
    /// The streaming row (id "__live__") takes the windowed body — the only
    /// unbounded text in the app must not re-parse wholesale per delta flush.
    private var assistantText: some View {
        HStack {
            if message.id == "__live__" {
                LiveMarkdownBody(text: message.text, storeTruncated: liveTextTruncated)
            } else {
                ChatMarkdownBody(text: message.text)
                    .equatable()
            }
            Spacer(minLength: 32)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 2)
    }

    private func chip(icon: String, text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.caption2)
            Text(text)
                .font(.caption)
                .lineLimit(1)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Color(.tertiarySystemFill), in: Capsule())
        .padding(.horizontal, 16)
        .padding(.vertical, 1)
    }
}

/// Claude-app style tool row: "🔧 Bash — ls docs/" collapsed; when the server
/// sent a result preview, tapping expands a monospace output card. Rows
/// without detail render exactly like the old plain chip.
struct ToolChip: View {
    let name: String
    let detail: String?
    let resultPreview: String?
    /// Subagent name for Task/Agent delegation rows (additive) — rendered as a
    /// tinted leading badge so delegated work is visually distinct from plain
    /// tool calls.
    var agent: String? = nil

    @State private var expanded = false

    private var isExpandable: Bool { resultPreview?.isEmpty == false }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                if let agent, !agent.isEmpty {
                    HStack(spacing: 3) {
                        Image(systemName: "person.2.fill")
                            .font(.system(size: 8, weight: .semibold))
                        Text(agent)
                            .font(.caption2.weight(.semibold))
                            .lineLimit(1)
                    }
                    .foregroundStyle(.indigo)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.indigo.opacity(0.14), in: Capsule())
                    .accessibilityIdentifier("tool.agentBadge")
                }
                Image(systemName: agent == nil ? "wrench.and.screwdriver" : "arrow.triangle.branch")
                    .font(.caption2)
                Text(name)
                    .font(.caption.weight(.medium))
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if isExpandable {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Color(.tertiarySystemFill), in: Capsule())
            .contentShape(Capsule())
            .onTapGesture {
                guard isExpandable else { return }
                withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
            }

            if expanded, let resultPreview {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(resultPreview)
                        .font(.system(.caption2, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(10)
                }
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 1)
    }
}

/// Block-level markdown body for chat. Short plain texts skip the parser and
/// render as a single inline-markdown Text (cheaper for the common case).
///
/// `Equatable` (its only input is `text`) so callers can wrap it in
/// `.equatable()`: while the live turn streams, the chat list re-evaluates
/// every visible row's body ~8x/second, but a stable history row's text never
/// changes — EquatableView lets SwiftUI skip re-rendering (and re-parsing) that
/// whole markdown subtree, leaving only the one changing `__live__` row to
/// re-render. Without this the per-tick re-render storm froze the main thread
/// on long threads and tripped the 0x8BADF00D watchdog kill.
struct ChatMarkdownBody: View, Equatable {
    let text: String
    /// Cache routing (see MarkdownParser.CacheMode). History rows use the
    /// shared cache; the STREAMING tail (unique bytes every tick) must skip it
    /// or its one-shot entries evict the visible page (scroll-freeze thrash).
    var cache: MarkdownParser.CacheMode = .shared
    /// History rows clip oversized (>16K chars) legacy text defensively; live
    /// window segments pass false — LiveMarkdownWindow already bounds them and
    /// a clip would drop mid-reply content. Both params are CONSTANT per call
    /// site, so the text-only == below stays a correct Equatable.
    var clipOversized: Bool = true

    static func == (lhs: ChatMarkdownBody, rhs: ChatMarkdownBody) -> Bool {
        lhs.text == rhs.text
    }

    var body: some View {
        if Self.isBlockMarkdown(text) || Self.containsImageRef(text) {
            MarkdownView(blocks: MarkdownParser.parse(text, cache: cache, clipOversized: clipOversized))
        } else {
            Text(inline: text)
                .textSelection(.enabled)
        }
    }

    /// Heuristic: does this text carry block-level constructs worth the parser?
    static func isBlockMarkdown(_ text: String) -> Bool {
        guard text.contains("\n") else { return false }
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let t = line.drop(while: { $0 == " " })
            if t.hasPrefix("#") || t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("> ")
                || t.hasPrefix("```") || t.hasPrefix("|") || t.hasPrefix("1. ") {
                return true
            }
        }
        return false
    }

    /// Cheap pre-filter: images must reach the block parser even in otherwise
    /// plain text (single-line "here: /tmp/x/shot.png" or "![](…)"), or they
    /// render as dead text. Extension check keeps ordinary paths cheap.
    static func containsImageRef(_ text: String) -> Bool {
        guard text.contains("![") || text.contains("/") else { return false }
        if text.contains("![") { return true }
        let lower = text.lowercased()
        for ext in [".png", ".jpg", ".jpeg", ".gif", ".webp"] {
            if lower.contains(ext) { return true }
        }
        return false
    }
}

/// Markdown body for the LIVE (streaming) turn row — the one text in the app
/// with no upper bound (transcript rows are server-clipped at 4KB).
///
/// Rendering the whole in-flight reply through ChatMarkdownBody re-parsed and
/// re-laid-out ALL of it on every ~8Hz delta flush (the parse cache can't hit:
/// each flush is a brand-new string). On long research turns that made each
/// tick cost O(reply) on the main thread; past ~1-2MB of markdown the stall
/// crossed the 5s watchdog line and iOS killed the app (0x8BADF00D, SwiftUI/
/// AttributeGraph stacks — reproduced deterministically in the simulator).
///
/// LiveMarkdownWindow splits the newest window of the text into a STABLE head
/// (byte-identical across many ticks → EquatableView + parse cache skip it)
/// and a small tail — so a tick re-parses only the tail, O(2-10KB) instead of
/// O(reply). Older output beyond the window collapses into a chip; the full
/// text lands in history at turn-end via the transcript refetch.
struct LiveMarkdownBody: View {
    let text: String
    /// True when the store itself dropped older liveText (retention cap) —
    /// the chip must stay on even if the retained text is under windowMax.
    var storeTruncated: Bool = false

    var body: some View {
        let seg = LiveMarkdownWindow.segments(text)
        VStack(alignment: .leading, spacing: 6) {
            if seg.omittedPrefix || storeTruncated {
                HStack(spacing: 5) {
                    Image(systemName: "ellipsis")
                        .font(.caption2)
                    Text("Earlier output hidden while streaming")
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Color(.tertiarySystemFill), in: Capsule())
            }
            // Live segments never clip: the window bounds them already, and a
            // 16K clip inside the head would silently drop mid-reply content.
            if !seg.head.isEmpty {
                // Head is byte-stable across many ticks → shared cache HITS.
                ChatMarkdownBody(text: seg.head, cache: .shared, clipOversized: false)
                    .equatable()
            }
            if !seg.tail.isEmpty {
                // Tail is a fresh unique string every tick — caching it would
                // evict the visible history page (scroll-freeze mechanism).
                ChatMarkdownBody(text: seg.tail, cache: .skip, clipOversized: false)
                    .equatable()
            }
        }
    }
}

/// System-generated notification (session error, cron result, …) rendered as a
/// distinct card — colored left bar + badge header + markdown body — mirroring
/// the web console's notification styling instead of dumping raw text.
struct NotificationCard: View {
    let message: ChatMessage
    @State private var expanded = false

    /// Body longer than this starts collapsed (like the console's auto-collapse).
    private static let collapseThreshold = 280

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            RoundedRectangle(cornerRadius: 2)
                .fill(accent)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 6) {
                header
                bodyText
            }
            .padding(.leading, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(accent.opacity(0.25), lineWidth: 0.5)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 3)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: iconName)
                .font(.caption2.weight(.semibold))
            Text(badgeLabel)
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
            Spacer(minLength: 0)
            if isCollapsible {
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.caption2)
            }
        }
        .foregroundStyle(accent)
        .contentShape(Rectangle())
        .onTapGesture {
            guard isCollapsible else { return }
            withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
        }
    }

    @ViewBuilder
    private var bodyText: some View {
        if isCollapsible && !expanded {
            Text(inline: Self.firstMeaningfulLine(displayText))
                .font(.subheadline)
                .lineLimit(2)
                .foregroundStyle(.secondary)
        } else {
            ChatMarkdownBody(text: displayText)
                .equatable()
                .font(.subheadline)
        }
    }

    private var isCollapsible: Bool { message.text.count > Self.collapseThreshold }

    /// Strip the leading "**Session Error** (…):" boilerplate — the badge
    /// already says what this is; the body should start with the substance.
    private var displayText: String {
        var text = message.text
        for prefix in ["**Session Error**", "**Session Result**", "**Session Delivery Failed**",
                       "**Subagent Error**", "**Subagent Result**", "**Agent Error**", "**Cron**"] {
            if text.hasPrefix(prefix) {
                text = String(text.dropFirst(prefix.count))
                // Drop the "(Task Label)" + ":" connective after the bold tag.
                if let colon = text.firstIndex(of: ":"), text.distance(from: text.startIndex, to: colon) < 120 {
                    let head = text[text.startIndex..<colon].trimmingCharacters(in: .whitespaces)
                    let rest = String(text[text.index(after: colon)...]).trimmingCharacters(in: .whitespacesAndNewlines)
                    if head.isEmpty { return rest }
                    if head.hasPrefix("("), head.hasSuffix(")") {
                        let label = String(head.dropFirst().dropLast())
                        return rest.isEmpty ? label : "\(label) — \(rest)"
                    }
                }
                return text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return text
    }

    static func firstMeaningfulLine(_ text: String) -> String {
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty && t != "---" { return t }
        }
        return text
    }

    private var isError: Bool {
        message.source == "session-error" || message.source == "agent-error"
            || message.text.contains("**Session Error**") || message.text.contains("**Subagent Error**")
    }

    private var accent: Color { isError ? Theme.danger : Theme.tint }

    private var iconName: String {
        switch message.source {
        case "session-error", "agent-error": return "exclamationmark.triangle.fill"
        case "cron": return "clock.badge.checkmark"
        case "compaction": return "arrow.down.right.and.arrow.up.left"
        case "session": return "checkmark.seal"
        case "interrupt": return "stop.circle"
        default: return isError ? "exclamationmark.triangle.fill" : "bell"
        }
    }

    private var badgeLabel: String {
        switch message.source {
        case "session-error": return "Session error"
        case "agent-error": return "Agent error"
        case "cron": return "Scheduled"
        case "compaction": return "Compacted"
        case "session": return "Session result"
        case "subagent": return "Subagent"
        case "interrupt": return "Interrupted"
        default: return "Notification"
        }
    }
}

extension Text {
    /// Render text as inline-styled markdown; fall back to plain text
    /// (AttributedString throws on some malformed markdown). Bare http(s)
    /// URLs become tappable links here too — short plain messages take this
    /// fast path and never reach the block parser's linkifier.
    init(inline: String) {
        if var attributed = try? AttributedString(
            markdown: inline,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            MarkdownParser.linkifyBareURLs(&attributed)
            self.init(attributed)
        } else {
            self.init(verbatim: inline)
        }
    }
}
