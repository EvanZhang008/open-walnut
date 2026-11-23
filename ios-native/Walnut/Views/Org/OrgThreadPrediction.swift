import Foundation

/// A change of his on one thread, as the phone shows it from the tap until the server answers.
enum OrgThreadChange: Equatable {
    case edit(OrgThreadEdit)
    /// His Follow up went into the node's chat: the thread is the node's move again.
    case followUp
}

/// What a thread and its node's count look like the moment he acts, before the server answers:
/// the web's `optimistic` (`web/src/components/org/useOrgThreads.ts`) and the server's
/// `threadCounts` (`src/core/org/thread-groups.ts`), ported. Pure; pinned in
/// `OrgThreadsInstantTests`.
extension OrgThreadModel {
    /// The server's clock format (`toISOString`): stamps compare as text against its own.
    static func stamp(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }

    /// The thread after `change`, the web's `optimistic` (useOrgThreads.ts). `shown` and `counted`
    /// are set where the server's rule is known (closed, snoozed: out of his view and no number) and
    /// cleared where the phone judges it again (`shownToHim`, `countedForHim`), so the page and every
    /// count move with the card.
    static func optimistic(_ thread: OrgThread, _ change: OrgThreadChange, now: Date) -> OrgThread {
        var t = thread
        let at = stamp(now)
        switch change {
        case .followUp:
            return afterHisFollowUp(t)
        case .edit(.acknowledge):
            t.closed = .init(how: "acked", at: at, by: "human")
            t.updatedAt = at
            t.shown = false
            t.counted = false
        case .edit(.watch(let on)):
            // A watch moves no clock and no count: its own group keeps it where it was.
            if on {
                // His watch keeps its place while the write is on its way (a re-read must not reorder the list).
                if watch(t) == nil { t.watched = .init(at: at, by: "human") }
            } else {
                t.watched = nil
                t.pinned = nil
            }
        case .edit(.watchAt(let place)):
            t.watched = .init(at: place, by: watch(t)?.by ?? "human")
            t.pinned = nil
        case .edit(.reopen):
            t.closed = nil
            t.updatedAt = at
            t.shown = nil
            t.counted = nil
        case .edit(.snooze(let until)):
            t.snoozed = nil
            if until.isEmpty {
                t.shown = nil
                t.counted = nil
            } else {
                t.snoozed = .init(until: until, at: at)
                t.shown = false
                t.counted = false
            }
            t.updatedAt = at
        }
        return t
    }

    /// Whether the server counts it in the node's numbers (thread-groups.ts threadsForHim: it waits
    /// on him, a decision or a result unread): its own word where it sent one (`counted`), else, from
    /// an older server or after a change of his the phone made, the phone's rule: in his view and his
    /// to answer or read (needs or answered), or an answer he has not reacted to.
    static func countedForHim(_ t: OrgThread, shared: Set<String>, now: Date) -> Bool {
        if t.closed != nil || snoozedNow(t, now: now) { return false }
        if let counted = t.counted { return counted }
        return inView(t, shared: shared, now: now)
    }

    /// The counts the server derives into the node's `user_status.threads` from these threads
    /// (thread-groups.ts threadCounts): how many wait on him, how many of those are Needs you, the
    /// watched ones among them, and the thread the row names (the newest waiting on him, else the
    /// newest watch, else the newest counted).
    static func counts(_ threads: [OrgThread], now: Date) -> WalnutThreadCounts {
        let shared = sharedAnswers(threads)
        let lit = threads.filter { countedForHim($0, shared: shared, now: now) }
        let needs = lit.filter { $0.state == "needs" }
        let watched = lit.filter(watchedNow).sorted { (watch($0)?.at ?? "") > (watch($1)?.at ?? "") }
        let newest = { (list: [OrgThread]) in list.max { $0.updatedAt < $1.updatedAt } }
        let top = newest(needs) ?? watched.first ?? newest(lit)
        return WalnutThreadCounts(shown: lit.count, needs: needs.count, watched: watched.count,
                                  title: top?.title, id: top?.id, titleWatched: top.map(watchedNow) ?? false)
    }

    /// The node's status with the counts of the list as drawn (the web's `statusWithThreads`).
    /// Only a status the server counts Threads into is predicted (an Org node's): `counted` says
    /// so, also for a status a prediction already took every count away from.
    static func status(_ status: WalnutUserStatus?, withThreadsOf list: [OrgThread], counted: Bool,
                       now: Date) -> WalnutUserStatus? {
        guard var s = status, counted else { return status }
        let c = counts(list, now: now)
        s.threads = c.shown > 0 ? c : nil
        return s
    }
}
