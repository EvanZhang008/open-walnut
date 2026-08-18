import UIKit

/// Immutable, pre-laid-out row of the chat timeline. Produced on the
/// background TimelineLayoutActor (parse + attribution + height measurement
/// all happen there); the main thread only ever ATTACHES these to cells —
/// O(1) per visible cell, by construction.
///
/// One ChatMessage maps to 1..n rows: an assistant markdown reply splits into
/// block groups (text run / code / image / table) so each heavy construct gets
/// a purpose-built cell and an exact height.
struct TimelineRow {
    /// Stable identity across rebuilds: "<message stable id>#<block index>"
    /// (store ids are content-derived, so an unchanged message diffs to a
    /// no-op). Live rows use fixed ids ("live-head", "live-tail", …).
    let id: String
    /// Cheap content-change detector for same-id rows (live tail, expanded
    /// tool chips): differing revision ⇒ reload the cell.
    let revision: Int
    let content: TimelineRowContent
    /// Full cell height at the build width, including the row's own vertical
    /// padding. The layout NEVER self-sizes.
    let height: CGFloat

    /// Row ids are "<messageID>#<block>"; actions carry the MESSAGE id. Shared
    /// so every action site (bubble context menu, hosted failed-notice button)
    /// strips the suffix the same way — a raw row id would never match a store
    /// message and the retry would silently no-op.
    static func messageID(fromRowID id: String) -> String {
        id.range(of: "#", options: .backwards).map { String(id[..<$0.lowerBound]) } ?? id
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
        case .truncationChip: return "truncationChip"
        case .activity: return "activity"
        case .loadEarlier: return "loadEarlier"
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
    /// Open a server-side file in the in-app preview (HTML → WKWebView).
    /// Raised when a tapped link is a FilePreviewLink rather than a web URL.
    case previewFile(path: String)
    case toggleExpanded(rowID: String)
    case loadEarlier
}
