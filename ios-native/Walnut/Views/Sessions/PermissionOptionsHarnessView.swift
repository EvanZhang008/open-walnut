#if DEBUG
import SwiftUI

/// Screenshot/E2E harness for the generic permission card's answers (DEBUG only):
/// launching with `-perm-harness` renders PendingPermissionStack against three
/// prompts with the shapes the server sends: a Claude Bash prompt with its
/// remembering options (claude-permission-options.ts), an ACP adapter's own
/// options, and a Claude prompt with no options (the plain Allow / Deny). No
/// server, no live CLI, no pairing.
///
/// Each answer is read back under the cards as the request body would carry it,
/// so a UI test proves the wire values without a live session.
struct PermissionOptionsHarnessView: View {
    @State private var answered: [String: PermissionReply] = [:]
    @State private var pageHeight: CGFloat = 0

    private static let requests: [PendingPermission] = [
        PendingPermission(
            requestId: "perm-claude-bash",
            toolName: "Bash",
            input: [
                "command": .string("npm test -- --run tests/providers"),
                "description": .string("Run the provider tests"),
            ],
            reason: nil,
            acpOptions: [
                PermissionOption(optionId: "allow_once", kind: "allow_once", name: "Allow", detail: nil, takesNote: nil),
                PermissionOption(
                    optionId: "allow_session", kind: "allow_always", name: "Allow for this session",
                    detail: "Bash(npm test:*)", takesNote: nil
                ),
                PermissionOption(
                    optionId: "allow_always", kind: "allow_always", name: "Always allow in this project",
                    detail: "Bash(npm test:*)", takesNote: nil, savedTo: ".claude/settings.local.json"
                ),
                PermissionOption(optionId: "reject_once", kind: "reject_once", name: "Deny", detail: nil, takesNote: true),
            ]
        ),
        PendingPermission(
            requestId: "perm-acp-edit",
            toolName: "Edit",
            input: ["file_path": .string("src/providers/acp-session.ts")],
            reason: nil,
            acpOptions: [
                PermissionOption(optionId: "approved", kind: "allow_once", name: "Allow once", detail: nil, takesNote: nil),
                PermissionOption(
                    optionId: "approved-for-session", kind: "allow_always", name: "Allow for session",
                    detail: nil, takesNote: nil
                ),
                PermissionOption(optionId: "abort", kind: "reject_once", name: "Reject", detail: nil, takesNote: nil),
            ]
        ),
        PendingPermission(
            requestId: "perm-claude-plain",
            toolName: "WebFetch",
            input: ["url": .string("https://example.com/changelog")],
            reason: nil
        ),
    ]

    var body: some View {
        VStack(spacing: 0) {
            PendingPermissionStack(
                requests: Self.requests.filter { answered[$0.requestId] == nil },
                // Most of the page, so one shot shows every card, with room
                // left under them for the read-back.
                pageHeight: pageHeight * 0.85 / PendingPermissionStack.pageShare,
                isAnswering: { _ in false },
                onRespond: { request, reply in answered[request.requestId] = reply },
                onAnswer: { _, _, _ in },
                onDismissQuestions: { _ in }
            )
            readBack
        }
        .keyboardSafeComposerContent()
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { pageHeight = $0 }
        .navigationTitle("Permission options")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.visible, for: .navigationBar)
    }

    /// What WOULD go on the wire for each answered card.
    private var readBack: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(answered.keys.sorted(), id: \.self) { id in
                    let reply = answered[id]
                    Text("\(id): allow=\(reply?.allow == true) optionId=\(reply?.optionId ?? "-") message=\(reply?.message ?? "-")")
                        .font(.caption2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("perm.harness.answer.\(id)")
                }
            }
            .padding(12)
        }
    }
}
#endif
