import SwiftUI
import WebKit

// The demo's visible parts: the entry on the pairing screen, the quiet "Demo"
// label shown while it runs, and the Settings section that leaves it.

/// "Try the demo" on the pairing screen: a secondary action under Connect.
struct DemoEntryButton: View {
    @Environment(ConnectionStore.self) private var connection
    /// The pairing screen is busy with a real connect.
    var disabled = false

    @State private var entering = false
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 10) {
            Button(action: enter) {
                HStack(spacing: 8) {
                    if entering {
                        ProgressView().tint(Theme.tint)
                    } else {
                        Image(systemName: "play.circle")
                    }
                    Text("Try the demo").fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity, minHeight: 48)
                .contentShape(Rectangle())
            }
            .foregroundStyle(Theme.tint)
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Theme.tint.opacity(0.35), lineWidth: 1)
            )
            .disabled(disabled || entering)
            .accessibilityIdentifier("setup.tryDemo")

            Text("No server yet? Look around with sample tasks, chats and letters. Nothing leaves this phone.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            if let failure {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
            }
        }
        .padding(.top, 12)
    }

    private func enter() {
        entering = true
        failure = nil
        Task {
            do {
                try await DemoEntry.enter(connection: connection)
            } catch {
                failure = "The demo could not start. Try again."
                AppLog.error("demo", "demo entry failed", ["error": String(describing: error)])
            }
            entering = false
        }
    }
}

/// The persistent label shown at the top of every screen while the demo runs.
struct DemoBanner: View {
    /// The band reserved for it under the status bar.
    static let bandHeight: CGFloat = 24
    /// Both words are drawn in the tint over the soft tint, which clears the 4.5:1
    /// text bar in both schemes (about 5.0 light, 5.8 dark). "Sample data" used to
    /// be `.secondary`, which measured 2.0 light and 2.5 dark on this fill; the
    /// step down from "Demo" is now carried by weight alone.
    static let inkColor = Theme.tintColor
    static let fillColor = Theme.tintSoftColor

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .imageScale(.small)
            Text("Demo")
                .fontWeight(.semibold)
            Text("Sample data")
        }
        .font(.caption)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .foregroundStyle(Color(uiColor: Self.inkColor))
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color(uiColor: Self.fillColor)))
        // The band has a fixed height, so the label stops growing at a size that fits it.
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Demo, sample data")
        .accessibilityIdentifier("demo.banner")
    }
}

private struct DemoModeChrome: ViewModifier {
    @Environment(ConnectionStore.self) private var connection

    private var showsBanner: Bool {
        guard connection.isConfigured, DemoMode.isDemoURL(connection.serverURL) else { return false }
        #if DEBUG
        // Screenshot runs can hide the label: `-walnutDemoHideBadge YES`.
        if UserDefaults.standard.bool(forKey: "walnutDemoHideBadge") { return false }
        #endif
        return true
    }

    func body(content: Content) -> some View {
        let band = showsBanner ? DemoBanner.bandHeight : 0
        content
            .background(DemoSafeAreaBand(height: band))
            .overlay(alignment: .top) {
                if showsBanner {
                    // The overlay starts where the safe area does, which is now
                    // the band's bottom edge: lift the label up into the band.
                    DemoBanner()
                        .frame(maxWidth: .infinity)
                        .frame(height: band)
                        .offset(y: -band)
                        .allowsHitTesting(false)
                }
            }
    }
}

/// Reserves the label's band through UIKit: `additionalSafeAreaInsets` on the
/// window's root controller. A SwiftUI `safeAreaInset` is not enough, because the
/// tab and navigation bars are UIKit and lay out against the window's safe area:
/// with one, the label covered every tab's toolbar buttons and the chat header.
private struct DemoSafeAreaBand: UIViewRepresentable {
    let height: CGFloat

    func makeUIView(context: Context) -> BandView {
        let view = BandView()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: BandView, context: Context) {
        view.height = height
        view.apply()
    }

    final class BandView: UIView {
        var height: CGFloat = 0

        override func didMoveToWindow() {
            super.didMoveToWindow()
            apply()
        }

        func apply() {
            guard let root = window?.rootViewController,
                  root.additionalSafeAreaInsets.top != height else { return }
            root.additionalSafeAreaInsets.top = height
        }
    }
}

extension View {
    /// The demo's on-screen label. A no-op outside the demo.
    func demoModeChrome() -> some View { modifier(DemoModeChrome()) }
}

/// Settings while in the demo: what this is, and the way out.
struct DemoSettingsSection: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ChatStore.self) private var chat

    var body: some View {
        if connection.isConfigured, DemoMode.isDemoURL(connection.serverURL) {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text("You're using the demo")
                        .font(.headline)
                    Text("Everything here is sample data. Changes stay on this phone and are erased when you leave. To use Walnut for real, run the Walnut server on your computer and pair this phone with it.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
                Button {
                    chat.closeStream()
                    connection.disconnect()
                } label: {
                    Label("Leave demo", systemImage: "rectangle.portrait.and.arrow.right")
                }
                .accessibilityIdentifier("settings.leaveDemo")
                #if DEBUG
                // UI tests read this to prove the demo sent nothing to any other host.
                .accessibilityValue("blocked \(DemoURLProtocol.blockedRequests.count)")
                #endif
            } header: {
                Text("Demo")
            }
        }
    }
}

extension WKWebView {
    /// `load(_:)`, except in the demo: WebKit loads outside the app's URL
    /// protocols, so a demo page is handed over as a string and never fetched.
    @discardableResult
    func walnutLoad(_ request: URLRequest) -> WKNavigation? {
        if let url = request.url, DemoMode.isDemoURL(url) {
            return loadHTMLString(DemoFixtures.htmlPreview(for: url), baseURL: nil)
        }
        return load(request)
    }
}
