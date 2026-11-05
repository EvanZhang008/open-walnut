import SwiftUI

/// An Org node's Brief on the phone: its letter to the user in three sections (Needs you, Working,
/// Waiting / snoozed), under a line saying when it was written and what moved since, as the web's
/// Brief view (`web/src/components/org/OrgBrief.tsx`). Task pills open their session.
struct OrgBriefView: View {
    let taskId: String
    let name: String

    @State private var reply: OrgBriefReply?
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(Theme.needsText)
                }
                if !loaded {
                    ProgressView("Loading the brief…")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                } else if let letter = reply?.brief {
                    head(letter: letter, fresh: reply?.fresh)
                    LetterMarkdownBody(markdown: Self.separatingRefs(letter.text))
                        .accessibilityIdentifier("org.brief.text")
                } else if error == nil {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No brief yet").font(.headline)
                        Text("\(name) writes one when its next turn ends.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 24)
                    .accessibilityIdentifier("org.brief.empty")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .refreshable { await load() }
        .task(id: taskId) { await load() }
        .accessibilityIdentifier("org.brief")
    }

    private func head(letter: OrgBriefReply.Letter, fresh: OrgBriefReply.Fresh?) -> some View {
        TimelineView(.periodic(from: .now, by: 60)) { ctx in
            let now = ctx.date.addingTimeInterval(AppClock.demoOffset)
            let written = WalnutTask.parseISO(letter.at).map { "Written \(RelativeTime.short(date: $0, relativeTo: now))" } ?? "Written"
            let moved = (fresh?.words ?? "").trimmingCharacters(in: .whitespaces)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: fresh?.stale == true ? "clock.badge.exclamationmark" : "clock")
                    .foregroundStyle(fresh?.stale == true ? Theme.warning : .secondary)
                Text(moved.isEmpty ? written : "\(written) · \(moved)")
                    .foregroundStyle(.secondary)
            }
            .font(.footnote)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("org.brief.head")
        }
    }

    /// Two task pills side by side ("<task> <its VP>：…") read as one title in the same colour:
    /// a dot goes between them.
    static func separatingRefs(_ text: String) -> String {
        text.replacingOccurrences(
            of: #"(<task-ref\b[^>]*/>)[ \t]+(?=<task-ref\b)"#, with: "$1 · ", options: .regularExpression)
    }

    private func load() async {
        do {
            reply = try await WalnutAPI().orgBrief(taskId: taskId)
            error = nil
        } catch {
            if let api = error as? APIError, api.isCancelled { return }
            self.error = reply == nil ? "Couldn't load the brief. Pull to try again." : "Couldn't refresh the brief."
        }
        loaded = true
    }
}
