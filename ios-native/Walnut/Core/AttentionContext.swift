import Foundation
import SwiftUI

/// Which of the three human time lanes the user's attention is on. Same three
/// kinds the web console reports (`HUMAN_KINDS` in core/time-tracking/types.ts),
/// so phone time lands in the SAME per-day per-task buckets as desktop time.
enum AttentionKind: String, Codable, Sendable {
    /// A session conversation screen — time is attributed to that session's task.
    case session
    /// The main-agent chat tab.
    case chat
    /// Everything else the user can look at: task board, inbox, notes, calendar,
    /// settings, search. The default, deliberately: unclaimed attention is still
    /// attention, and "triage" is what the console calls it.
    case triage
}

/// What the user is looking at, in the shape the heartbeat wire needs.
///
/// `sessionId` is the CLAUDE session id (`WalnutSession.id`, which the server's
/// projection fills from `claudeSessionId`) — the server resolves it to a task
/// via `getSessionByClaudeId`. `taskId` is sent as well whenever the screen
/// already knows it, which skips that lookup entirely and is the only path that
/// works for a session whose record the server can't resolve.
struct AttentionTarget: Equatable, Sendable {
    var kind: AttentionKind
    var sessionId: String?
    var taskId: String?

    static let triage = AttentionTarget(kind: .triage)
    static let chat = AttentionTarget(kind: .chat)

    static func session(id: String, taskId: String? = nil) -> AttentionTarget {
        AttentionTarget(kind: .session, sessionId: id, taskId: taskId)
    }
}

/// The app's single "what is on screen" signal for time tracking.
///
/// WHY A CLAIM STACK, NOT A PROP: threading a context down the view tree would
/// touch every screen and every intermediate container, and the one thing this
/// must never do is invalidate a view (an attention change is not UI state — see
/// the render-storm rules in web/src/AGENTS.md, and the whale-session render-lag
/// incident on this side). So it is a colocated singleton written from
/// appear/disappear, the same pattern `MediaContext` already uses for the
/// current session/note.
///
/// Two layers, because iOS has two independent surfaces:
///  - **base**: which TAB is selected. Owned by `MainTabView`, the only place
///    that knows tab identity. Chat → `.chat`; every other tab → `.triage`.
///  - **claims**: a screen PUSHED on top of a tab (a session conversation) takes
///    a claim while it is on screen and releases it on the way out. A stack,
///    not a single slot, because SwiftUI runs the incoming view's `onAppear`
///    BEFORE the outgoing view's `onDisappear` — a single slot would let the
///    departing screen erase the one that just arrived (the same ordering trap
///    `FreezeContext.clearScreen` guards by name). Release is by token, so an
///    out-of-order release removes its OWN entry and nothing else.
///
/// `current` is the top claim, or the base when nothing is claimed.
@MainActor
final class AttentionContext {
    static let shared = AttentionContext()

    /// Notified on every change of `current` (and only then). The reporter
    /// subscribes so it can close the window it was counting and open a new one.
    var onChange: ((AttentionTarget) -> Void)?

    private(set) var base: AttentionTarget = .triage
    private var claims: [(token: UUID, target: AttentionTarget)] = []

    private init() {}

    var current: AttentionTarget { claims.last?.target ?? base }

    /// The selected tab's lane. Idempotent.
    func setBase(_ target: AttentionTarget) {
        guard base != target else { return }
        let before = current
        base = target
        notifyIfChanged(from: before)
    }

    /// Claim attention for a pushed screen. Keep the token; release with it.
    func claim(_ target: AttentionTarget) -> UUID {
        let token = UUID()
        let before = current
        claims.append((token, target))
        notifyIfChanged(from: before)
        return token
    }

    /// Re-point an existing claim at a new target, IN PLACE.
    ///
    /// Not release + claim: that would pop to the base for an instant, which the
    /// reporter hears as two context switches and banks a zero-length window
    /// against the wrong lane. Mutating the entry keeps the claim's position in
    /// the stack (so a screen pushed on top still wins) and notifies once, only
    /// if `current` actually moved.
    func update(_ token: UUID, to target: AttentionTarget) {
        guard let index = claims.lastIndex(where: { $0.token == token }) else { return }
        guard claims[index].target != target else { return }
        let before = current
        claims[index].target = target
        notifyIfChanged(from: before)
    }

    /// Give back a claim. Unknown tokens are ignored (a double release is safe).
    func release(_ token: UUID) {
        guard let index = claims.lastIndex(where: { $0.token == token }) else { return }
        let before = current
        claims.remove(at: index)
        notifyIfChanged(from: before)
    }

    private func notifyIfChanged(from before: AttentionTarget) {
        let now = current
        guard now != before else { return }
        onChange?(now)
    }

    /// Tests only — a shared singleton needs a clean slate between cases.
    func resetForTesting() {
        claims.removeAll()
        base = .triage
        onChange = nil
    }
}

extension View {
    /// Claim the attention lane while this screen is on screen. Paired
    /// appear/disappear, released by token so SwiftUI's appear-before-disappear
    /// ordering can't drop the wrong claim.
    ///
    /// The claim FOLLOWS the target: a screen that learns its ids after it is
    /// already on screen re-points its claim instead of keeping the stale one. A
    /// session page opened from a push or a deep link is exactly that case — the
    /// row it came from may not know the task yet, and a claim frozen at first
    /// appear would keep sending `taskId: nil` for the whole visit, so the time
    /// lands in the day total but never on the task.
    func attentionContext(_ target: AttentionTarget) -> some View {
        modifier(AttentionClaimModifier(target: target))
    }
}

private struct AttentionClaimModifier: ViewModifier {
    let target: AttentionTarget
    @State private var token: UUID?

    func body(content: Content) -> some View {
        content
            .onAppear {
                guard token == nil else { return }
                token = AttentionContext.shared.claim(target)
            }
            // Fires only on a real value change (`AttentionTarget` is Equatable),
            // so an ordinary re-render costs nothing and there is no churn loop:
            // the update is a no-op unless the ids differ, and it never writes
            // anything a view observes.
            .onChange(of: target) { _, updated in
                guard let held = token else { return }
                AttentionContext.shared.update(held, to: updated)
            }
            .onDisappear {
                if let held = token { AttentionContext.shared.release(held) }
                token = nil
            }
    }
}
