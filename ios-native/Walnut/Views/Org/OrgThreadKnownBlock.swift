import SwiftUI

/// What holds a card he acknowledged once it was placed in Working or Waiting (experiment
/// ack_means_known; server `src/core/org/thread-known.ts`, web `web/src/components/org/ThreadKnown.tsx`),
/// in place of its summary, under the line saying where it went and why. Each task still working on
/// its subject, or waiting (on what, until when); his reply on its way; a decision letter. The
/// card's task chips under it carry each task's live state.
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

    private var placed: OrgThread.AckPlaced? { OrgThreadModel.placedSinceAck(thread) }

    /// Only one Walnut placed settles by itself; one the AI placed is the node's to move.
    private var ended: Bool {
        guard placed?.by == "walnut", let w = thread.awaits else { return false }
        return (w.tasks ?? []).isEmpty && w.replies != true && w.letter != true
    }

    private func line(_ x: OrgThread.Awaits.Waiting) -> String {
        if placed?.to == "working" { return "Still in work: \u{201C}\(x.title)\u{201D}" }
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
                    // A task's title and what it waits on are agent words: Markdown, paths open.
                    Text(MarkdownParser.inline(line(x)))
                        .font(.subheadline)
                        .handlingFilePathLinks()
                    if let what = x.what {
                        Text(MarkdownParser.inline(what))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .handlingFilePathLinks()
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
