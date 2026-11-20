import SwiftUI

/// A Known card's body (experiment ack_means_known; server `src/core/org/thread-known.ts`, web
/// `web/src/components/org/ThreadKnown.tsx`): he acknowledged it while its work ran, so in place of
/// the summary it says he knows it, what it waits on (the read's `awaits`), and how it ends. The
/// card's task chips under it carry each task's live state.
struct OrgThreadKnownBlock: View {
    let thread: OrgThread
    let name: String
    @Environment(TasksStore.self) private var tasks

    private static let ends = "comes back to To read only if there is something new for you; otherwise it closes. Your phone does not buzz."

    private var waits: [OrgThread.Awaits.Waiting] {
        // An older server sends no `awaits`: the thread's own task list says what it went to.
        thread.awaits.map { $0.tasks ?? [] } ?? (thread.tasks ?? []).map { id in
            OrgThread.Awaits.Waiting(id: id, title: tasks.tasks.first { $0.id == id }?.title ?? id)
        }
    }

    private var ended: Bool {
        guard let w = thread.awaits else { return false }
        return (w.tasks ?? []).isEmpty && w.replies != true && w.letter != true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(ended ? "You know it. Its work is done; \(name) has a few minutes to tell you anything new." : "You know it.")
                .font(.subheadline)
            if !ended {
                ForEach(waits) { x in
                    Text("Waiting on \u{201C}\(x.title)\u{201D} to finish\(x.what == nil ? "." : ":")")
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
            Text(ended ? "It \(Self.ends)" : "When it ends: it \(Self.ends)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("org.thread.known")
    }
}
