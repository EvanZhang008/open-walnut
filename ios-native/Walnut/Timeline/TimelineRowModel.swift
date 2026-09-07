import UIKit

/// Which conversation a row belongs to, folded into every row id.
///
/// WHY THIS EXISTS (field bug): `/api/v1/conversations/:id/messages` numbers a
/// conversation's messages POSITIONALLY — "m0", "m1", … — so two different
/// conversations of the same length hand the builder byte-identical message
/// ids. Row ids were "<messageID>#<block>", so P's rows and Q's rows were
/// identical strings; the diff found a full common prefix, reported no changes,
/// and the controller's `if diff.isEmpty { return }` fast path bailed BEFORE
/// swapping its data source. The previous conversation stayed on screen under
/// the new one's title until the app was relaunched.
///
/// Scoping the id makes a conversation switch a full delete+insert, which is
/// what it always was semantically. It also un-collides three other things that
/// were keyed on the row id and shared one host across conversations: the
/// expanded-row set, the rich-document height cache's per-row fallback, and the
/// unpinned reader's viewport anchor.
enum TimelineScope {
    /// Scope/message-id separator. `sanitize` guarantees a scope never contains
    /// one, so the message id is always recoverable by cutting at the FIRST.
    static let separator: Character = "|"
    /// Stable token for "no conversation yet" (New chat / draft). A sentinel
    /// rather than "unscoped": a draft's own rows must still diff against
    /// themselves while the user types.
    static let draft = "draft"
    /// Direct builder use (unit tests, the DEBUG harness) — ids come out
    /// exactly as they did before scoping existed.
    static let unscoped = ""

    static func sanitize(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return draft }
        guard raw.contains(separator) else { return raw }
        return raw.replacingOccurrences(of: String(separator), with: "_")
    }

    /// The id namespace one message's rows live in: "<scope>|<messageID>",
    /// or the bare message id when unscoped.
    static func namespace(_ scope: String, _ messageID: String) -> String {
        scope.isEmpty ? messageID : "\(scope)\(separator)\(messageID)"
    }

    /// Drop the leading scope from a row id (no-op on an unscoped id).
    static func stripScope(_ rowID: String) -> String {
        guard let cut = rowID.firstIndex(of: separator) else { return rowID }
        return String(rowID[rowID.index(after: cut)...])
    }
}

/// Immutable, pre-laid-out row of the chat timeline. Produced on the
/// background TimelineLayoutActor (parse + attribution + height measurement
/// all happen there); the main thread only ever ATTACHES these to cells —
/// O(1) per visible cell, by construction.
///
/// One ChatMessage maps to 1..n rows: an assistant markdown reply splits into
/// block groups (text run / code / image / table) so each heavy construct gets
/// a purpose-built cell and an exact height.
struct TimelineRow {
    /// Stable identity across rebuilds: "<scope>|<message stable id>#<block
    /// index>" (see `TimelineScope`; store ids are content-derived, so an
    /// unchanged message diffs to a no-op). Live rows use fixed message ids
    /// ("live-head", "live-tail", …) inside the same scope.
    let id: String
    /// Cheap content-change detector for same-id rows (live tail, expanded
    /// tool chips): differing revision ⇒ reload the cell.
    let revision: Int
    let content: TimelineRowContent
    /// Full cell height at the build width, including the row's own vertical
    /// padding. The layout NEVER self-sizes.
    let height: CGFloat
    /// Digest of what this row actually RENDERS, computed once at build time
    /// (never per diff tick) so the diff can catch a row whose id, revision and
    /// height all match but whose content is different text.
    ///
    /// Two situations produce exactly that: an id space shared by two
    /// conversations (see `TimelineScope`) and a server-side transcript re-cut,
    /// after which a positional id points at a different message. Height is a
    /// line-count product, so equal-length text gives an equal height and the
    /// row would never be handed to its cell.
    let contentKey: Int

    /// Same signature the memberwise init had — the key is derived, never
    /// passed, so no construction site can forget it or get it wrong.
    init(id: String, revision: Int, content: TimelineRowContent, height: CGFloat) {
        self.id = id
        self.revision = revision
        self.content = content
        self.height = height
        self.contentKey = content.contentKey
    }

    /// Row ids are "<scope>|<messageID>#<block>"; actions carry the MESSAGE id.
    /// Shared so every action site (bubble context menu, hosted failed-notice
    /// button) strips scope and suffix the same way — a raw row id would never
    /// match a store message and the retry would silently no-op.
    static func messageID(fromRowID id: String) -> String {
        let unscoped = TimelineScope.stripScope(id)
        return unscoped.range(of: "#", options: .backwards)
            .map { String(unscoped[..<$0.lowerBound]) } ?? unscoped
    }
}

enum TimelineRowContent {
    /// Assistant / notification prose: pre-styled attributed text, rendered
    /// by a TextKit cell. `selectable` keeps UITextView selection on.
    case text(NSAttributedString)
    /// Right-aligned user bubble. `width` is the measured text width so the
    /// bubble hugs its content like the SwiftUI original.
    case userBubble(text: NSAttributedString, textSize: CGSize, failed: Bool, pending: Bool)
    /// Undelivered-send row under a failed bubble. `notice` non-nil = an
    /// automatic retry is still pending ("Waiting for Mac… retrying"); nil =
    /// the terminal "Not sent — tap to retry". Either way tapping retries now.
    case failedNotice(notice: String?)
    /// Code fence: monospace, horizontal scroll, no wrapping.
    case code(text: String, contentSize: CGSize)
    /// Inline image (assistant output or historical user image send).
    /// Fixed-height slot; the cell aspect-fits the loaded image.
    case image(raw: String, alt: String)
    /// Local (just-sent) user image thumbnails — JPEG datas from the picker.
    case localImages(datas: [Data], dimmed: Bool)
    /// Markdown table — hosted grid (rare; bounded by maxRenderedTableRows).
    case table(header: [AttributedString], rows: [[AttributedString]])
    /// Tool call chip; expanding shows `resultPreview` (heights for BOTH
    /// states are pre-measured — toggling swaps `height`, never re-measures).
    case toolChip(name: String, detail: String?, resultPreview: String?,
                  agent: String?, expanded: Bool)
    /// Small grey capsule (thinking history rows).
    case chip(icon: String, text: String)
    /// Notification card (session error / cron / …). Collapse mirrors the
    /// SwiftUI card; both heights pre-measured.
    case notification(badge: String, icon: String, isError: Bool,
                      body: NSAttributedString, collapsedLine: String,
                      collapsible: Bool, expanded: Bool)
    /// Raw-HTML run from a rich reply, rendered as ONE self-contained web
    /// document. Nothing is stripped from the markup: the document runs with
    /// scripting off under a no-network CSP, so a `<script>` in it is inert —
    /// markup that WANTS to run arrives as `.richIsland` instead. `key` is the
    /// content digest the measured height is banked under; `streaming` marks a
    /// still-growing tail so the cell throttles its reloads.
    case richHTML(html: String, key: String, streaming: Bool)
    /// ```html-app island: its own sandboxed document, scripts allowed.
    /// `complete == false` renders a placeholder — mounting a half-written
    /// island would run half a script (same rule as the web console).
    case richIsland(html: String, key: String, complete: Bool)
    /// "Earlier output hidden while streaming" chip on the live row.
    case truncationChip
    /// Shimmering activity row while the agent thinks / runs tools.
    case activity(String?)
    /// "Load earlier messages" button (Personal AI chat only).
    case loadEarlier
}

extension TimelineRowContent {
    /// Cell-reuse bucket.
    var reuseKind: String {
        switch self {
        case .text: return "text"
        case .userBubble: return "bubble"
        case .failedNotice: return "failedNotice"
        case .code: return "code"
        case .image: return "image"
        case .localImages: return "localImages"
        case .table: return "table"
        case .toolChip: return "toolChip"
        case .chip: return "chip"
        case .notification: return "notification"
        case .richHTML: return "richHTML"
        case .richIsland: return "richIsland"
        case .truncationChip: return "truncationChip"
        case .activity: return "activity"
        case .loadEarlier: return "loadEarlier"
        }
    }

    /// Digest of everything this row DRAWS (see `TimelineRow.contentKey`).
    ///
    /// Computed once per built row, on the layout actor — a memoized row carries
    /// its key along in the struct, so the diff never pays for this. Deliberately
    /// cheap where the payload is unbounded: a rich document hashes its `key`
    /// (already a digest of its markup) and image rows hash byte COUNTS, never
    /// bytes. Attributed text hashes its plain string: styling is derived from
    /// that text, so an attributes-only change with identical characters and an
    /// identical height cannot exist.
    var contentKey: Int {
        var hasher = Hasher()
        hasher.combine(reuseKind)
        switch self {
        case .text(let attributed):
            hasher.combine(attributed.string)
        case .userBubble(let text, _, let failed, let pending):
            hasher.combine(text.string)
            hasher.combine(failed)
            hasher.combine(pending)
        case .failedNotice(let notice):
            hasher.combine(notice)
        case .code(let text, _):
            hasher.combine(text)
        case .image(let raw, let alt):
            hasher.combine(raw)
            hasher.combine(alt)
        case .localImages(let datas, let dimmed):
            hasher.combine(datas.count)
            for data in datas { hasher.combine(data.count) }
            hasher.combine(dimmed)
        case .table(let header, let rows):
            hasher.combine(header)
            hasher.combine(rows)
        case .toolChip(let name, let detail, let resultPreview, let agent, let expanded):
            hasher.combine(name)
            hasher.combine(detail)
            hasher.combine(resultPreview)
            hasher.combine(agent)
            hasher.combine(expanded)
        case .chip(let icon, let text):
            hasher.combine(icon)
            hasher.combine(text)
        case .notification(let badge, let icon, let isError, let body,
                           let collapsedLine, let collapsible, let expanded):
            hasher.combine(badge)
            hasher.combine(icon)
            hasher.combine(isError)
            hasher.combine(body.string)
            hasher.combine(collapsedLine)
            hasher.combine(collapsible)
            hasher.combine(expanded)
        case .richHTML(_, let key, let streaming):
            hasher.combine(key)
            hasher.combine(streaming)
        case .richIsland(_, let key, let complete):
            hasher.combine(key)
            hasher.combine(complete)
        case .truncationChip, .loadEarlier:
            break // constant content
        case .activity(let label):
            hasher.combine(label)
        }
        return hasher.finalize()
    }

    /// Does this row's height come from a WKWebView measurement rather than
    /// from the actor's own arithmetic? The layout actor memoizes rows per
    /// message, and only these rows can have their height revised after the
    /// fact — so only these memo entries need dropping when a measurement
    /// lands (see TimelineLayoutActor's rich invalidation).
    var isRichDocument: Bool {
        switch self {
        case .richHTML, .richIsland: return true
        default: return false
        }
    }
}

/// Everything the layout actor needs to build a full snapshot — a plain value
/// snapshot of the store's observable state, taken on the MainActor in
/// TimelineHost.updateUIViewController and shipped to the actor.
struct TimelineInput {
    var messages: [ChatMessage]
    var streaming: Bool
    var liveText: String
    var liveTextTruncated: Bool
    var activity: String?
    var showLoadEarlier: Bool
    /// Content width the rows must be measured at.
    var width: CGFloat
    /// Row ids whose expandable content is currently open (tool chips,
    /// notification cards) — owned by the controller, echoed through builds.
    var expandedRowIDs: Set<String>
    /// Which conversation these messages belong to (see `TimelineScope`). Every
    /// UI surface passes one; the default is the unscoped id space, for direct
    /// builder/actor use in tests and the DEBUG harness.
    var scope: String = TimelineScope.unscoped
}

/// The actor's output: a complete row array (never a delta — latest wins).
struct TimelineSnapshot {
    let rows: [TimelineRow]
    let width: CGFloat
    /// Monotonic build counter, for latest-wins ordering on the main side.
    let generation: Int
}

/// User actions raised by cells, routed controller → host → store.
enum TimelineRowAction {
    case retry(messageID: String)
    case discard(messageID: String)
    case copyText(String)
    case openURL(URL)
    case tapImage(UIImage)
    /// Open a server-side file in the in-app preview (HTML → WKWebView,
    /// anything else → the text viewer, scrolled to `ref.line`). Raised when a
    /// tapped link is a FilePreviewLink rather than a web URL. Carries the whole
    /// reference, not just the path: the position the writer named is the
    /// difference between opening the file and opening the LINE.
    case previewFile(ref: FilePathRef)
    case toggleExpanded(rowID: String)
    /// A rich cell measured its document: the coordinator banks the height and
    /// rebuilds so the row carries the real number. Handled INSIDE the
    /// coordinator (like `toggleExpanded`) — the page never sees it.
    case richHeight(rowID: String, key: String, width: CGFloat, height: CGFloat)
    case loadEarlier
}
