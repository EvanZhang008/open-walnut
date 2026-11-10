import Foundation

/// A message sent while the chat's turn runs goes straight into that turn, as on the
/// web (2026-11-09, the owner: "不要queue了 就像网页版也一样直接发出去 显示quue或者deliver
/// for each message", then "而且order一定要对").
///
/// The server decides: the phone posts the message with `join: true`, and the turn
/// running on the conversation's lane either takes it, then answers it before it
/// ends (202 `joined`, with the lane session whose line gives the bubble its Queued
/// and Delivered), or cannot take it now (409 `turn_active`: the turn has not handed
/// its own message to the CLI yet, or is ending), and the words wait here for the
/// turn to end. A server too old to know `join` answers 409 the same way, so the
/// phone keeps working against it as before.
enum ChatLaneJoinRules {
    /// May a send go to the running turn now? While a turn runs here (or a send into
    /// it is still on its way), never past anything that waits here (the ordering
    /// invariant, `ChatStore.hasQueuedSendsHere`), never while a new turn's send is
    /// out, never while the agent waits on a question (the composer answers it),
    /// never with pictures (the server takes those only as a turn of their own),
    /// and never offline.
    static func mayJoin(
        streaming: Bool, joining: Bool, sending: Bool, waitingHere: Bool,
        pendingQuestion: Bool, online: Bool, hasConversation: Bool, hasImages: Bool
    ) -> Bool {
        (streaming || joining) && !sending && !waitingHere && !pendingQuestion
            && online && hasConversation && !hasImages
    }

    /// The turn could not take the message now: it waits here for the turn to end.
    static func keepsForAfterTheTurn(_ error: Error) -> Bool {
        (error as? APIError)?.isTurnActive == true
    }

    /// `entry` into the line, ahead of the first entry of its conversation that was
    /// sent after it (`sentAfter`: its bubble stands below the entry's on screen), so a
    /// send that comes back from the turn keeps its place among later ones. Never by
    /// `createdAt`: it is to the second, and two sends a second apart are common.
    static func inserting(
        _ entry: QueuedSend, into queue: [QueuedSend], sentAfter: (QueuedSend) -> Bool
    ) -> [QueuedSend] {
        var out = queue
        let later = out.firstIndex {
            $0.conversationID == entry.conversationID && $0.agentID == entry.agentID && sentAfter($0)
        }
        out.insert(entry, at: later ?? out.endIndex)
        return out
    }

    /// Each bubble's state, by bubble id: a banked row's own (`queuedRowStates`),
    /// else the lane's state for the message the bubble went in under.
    static func bubbleStates(
        banked: [String: QueuedSend.Status], lane: [String: QueuedSend.Status],
        joined: [String: String]
    ) -> [String: QueuedSend.Status] {
        guard !lane.isEmpty else { return banked }
        var out = banked
        for (bubbleID, messageID) in joined {
            if out[bubbleID] == nil, let state = lane[messageID] { out[bubbleID] = state }
        }
        return out
    }
}
