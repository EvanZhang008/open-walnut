import SwiftUI

/// A sheet that holds his unsaved work or a decision he owes: it refuses a swipe down, and a
/// navigation from outside the screen (a tapped thread push) waits until he saves or closes it
/// (2026-11-08 review, round 2: a push tore down the session hosting a description he was
/// editing). The ONE way a sheet refuses to close: `PresentationLoweringGuardTests` fails on an
/// `interactiveDismissDisabled` anywhere else.
///
/// While a navigation waits on it, the sheet says so at its top (`nav.held`), in a strip of its
/// own above the content, which moves down for it: never over the sheet's title or its Cancel and
/// Save (2026-11-08 review, round 3: a safe-area inset outside the sheet's navigation stack put the
/// line over its bar).
extension View {
    /// `until`: what ends the wait, in the sheet's own words (a decision is answered, not saved).
    func holdsNavigation(_ holds: Bool = true, until: NavigationHeldLine.Until = .saved) -> some View {
        modifier(HoldsNavigation(holds: holds, until: until))
    }
}

private struct HoldsNavigation: ViewModifier {
    let holds: Bool
    let until: NavigationHeldLine.Until
    @State private var link = OrgNodeLink.shared

    func body(content: Content) -> some View {
        VStack(spacing: 0) {
            if holds, let waiting = link.held {
                NavigationHeldLine(title: waiting.title, until: until)
                    // Its tint reaches up under the status bar or the sheet's grabber.
                    .background(Theme.tintSoft.opacity(0.7).ignoresSafeArea(edges: .top))
            }
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .interactiveDismissDisabled(holds)
    }
}

/// "A notification is waiting": the push opens once this sheet is saved or closed.
struct NavigationHeldLine: View {
    /// What he does to let the push through.
    enum Until: Equatable {
        /// Save or close: unsaved words, a pick, a photo.
        case saved
        /// Answer or close: a decision he owes (an approval).
        case answered

        var words: String {
            switch self {
            case .saved: return "save or close this"
            case .answered: return "answer or close this"
            }
        }
    }

    let title: String?
    var until: Until = .saved

    static func text(_ title: String?, until: Until = .saved) -> String {
        if let title, !title.isEmpty {
            return "\u{201C}\(title)\u{201D} opens when you \(until.words)."
        }
        return "The notification you tapped opens when you \(until.words)."
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "bell.badge")
                .foregroundStyle(Theme.tint)
                .accessibilityHidden(true)
            Text(Self.text(title, until: until))
                .font(.footnote)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("nav.held")
    }
}
