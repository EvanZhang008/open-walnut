import SwiftUI
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

/// Where a tool row's call is in its life. It is what the activity drawer needs
/// to be HONEST about an empty Result section, and it replaces a lone `running`
/// flag because that flag could only say two of the three things (2026-09-16
/// report: a finished live Bash row said "No output" while the tool had produced
/// plenty, because the output simply had not been relayed yet).
///
/// One enum rather than a `running` + `live` pair: of the pair's four
/// combinations one is nonsense (a transcript row is a call that ALREADY
/// RETURNED, so it can never be running), and the impossible state should not be
/// constructible.
enum TimelineToolPhase: Hashable, Sendable {
    /// A live call whose own `tool-result` has not landed. The chip breathes.
    case running
    /// A live call that returned. Its output is on the phone only if the server
    /// sent `resultPreview`, so an empty Result here means "not relayed yet".
    case liveFinished
    /// A transcript row: always returned, and an empty Result there really is no
    /// output, because the whole turn is on disk by then.
    case transcript
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
    /// Banked-send row under a queued bubble: the `Queued` badge plus a way to
    /// take it back. Its own row rather than an adornment inside the bubble, for
    /// the reason `failedNotice` is one: the bubble cell is TextKit-measured from
    /// its text alone, and a control inside it would have no height of its own.
    ///
    /// `delivering` is a POST already out for this message. The badge changes and
    /// the Withdraw control is GONE — not disabled, gone — because there is nothing
    /// left that could take it back, and a control that silently does nothing is
    /// worse than no control.
    case queuedNotice(delivering: Bool, stacked: Bool)
    /// Code fence: monospace, horizontal scroll, no wrapping.
    case code(text: String, contentSize: CGSize)
    /// Inline image (assistant output or historical user image send).
    /// Fixed-height slot; the cell aspect-fits the loaded image.
    case image(raw: String, alt: String)
    /// Local (just-sent) user image thumbnails — JPEG datas from the picker.
    case localImages(datas: [Data], dimmed: Bool)
    /// Markdown table — hosted grid (rare; bounded by maxRenderedTableRows).
    case table(header: [AttributedString], rows: [[AttributedString]])
    /// Tool call chip. ONE line, always: tapping it opens the shared activity
    /// drawer (`TimelineActivityDetail`) with the full Input and Result, rather
    /// than growing the row in place.
    ///
    /// WHY A DRAWER AND NOT AN INLINE CARD (2026-09-11): an inline card can only
    /// show as much as fits a phone row, so its Input/Result sections were capped
    /// (320pt / 200pt) with a nested horizontal scroller inside the transcript's
    /// own scroller. The reader tapped to READ the output and got a clipped
    /// window — and the reasoning row next to it had a second, different
    /// expansion mechanism with a third truncation rule. One tap, one drawer, no
    /// cap: the row keeps exactly one pre-measured height, and the two surfaces
    /// cannot drift because they share this case.
    ///
    /// `running` is a LIVE-turn fact (this call's `tool-result` has not landed
    /// yet), never a history one: a transcript row is always finished, and a row
    /// with no `resultPreview` there produced no output rather than being in
    /// flight. The chip breathes while it is true, which is the only thing that
    /// tells a running call from a finished one in a column of chips.
    ///
    /// `stacked` puts the detail on its OWN LINE under the name. It rides in the row
    /// rather than being decided by the cell from the environment, because the row's
    /// HEIGHT is a formula computed here and the cell must render exactly the shape
    /// that formula reserved — a cell reading the environment could stack a row
    /// measured for one line during the frames after a text-size change.
    case toolChip(name: String, detail: String?, inputPreview: String?,
                  resultPreview: String?, agent: String?, phase: TimelineToolPhase,
                  detailRef: String?, stacked: Bool)
    /// Thinking row: a grey capsule reading the fixed word "Thinking" FOLLOWED BY
    /// the server's collapsed reasoning line, with the FULL reasoning behind a tap
    /// (same drawer the tool row opens).
    ///
    /// The capsule WORD is fixed and lives in the cell, not in this payload — the
    /// live row used to print "Reasoning" while a history row printed the server's
    /// collapsed excerpt line INSTEAD of a word, so one turn showed two different
    /// names for one thing ("thinking is just thinking"). A constant cannot drift.
    ///
    /// `line` is the row's CONTENT next to that constant, exactly the way a tool
    /// row prints its `detail` next to its name (2026-09-12): dropping it made
    /// five stacked reasoning rows read `Thinking ›` five times, so finding the
    /// one you wanted meant opening all five drawers. One vocabulary, one legible
    /// line — the two are not in tension.
    ///
    ///  - `preview == nil` — history: one line, tap for everything.
    ///  - `preview != nil` — the LIVE turn: the newest `maxLines` wrapped lines
    ///    render under the capsule so the reader watches reasoning arrive (see
    ///    `TimelineLiveThinkingWindow`). It is a PREVIEW, never the whole text:
    ///    `fullText` is the entire accumulation and the drawer shows that. A live
    ///    row carries no `line`: the preview card below it already shows the
    ///    newest reasoning, and printing a line in the capsule too is the same
    ///    words twice in one row.
    ///
    /// `maxLines` bounds the preview only (0 when there is none); the drawer has
    /// no cap because it scrolls.
    case thinking(line: String?, preview: String?, fullText: String,
                  maxLines: Int, detailRef: String?, stacked: Bool)
    /// Small grey capsule (generic one-line status capsules).
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
        case .queuedNotice: return "queuedNotice"
        case .code: return "code"
        case .image: return "image"
        case .localImages: return "localImages"
        case .table: return "table"
        case .toolChip: return "toolChip"
        case .thinking: return "thinking"
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
        case .queuedNotice(let delivering, let stacked):
            hasher.combine(delivering)
            // Drawn AND measured: a text-size change that only flips this must still
            // reload the cell.
            hasher.combine(stacked)
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
        case .toolChip(let name, let detail, let inputPreview, let resultPreview,
                       let agent, let phase, let detailRef, let stacked):
            hasher.combine(name)
            hasher.combine(detail)
            hasher.combine(inputPreview)
            hasher.combine(resultPreview)
            hasher.combine(agent)
            // The phase is DRAWN (a running chip breathes) and it decides the
            // drawer's Result note, so a chip whose call just finished must be
            // handed to its cell even though everything else about the row is
            // byte-identical at that moment.
            hasher.combine(phase)
            hasher.combine(detailRef)
            // Drawn AND measured: a text-size change that only flips this must still
            // reload the cell.
            hasher.combine(stacked)
        case .thinking(let line, let preview, let fullText, let maxLines, let detailRef,
                       let stacked):
            hasher.combine(line)
            hasher.combine(preview)
            hasher.combine(fullText)
            hasher.combine(maxLines)
            hasher.combine(detailRef)
            hasher.combine(stacked)
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

    /// Is this row a CHIP the reader taps to open the activity drawer?
    ///
    /// Drives the cell's hit-target expansion (`TimelineHostedRowCell`), which is
    /// the one thing a chip row needs and no other hosted row does: the capsule is
    /// ~21pt of ink inside a ~27pt cell on a ~37pt pitch, so a thumb landing
    /// between two chips used to hit nothing at all.
    var opensActivityDrawer: Bool {
        switch self {
        case .toolChip, .thinking: return true
        default: return false
        }
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
    /// Reasoning the agent has emitted during the IN-FLIGHT turn, accumulated
    /// (bounded) by the stores' shared `LiveAgentActivity`. Empty = it is not
    /// reasoning right now. Optional-with-default because every existing caller
    /// predates it; `scope` above stays required for the opposite reason (a
    /// defaulted scope is how a caller silently gets another conversation's
    /// rows).
    ///
    /// Deliberately NOT in `TimelineLayoutActor.cacheKey`: that memo is keyed
    /// per MESSAGE and this is not a message — it only ever feeds `liveRows`,
    /// which is rebuilt from scratch on every streaming tick. It IS covered by
    /// the diff, through the `contentKey` arm of the `.thinking` row it produces.
    var liveThinking: String = ""
    /// Every tool call the IN-FLIGHT turn has made, running and finished alike, as
    /// name + one-line detail rather than as the folded "name · detail" label
    /// `activity` carries one at a time.
    ///
    /// WHY BOTH EXIST: the live tool used to reach the timeline only as that
    /// folded string, which became a shimmering `.activity` row — so a `Bash`
    /// mid-turn had no input, no result, no tap and a different shape from the
    /// `.toolChip` the same call renders as once the transcript lands. The phone
    /// showed a tool while it ran, then lost it. Keeping the parts separate is
    /// what lets `liveRows` build REAL tool chips for them.
    ///
    /// WHY IT IS A LIST: one slot meant a finished call was dropped the instant
    /// its `tool-result` arrived, so the chip vanished mid-turn and only came back
    /// as a history row at turn end. See `LiveToolCall`.
    var liveTools: [LiveToolCall] = []
    var activity: String?
    var showLoadEarlier: Bool
    /// Content width the rows must be measured at.
    var width: CGFloat
    /// Row ids whose expandable content is currently open (tool chips,
    /// notification cards) — owned by the controller, echoed through builds.
    var expandedRowIDs: Set<String>
    /// Where each banked message is in its life, by message id.
    ///
    /// An input rather than a flag on `ChatMessage`: queue membership is store state
    /// that changes without the message changing, and it is the store that owns the
    /// answer. Defaulted empty, so every surface that has no queue (the session
    /// transcript, the DEBUG harness) is unaffected.
    var queuedMessageStates: [String: QueuedSend.Status] = [:]
    /// Which conversation these messages belong to (see `TimelineScope`). Every
    /// UI surface passes one; the default is the unscoped id space, for direct
    /// builder/actor use in tests and the DEBUG harness.
    var scope: String = TimelineScope.unscoped
    /// Text size every height in this build was measured at.
    ///
    /// WHY IT IS AN INPUT: the layout NEVER self-sizes, so a Dynamic Type change
    /// moves every measured height at once — and the SwiftUI-hosted cells adopt
    /// the new size immediately while the memo still holds the old numbers, which
    /// is rows overlapping and labels sliced (a fresh launch at XXXL was always
    /// correct, so this was invalidation, never layout). Carrying it here makes it
    /// invalidate exactly like `width`, on the same line, in the same place.
    /// `.unspecified` = "whatever the system says", the default for direct
    /// builder/actor use in tests.
    var sizeCategory: UIContentSizeCategory = .unspecified
}

/// The actor's output: a complete row array (never a delta — latest wins).
struct TimelineSnapshot {
    let rows: [TimelineRow]
    let width: CGFloat
    /// Monotonic build counter, for latest-wins ordering on the main side.
    let generation: Int
}

/// What the activity drawer shows for ONE tapped row (a thinking row or a tool
/// row). The whole payload rides the action, so the sheet needs no store lookup:
/// a row id would have to be resolved back to a message, and the live rows have
/// no message to resolve to.
///
/// ONE type for both row kinds on both surfaces — the chat and the session pass
/// it to the same `TimelineActivitySheet`, which is what makes "tap to see it
/// all" behave identically everywhere instead of being implemented twice.
struct TimelineActivityDetail: Identifiable, Equatable {
    enum Kind: Equatable {
        /// Reasoning: prose, WRAPPED and selectable.
        case thinking
        /// A tool call: monospaced Input and Result sections.
        case tool
    }

    /// The row that raised it. Identity for `.sheet(item:)`, so tapping a
    /// different row while the drawer is open re-presents it with new content.
    let id: String
    let kind: Kind
    /// Drawer title: "Thinking", or the tool's name.
    let title: String
    /// Tool rows only — the one-line detail from the capsule ("npm test").
    let subtitle: String?
    /// Tool rows only — the full input.
    let input: String?
    /// Thinking: the reasoning EXCERPT the list payload carried. Tool: the clipped
    /// result (nil = none yet). Either can be a server-clipped prefix — the drawer
    /// shows it immediately and then replaces it with the full text it fetches
    /// (`TimelineActivityFullText`), never a spinner in place of text it has.
    let body: String?
    /// Tool rows only — the subagent this call belongs to.
    let agent: String?
    /// Tool rows only: where this call is in its life, which is the ONLY thing
    /// that makes an empty Result section honest (see `TimelineToolPhase` and
    /// `TimelineExpandSection.resultNote`). `.transcript` for a thinking row,
    /// where it is never read.
    let phase: TimelineToolPhase
    /// Opaque server token for "read this row's WHOLE text", or nil when the
    /// excerpt IS the whole thing (and on any box that does not send the field
    /// yet). nil is the NORMAL case, not a failure: the drawer shows everything
    /// it holds and offers no fetch at all.
    let detailRef: String?

    static func thinking(id: String, text: String, detailRef: String? = nil) -> Self {
        Self(id: id, kind: .thinking, title: TimelineActivityVocabulary.thinking,
             subtitle: nil, input: nil, body: text, agent: nil, phase: .transcript,
             detailRef: detailRef)
    }

    static func tool(id: String, name: String, detail: String?, input: String?,
                     result: String?, agent: String?, phase: TimelineToolPhase,
                     detailRef: String? = nil) -> Self {
        Self(id: id, kind: .tool, title: name, subtitle: detail, input: input,
             body: result, agent: agent, phase: phase, detailRef: detailRef)
    }

    /// The payload a `.toolChip` row opens with, and nil for any other row.
    ///
    /// WHY IT TAKES THE ROW: this mapping (an empty preview is NO section, the
    /// phase rides through untouched) used to live inside the cell's tap closure,
    /// where only a real device could reach it, so a drawer showing a Bash row's
    /// description as its Input, and "No output" under a tool that had produced
    /// output, was findable by hand and by nothing else. Now the row a test builds
    /// and the payload the sheet receives are one call apart.
    static func tool(row: TimelineRow) -> Self? {
        guard case .toolChip(let name, let detail, let inputPreview, let resultPreview,
                             let agent, let phase, let detailRef, _) = row.content else {
            return nil
        }
        return tool(id: row.id, name: name, detail: detail,
                    input: inputPreview?.isEmpty == false ? inputPreview : nil,
                    result: resultPreview?.isEmpty == false ? resultPreview : nil,
                    agent: agent, phase: phase, detailRef: detailRef)
    }
}

/// The ONE word the UI uses for reasoning, on every surface and in both the
/// collapsed capsule and the drawer title.
///
/// It is a constant and not a literal because the drift it fixes was two
/// literals: the live row said "Reasoning", a history row said whatever the
/// server put in `text`, and the same turn showed both.
enum TimelineActivityVocabulary {
    static let thinking = "Thinking"
}

/// What VoiceOver says for the two chip rows.
///
/// Pure functions so the spoken text is testable without rendering SwiftUI, and so
/// each chip has exactly ONE description. Both chips used to expose their icon,
/// their text and their chevron as three separate elements with no button trait, so
/// VoiceOver read SF Symbol names out loud — measured in the real hierarchy:
/// "wrench.and.screwdriver", "Sparkle", "Forward".
///
/// Composed from the same values the row DRAWS, in reading order, so a chip that
/// looks distinguishable sounds distinguishable: the reasoning line and the tool's
/// detail are exactly what tells one row from the next.
enum TimelineChipAccessibility {
    /// "Thinking" alone when the row has no line — which is only the live row,
    /// whose preview card is its own element.
    static func thinking(line: String?) -> String {
        guard let line = line?.trimmingCharacters(in: .whitespacesAndNewlines),
              !line.isEmpty else { return TimelineActivityVocabulary.thinking }
        return "\(TimelineActivityVocabulary.thinking), \(line)"
    }

    /// Name first (it is what the reader is looking for), then the delegation, the
    /// detail, and finally the state — "running" only while the call is in flight,
    /// because a chip that has returned says nothing about state at all.
    static func tool(name: String, detail: String?, agent: String?,
                     running: Bool) -> String {
        var parts = [name]
        if let agent = agent?.trimmingCharacters(in: .whitespacesAndNewlines),
           !agent.isEmpty {
            parts.append("delegated to \(agent)")
        }
        if let detail = detail?.trimmingCharacters(in: .whitespacesAndNewlines),
           !detail.isEmpty {
            parts.append(detail)
        }
        if running { parts.append("running") }
        return parts.joined(separator: ", ")
    }
}

/// When a tool chip's detail needs its own line.
///
/// At accessibility text sizes a one-line chip cannot hold both terms: measured on
/// the pinned simulator at accessibility XXXL, "Record permission-wall handoff
/// principle" middle-truncated to "Re…ciple" — 8 characters, which is noise. The
/// detail is the ONLY thing telling eight stacked `Bash` rows apart, so it gets a
/// second line rather than being squeezed to nothing (or dropped, which would put the
/// identical-rows problem straight back).
///
/// ONE rule, two spellings, because the builder speaks `UIContentSizeCategory` and
/// SwiftUI speaks `DynamicTypeSize`. They must agree for every category — the row's
/// reserved height comes from one and its shape from the other — which
/// `ChatRichnessRowTests` pins across the whole enumeration.
enum TimelineChipLayout {
    static func stacksDetail(_ category: UIContentSizeCategory) -> Bool {
        category.isAccessibilityCategory
    }

    static func stacksDetail(_ size: DynamicTypeSize) -> Bool {
        size.isAccessibilitySize
    }

    /// The `UIContentSizeCategory` spelling of a `DynamicTypeSize`, for the places that
    /// have a SwiftUI environment and need a resolved `UIFont` (see
    /// `TimelineLongText`, which measures with TextKit). Written out rather than
    /// bridged through the ambient trait collection, so a view can be hosted at a text
    /// size a test chose and still measure the font that size really draws with.
    static func category(_ size: DynamicTypeSize) -> UIContentSizeCategory {
        switch size {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }
}

/// User actions raised by cells, routed controller → host → store.
enum TimelineRowAction {
    case retry(messageID: String)
    case discard(messageID: String)
    /// Take a banked message back before it is posted. Nothing goes on the wire.
    case withdrawQueued(messageID: String)
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
    /// A thinking or tool row was tapped: present the activity drawer. Carries
    /// its own content (see `TimelineActivityDetail`) — the coordinator forwards
    /// it untouched, because unlike `toggleExpanded` nothing about the LAYOUT
    /// changes and the page owns sheet presentation.
    case openActivity(TimelineActivityDetail)
    /// A rich cell measured its document: the coordinator banks the height and
    /// rebuilds so the row carries the real number. Handled INSIDE the
    /// coordinator (like `toggleExpanded`) — the page never sees it.
    case richHeight(rowID: String, key: String, width: CGFloat, height: CGFloat)
    case loadEarlier
}
