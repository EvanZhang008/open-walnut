import Foundation

/// The live "what is the agent doing right now" region, shared by the Personal
/// AI chat stream and the session stream.
///
/// WHY THIS EXISTS: both streams send the SAME three events (`thinking`,
/// `tool`, `tool-result`) and both stores handled them with near-identical
/// switch arms that threw the reasoning TEXT away — `thinking { delta }` became
/// a constant `activity = "Thinking"`, so a whole turn of reasoning showed as
/// one blinking word, and a `tool` event became a transient label the next event
/// overwrote. One copy of that logic, and it KEEPS the reasoning.
///
/// Bounded on purpose. A long turn's reasoning is unbounded, and retaining it
/// whole makes every append O(reply) — the saturation mechanism
/// `LiveMarkdownWindow` exists to prevent, so the accumulation rides the very
/// same `TailBound` hysteresis the live reply text uses.
///
/// Coalesced on purpose too. `appendThinking` only touches a NON-observed
/// pending buffer; `flush()` is what folds it into `thinkingText`, so the
/// stores can publish it on their existing ~8Hz cadence instead of at the
/// cloud bridge's measured 10.7 events/s (microbursts to ~700/s).
/// One tool call made during the LIVE turn.
///
/// WHY IT OUTLIVES ITS RESULT (2026-09-12 gate): the live region used to hold ONE
/// running tool, cleared by its `tool-result` — so the chip appeared, then
/// vanished the instant the tool returned, and only came back as a history row
/// when the whole turn ended. Sampled every second on a real turn, that is a
/// tool the reader watched disappear mid-turn. A call is on screen CONTINUOUSLY
/// from its `tool` frame until the canonical transcript replaces it; the result
/// frame changes its STATE, never its existence.
struct LiveToolCall: Equatable, Sendable, Identifiable {
    /// The wire's `toolUseId`. Empty when the frame carried none (an older
    /// server) — see `LiveAgentActivity.toolFinished`.
    let id: String
    let name: String
    let detail: String?
    /// False until this call's own `tool-result` frame lands. The chip renders a
    /// breathing icon while true, so a running call and a finished one are
    /// distinguishable in a column of them.
    var finished: Bool
}

struct LiveAgentActivity {
    /// Reasoning accumulated so far this turn, newest at the end (bounded).
    private(set) var thinkingText = ""
    /// True once the accumulation dropped its head to stay under the cap.
    private(set) var thinkingTruncated = false
    /// Every tool call this turn has made, in call order, running and finished
    /// alike (see `LiveToolCall`). Bounded: a long agentic turn can make dozens,
    /// and the canonical transcript is what carries the whole list at turn end.
    private(set) var tools: [LiveToolCall] = []

    /// Retained live calls. Deliberately generous but finite — a turn with more
    /// tool calls than this has its oldest chips retired early rather than
    /// growing the live region without bound; they come back with the transcript.
    static let maxLiveTools = 24

    /// The call the agent is inside RIGHT NOW (newest unfinished), if any.
    var runningTool: LiveToolCall? { tools.last { !$0.finished } }
    /// Back-compat readers of "the tool running right now".
    var toolName: String? { runningTool?.name }
    var toolDetail: String? { runningTool?.detail }

    /// Deltas since the last `flush()`. Not observed by anything: the whole
    /// point is that a 700/s microburst costs one string append apiece.
    private var pendingThinking = ""
    /// Hysteresis state for the retention cap (see `LiveMarkdownWindow.TailBound`).
    private var bound = LiveMarkdownWindow.TailBound()

    /// Is there a delta waiting for the next flush?
    var hasPendingThinking: Bool { !pendingThinking.isEmpty }

    /// Label for the activity row. A running tool WINS: it is the concrete thing
    /// the agent is doing, and it is the thing the user asked to be able to see
    /// ("I can't see what tool it used"). Otherwise nil, which the row renders as
    /// its plain "Thinking…" shimmer — the reasoning itself gets a row of its
    /// own now rather than being squeezed into this one line.
    var activityLabel: String? {
        guard let running = runningTool, !running.name.isEmpty else { return nil }
        guard let detail = running.detail, !detail.isEmpty else { return running.name }
        return "\(running.name) · \(detail)"
    }

    /// A turn boundary (turn-start / message-start) or a canonical history load:
    /// everything about the previous turn's live region goes.
    mutating func reset() {
        thinkingText = ""
        thinkingTruncated = false
        pendingThinking = ""
        tools = []
        bound = LiveMarkdownWindow.TailBound()
    }

    /// Buffer a reasoning delta. Cheap by construction — see `flush()`.
    mutating func appendThinking(_ delta: String) {
        guard !delta.isEmpty else { return }
        pendingThinking += delta
    }

    /// A tool call started. `id` is the wire's `toolUseId`; an empty one (older
    /// server) always appends, which is the honest reading — with no id there is
    /// nothing to recognise a repeat by.
    mutating func toolStarted(id: String = "", name: String, detail: String?) {
        if !id.isEmpty, let existing = tools.firstIndex(where: { $0.id == id }) {
            // A repeated `tool` frame for one id (a replay, a re-relay) UPDATES
            // that call rather than stacking a second chip for it.
            tools[existing] = LiveToolCall(id: id, name: name, detail: detail,
                                           finished: tools[existing].finished)
            return
        }
        tools.append(LiveToolCall(id: id, name: name, detail: detail, finished: false))
        if tools.count > Self.maxLiveTools {
            tools.removeFirst(tools.count - Self.maxLiveTools)
        }
    }

    /// A tool finished. The call STAYS (see `LiveToolCall`) and is marked done, so
    /// the activity shimmer stops naming it while its chip remains on screen.
    ///
    /// Routing, most→least specific:
    ///  1. an id we ANNOUNCED — the exact call, in or out of order;
    ///  2. no id to match on at all (an empty one, or a turn whose calls all
    ///     arrived without ids because the server is older): this turn is not being
    ///     tracked by id, so ORDER is the only signal and the newest unfinished
    ///     call is the only call the frame can mean;
    ///  3. an id we never announced while this turn IS id-tracked — a no-op. Both
    ///     relays only announce results for calls they announced, so such an id
    ///     describes somebody else's call (a subagent's, a replay), and guessing
    ///     "the newest one must be it" would retire a chip still running.
    mutating func toolFinished(id: String = "") {
        let index: Int?
        if !id.isEmpty, let exact = tools.firstIndex(where: { $0.id == id }) {
            index = exact
        } else if id.isEmpty || !tools.contains(where: { !$0.id.isEmpty }) {
            index = tools.lastIndex(where: { !$0.finished })
        } else {
            index = nil
        }
        guard let index else { return }
        tools[index].finished = true
    }

    /// Fold the buffered deltas into `thinkingText`, trimming the head FIRST so
    /// the append never copy-on-writes a multi-MB string (the same order, and the
    /// same reason, as the stores' `flushPendingDelta`).
    ///
    /// Returns true when `thinkingText` actually changed, so a caller can gate
    /// its observable write instead of invalidating every reader per tick.
    @discardableResult
    mutating func flush() -> Bool {
        guard !pendingThinking.isEmpty else { return false }
        let (trimmedText, trimmed) = bound.bound(thinkingText)
        if trimmed {
            thinkingText = trimmedText
            thinkingTruncated = true
        }
        thinkingText += pendingThinking
        pendingThinking = ""
        return true
    }
}

/// The `thinking` / `tool` / `tool-result` arms of BOTH live streams, in one
/// place. Each store's own switch calls this first and falls through to its own
/// arms when the answer is nil.
enum LiveStreamEvents {
    /// Wire shape of a `thinking` event. `delta` is optional on purpose: the
    /// session stream has always sent it, the chat stream is only now growing it,
    /// and a replica that has not been redeployed sends the event with no
    /// payload at all. A missing delta must still mean "a turn is running".
    private struct ThinkingPayload: Decodable { let delta: String? }
    /// `toolUseId` is optional for the same reason `delta` is: both relays send it
    /// today (api-v1 `tool`/`tool-result`, session-stream-v1 likewise), an older
    /// one does not, and a missing id must still mean "a tool started/ended".
    private struct ToolPayload: Decodable {
        let name: String
        let detail: String?
        let toolUseId: String?
    }
    private struct ToolResultPayload: Decodable { let toolUseId: String? }

    /// What the caller still has to do with its own (observable, gated) state.
    struct Handled {
        /// The event is proof a turn is in flight.
        let impliesStreaming: Bool
        /// Present when the event was `tool` — ChatStore keys `user_ask` off it.
        let toolName: String?
        /// A reasoning delta was buffered: schedule the coalesced flush.
        let needsFlush: Bool
    }

    /// Apply one event. Returns nil when `event` is none of the three.
    static func apply(event: String, data: Data,
                      to live: inout LiveAgentActivity) -> Handled? {
        switch event {
        case "thinking":
            // Decode failures degrade to "a turn is running", never to a dropped
            // event: an older server sends `thinking` with no `delta` key.
            let delta = (try? JSONDecoder().decode(ThinkingPayload.self, from: data))?.delta
            live.appendThinking(delta ?? "")
            return Handled(impliesStreaming: true, toolName: nil,
                           needsFlush: live.hasPendingThinking)
        case "tool":
            guard let payload = try? JSONDecoder().decode(ToolPayload.self, from: data) else {
                // A malformed payload is still evidence of a running turn.
                return Handled(impliesStreaming: true, toolName: nil, needsFlush: false)
            }
            live.toolStarted(id: payload.toolUseId ?? "", name: payload.name,
                             detail: payload.detail)
            return Handled(impliesStreaming: true, toolName: payload.name,
                           needsFlush: false)
        case "tool-result":
            let id = (try? JSONDecoder().decode(ToolResultPayload.self, from: data))?.toolUseId
            live.toolFinished(id: id ?? "")
            return Handled(impliesStreaming: false, toolName: nil, needsFlush: false)
        default:
            return nil
        }
    }
}
