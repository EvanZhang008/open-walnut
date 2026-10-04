import SwiftUI
import UIKit

/// The Connection screen's "Reach the Mac from anywhere" section: one line of
/// Tailscale advice and, when the fix is an install, a button to the App Store.
/// Renders nothing for `.none`. Muted (on the Mac's Wi-Fi, which answers) it
/// reads as a footnote: the advice is about later, away from home.
struct TailscaleGuidanceSection: View {
    let guidance: TailscaleGuidance

    var body: some View {
        if let text = guidance.text {
            Section {
                Text(text)
                    .font(guidance.isMuted ? .footnote : .subheadline)
                    .foregroundStyle(guidance.isMuted ? Color(.secondaryLabel) : Color(.label))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("routes.guidance")
                if let title = guidance.actionTitle, let url = guidance.actionURL {
                    Button {
                        UIApplication.shared.open(url) { opened in
                            if !opened { AppLog.warn("connectivity", "could not open the Tailscale App Store page") }
                        }
                    } label: {
                        Label(title, systemImage: "arrow.down.app")
                            .font(guidance.isMuted ? .footnote : .body)
                    }
                    .accessibilityIdentifier("routes.guidance.action")
                }
            } header: {
                Text("Reach the Mac from anywhere")
            }
        }
    }
}
