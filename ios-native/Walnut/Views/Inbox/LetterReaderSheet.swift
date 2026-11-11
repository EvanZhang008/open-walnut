import SwiftUI

/// Sheet payload for "open this letter here": a tapped letter link
/// (`LetterMentionLink`), from any screen.
struct LetterOpenTarget: Identifiable, Equatable {
    let id: String
}

/// The letter reader as a sheet over the screen whose link was tapped, so the
/// letter opens where the user is looking. Switching to the Inbox tab instead
/// would open it behind any sheet already up (a task, a session, another letter),
/// out of sight. The same reader the Inbox pushes, in its own navigation stack
/// (it pushes a reply's session), with Done to close it, as `TaskSessionSheet` has.
struct LetterReaderSheet: View {
    let target: LetterOpenTarget
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            LetterReaderView(letterId: target.id)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { dismiss() }
                            .accessibilityIdentifier("inbox.letterSheet.done")
                    }
                }
        }
        // The sheet is the screen in front: its reply box is on screen, whatever the
        // presenting view's tab says.
        .environment(\.composerCovered, false)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

extension View {
    /// Present a tapped letter link's letter over this view.
    func letterReaderSheet(_ target: Binding<LetterOpenTarget?>) -> some View {
        sheet(item: target) { LetterReaderSheet(target: $0) }
    }
}
