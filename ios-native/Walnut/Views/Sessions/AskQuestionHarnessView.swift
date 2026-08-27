#if DEBUG
import SwiftUI

/// Screenshot/E2E harness for the AskUserQuestion card (DEBUG only): launching
/// with `-askq-harness` renders PermissionRequestCard against a pending
/// permission whose `input` has the SHAPE of a real captured AskUserQuestion
/// payload (see AskUserQuestionCardTests for where that shape came from) — no
/// server, no live CLI, no pairing.
///
/// Why a harness: the real card only appears while a CLI is genuinely blocked
/// mid-turn on this tool, which is not a state you can hold still long enough to
/// photograph. This renders the same view the product path renders, so the
/// question text, every option label, and every option description can be
/// verified visually.
struct AskQuestionHarnessView: View {
    @State private var submitted: [String: String]?
    @State private var dismissed = false

    /// Real-shape payload: question 1 has `multiSelect: false`, question 2 omits
    /// the key entirely (common in real payloads), question 3 is multi-select.
    private static let request = PendingPermission(
        requestId: "req-ask-harness",
        toolName: AskUserQuestion.toolName,
        input: [
            "questions": .array([
                .object([
                    "question": .string("Which cache backend should the indexer use?"),
                    "header": .string("Backend"),
                    "multiSelect": .bool(false),
                    "options": .array([
                        .object([
                            "label": .string("On-disk (Recommended)"),
                            "description": .string("Survives restarts and costs one extra fsync per batch."),
                        ]),
                        .object([
                            "label": .string("In-memory"),
                            "description": .string("Fastest, but every restart rebuilds the whole index."),
                        ]),
                    ]),
                ]),
                .object([
                    "question": .string("How should a stale entry be treated?"),
                    "header": .string("Staleness"),
                    "options": .array([
                        .object([
                            "label": .string("Serve stale, refresh behind"),
                            "description": .string("Answers instantly and recomputes in the background."),
                        ]),
                        .object([
                            "label": .string("Block until fresh"),
                            "description": .string("Always correct, but a cold entry pays full latency."),
                        ]),
                    ]),
                ]),
                .object([
                    "question": .string("Which surfaces should the rollout cover?"),
                    "header": .string("Rollout"),
                    "multiSelect": .bool(true),
                    "options": .array([
                        .object([
                            "label": .string("Web console"),
                            "description": .string("The desktop browser UI."),
                        ]),
                        .object([
                            "label": .string("Phone app"),
                            "description": .string("The native mobile client."),
                        ]),
                        .object([
                            "label": .string("CLI"),
                            "description": .string("The terminal entry point."),
                        ]),
                    ]),
                ]),
            ])
        ],
        reason: nil
    )

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                PermissionRequestCard(
                    request: Self.request,
                    answering: false,
                    onRespond: { _ in },
                    onAnswer: { submitted = $0 },
                    onDismissQuestions: { dismissed = true }
                )
                // Read-back of what WOULD go on the wire, so a screenshot run can
                // prove the answer payload without a live session.
                if let submitted {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("answers →").font(.caption.weight(.semibold))
                        ForEach(submitted.keys.sorted(), id: \.self) { key in
                            Text("\(key) = \(submitted[key] ?? "")")
                                .font(.caption2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.secondarySystemBackground))
                    .padding(.horizontal, 12)
                    .accessibilityIdentifier("askq.harness.submitted")
                }
                if dismissed {
                    Text("dismissed (deny sent)")
                        .font(.caption)
                        .padding(.horizontal, 12)
                        .accessibilityIdentifier("askq.harness.dismissed")
                }
            }
            .padding(.bottom, 24)
        }
        .navigationTitle("AskUserQuestion")
        .navigationBarTitleDisplayMode(.inline)
    }
}
#endif
