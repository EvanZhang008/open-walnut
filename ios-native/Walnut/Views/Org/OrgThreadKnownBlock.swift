import SwiftUI

/// What holds a card he acknowledged while work on it was not over (experiment ack_means_known;
/// server `src/core/org/thread-ack-outcome.ts`, web `web/src/components/org/ThreadKnown.tsx`), in
/// place of its summary; the card is drawn under Working or Waiting / Snoozed (its `ackGroup`). Each
/// task still working on its subject, or waiting (on what, until when); his reply on its way; a
/// decision letter. The card's task chips under it carry each task's live state.
struct OrgThreadKnownBlock: View {
    let thread: OrgThread
    let name: String
    @Environment(TasksStore.self) private var tasks

    private var waits: [OrgThread.Awaits.Waiting] {
        // An older server sends no `awaits`: the thread's own task list says what it went to.
        thread.awaits.map { $0.tasks ?? [] } ?? (thread.tasks ?? []).map { id in
            OrgThread.Awaits.Waiting(id: id, title: tasks.tasks.first { $0.id == id }?.title ?? id)
        }
    }

    private var ended: Bool {
        if thread.ackGroup == "closed" { return true }
        guard let w = thread.awaits else { return false }
        return (w.tasks ?? []).isEmpty && w.replies != true && w.letter != true
    }

    private func line(_ x: OrgThread.Awaits.Waiting) -> String {
        if thread.ackGroup == "working" { return "Still in work: \u{201C}\(x.title)\u{201D}" }
        var out = "Waiting on \u{201C}\(x.title)\u{201D}"
        if let on = x.waitingOn { out += ": \(on)" }
        if let until = x.until.flatMap(WalnutTask.parseISO) {
            out += ", until \(until.formatted(date: .abbreviated, time: .shortened))"
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if ended {
                Text("Its work is over; it closes in a few minutes unless \(name) has something new for you.")
                    .font(.subheadline)
            } else {
                ForEach(waits) { x in
                    Text(line(x))
                        .font(.subheadline)
                    if let what = x.what {
                        Text(what)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                if thread.awaits?.replies == true {
                    Text("Waiting on your reply to reach \(name).").font(.subheadline)
                }
                if thread.awaits?.letter == true {
                    Text("Waiting on the decision its letter asks.").font(.subheadline)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("org.thread.known")
    }
}
