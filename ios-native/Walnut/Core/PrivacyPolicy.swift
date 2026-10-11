import SwiftUI

/// The app's privacy policy: PRIVACY.md in the public repository, linked from
/// the pairing screen and from Settings (App Store guideline 5.1.1).
///
/// Opened with a SwiftUI `Link`, which hands the address to iOS, so it opens in
/// Safari and never passes through the app's own networking. The demo's
/// in-process server (`DemoURLProtocol`) only sees requests this process makes,
/// so the link works in the demo too.
enum PrivacyPolicy {
    static let url = URL(string: "https://github.com/EvanZhang008/open-walnut/blob/main/PRIVACY.md")!
    static let title = "Privacy Policy"
}

/// "Privacy Policy" as a plain link line, for the pairing screen.
struct PrivacyPolicyLink: View {
    var body: some View {
        Link(destination: PrivacyPolicy.url) {
            Text(PrivacyPolicy.title)
                .font(.footnote.weight(.medium))
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
        }
        .foregroundStyle(Theme.tint)
        .accessibilityIdentifier("setup.privacyPolicy")
    }
}
