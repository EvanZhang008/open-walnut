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
struct LiveAgentActivity {
    /// Reasoning accumulated so far this turn, newest at the end (bounded).
    private(set) var thinkingText = ""
    /// True once the accumulation dropped its head to stay under the cap.
    private(set) var thinkingTruncated = false
    /// The tool running right now, cleared by its `tool-result`.
    private(set) var toolName: String?
    private(set) var toolDetail: String?

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
        guard let toolName, !toolName.isEmpty else { return nil }
        guard let toolDetail, !toolDetail.isEmpty else { return toolName }
        return "\(toolName) · \(toolDetail)"
    }

    /// A turn boundary (turn-start / message-start) or a canonical history load:
    /// everything about the previous turn's live region goes.
    mutating func reset() {
        thinkingText = ""
        thinkingTruncated = false
        pendingThinking = ""
        toolName = nil
        toolDetail = nil
        bound = LiveMarkdownWindow.TailBound()
    }

    /// Buffer a reasoning delta. Cheap by construction — see `flush()`.
    mutating func appendThinking(_ delta: String) {
        guard !delta.isEmpty else { return }
        pendingThinking += delta
    }

    mutating func toolStarted(name: String, detail: String?) {
        toolName = name
        toolDetail = detail
    }

    /// A tool finished. The NAME goes with it: leaving it set is what made the
    /// activity row keep naming a tool that had already returned.
    mutating func toolFinished() {
        toolName = nil
        toolDetail = nil
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
    private struct ToolPayload: Decodable { let name: String; let detail: String? }

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
            live.toolStarted(name: payload.name, detail: payload.detail)
            return Handled(impliesStreaming: true, toolName: payload.name,
                           needsFlush: false)
        case "tool-result":
            live.toolFinished()
            return Handled(impliesStreaming: false, toolName: nil, needsFlush: false)
        default:
            return nil
        }
    }
}
