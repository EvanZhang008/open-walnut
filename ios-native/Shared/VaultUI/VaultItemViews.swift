import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The pieces the app's Passwords screen and the AutoFill sheet share, so a login looks the same
/// in both: its tile, its row, a live one-time code, and copying a value.

/// A rounded tile with the item's first letter on a colour picked from its title, so the same
/// login always looks the same. No site icons: fetching one would tell a server which sites the
/// person has accounts on.
struct VaultItemIcon: View {
    let item: VaultItem
    var size: CGFloat = 36

    private static let hues: [Color] = [
        Color(red: 0.55, green: 0.35, blue: 0.17), Color(red: 0.20, green: 0.45, blue: 0.75),
        Color(red: 0.18, green: 0.55, blue: 0.40), Color(red: 0.62, green: 0.30, blue: 0.55),
        Color(red: 0.78, green: 0.42, blue: 0.12), Color(red: 0.30, green: 0.36, blue: 0.70),
        Color(red: 0.70, green: 0.25, blue: 0.28), Color(red: 0.16, green: 0.50, blue: 0.58),
    ]

    private var symbol: String? {
        switch item.type {
        case .note: return "note.text"
        case .card: return "creditcard.fill"
        case .api_key: return "key.horizontal.fill"
        case .identity: return "person.text.rectangle.fill"
        case .login, .other: return nil
        }
    }

    private var letter: String {
        // The title's, as the row reads it ("Cloudflare", not its "dash." host); the host only
        // for an item with no letter or digit in its title.
        let pick = { (s: String) in s.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } }
        return pick(item.title) ?? item.primaryHost.flatMap(pick) ?? "?"
    }

    private var color: Color {
        var h: UInt64 = 1469598103934665603
        for b in (item.primaryHost ?? item.title).lowercased().utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
        return Self.hues[Int(h % UInt64(Self.hues.count))]
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.24, style: .continuous).fill(color.gradient)
            if let symbol {
                Image(systemName: symbol).font(.system(size: size * 0.44, weight: .semibold)).foregroundStyle(.white)
            } else {
                Text(letter).font(.system(size: size * 0.48, weight: .semibold, design: .rounded)).foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// One item in a list: its tile, title and the username (or the site, or its kind).
struct VaultItemRow: View {
    let item: VaultItem
    var trailing: AnyView?
    /// The site on its own line above the username, where the person picks a login for some other
    /// page and needs to see whose it is.
    var showsSite = false
    /// The trailing value sits on the title's line, so the line under it (a username) has the
    /// row's whole width: a live code beside it cut long usernames to a prefix.
    var trailingBesideTitle = false
    /// Off where it says nothing: in the Passkeys list every row has one, and the AutoFill picker
    /// fills a password, whatever else the item holds.
    var showsPasskeyBadge = true

    static func subtitle(_ item: VaultItem) -> String {
        if let u = item.username, !u.isEmpty { return u }
        switch item.type {
        case .note: return "Secure note"
        case .card:
            let digits = (item.card?.number ?? "").filter(\.isNumber)
            return digits.count >= 4 ? "Card ending in \(digits.suffix(4))" : "Card"
        case .api_key: return item.envName ?? "API key"
        case .identity: return "Identity"
        case .login, .other: return item.primaryHost ?? "No username"
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            VaultItemIcon(item: item)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(item.title).font(.body.weight(.medium)).foregroundStyle(Color.primary).lineLimit(1)
                    if trailingBesideTitle, let trailing {
                        Spacer(minLength: 8)
                        trailing
                    }
                }
                // Where the person picks a login for some other page, the site and the account
                // each get a line: sharing one cut the username to a prefix.
                // They decide where a secret goes there, so they read darker than a list's subtitle.
                if showsSite, let host = item.primaryHost, host != Self.subtitle(item) {
                    Text(host).font(.footnote).foregroundStyle(Theme.secondaryOnCard).lineLimit(1)
                }
                Text(Self.subtitle(item)).font(.subheadline)
                    .foregroundStyle(showsSite ? Theme.secondaryOnCard : Color.secondary).lineLimit(1)
            }
            .frame(maxWidth: trailingBesideTitle ? .infinity : nil, alignment: .leading)
            .alignmentGuide(.listRowSeparatorLeading) { d in d[.leading] }
            Spacer(minLength: 8)
            // A row with its own trailing value (a live code) has no room for the badge.
            if trailing == nil, showsPasskeyBadge, (item.passkeys ?? []).isEmpty == false {
                // A word, not a bare glyph: a reviewer could not tell what the person-and-key meant.
                Text("Passkey").font(.caption2.weight(.semibold)).foregroundStyle(Theme.secondaryOnCard)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(Color(uiColor: .tertiarySystemFill)))
                    .accessibilityLabel("Has a passkey")
            }
            if !trailingBesideTitle, let trailing { trailing }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// The current one-time code, refreshed every second, with a ring for the time left.
struct VaultOneTimeCodeView: View {
    let totp: TOTP
    var font: Font = .system(.title3, design: .monospaced).weight(.semibold)

    static func grouped(_ code: String) -> String {
        guard code.count == 6 || code.count == 8 else { return code }
        let mid = code.index(code.startIndex, offsetBy: code.count / 2)
        return "\(code[..<mid]) \(code[mid...])"
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let c = totp.code(at: ctx.date)
            HStack(spacing: 10) {
                Text(Self.grouped(c.code)).font(font).monospacedDigit()
                    .lineLimit(1).fixedSize()
                    .foregroundStyle(c.remaining <= 5 ? Theme.danger : .primary)
                    .contentTransition(.numericText())
                ZStack {
                    Circle().stroke(Color.secondary.opacity(0.25), lineWidth: 2.5)
                    Circle().trim(from: 0, to: CGFloat(c.remaining) / CGFloat(c.period))
                        .stroke(c.remaining <= 5 ? Theme.danger : Theme.tint, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    Text("\(c.remaining)").font(.system(size: 9, weight: .semibold).monospacedDigit()).foregroundStyle(Color.secondary)
                }
                .frame(width: 22, height: 22)
                .accessibilityHidden(true)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Code \(c.code.map(String.init).joined(separator: " ")), \(c.remaining) seconds left")
        }
    }
}

enum VaultClipboard {
    /// How long a copied secret stays on the clipboard.
    static let seconds: TimeInterval = 90

    /// Copy to this iPhone only (never Universal Clipboard), cleared after `seconds`.
    static func copy(_ value: String) {
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: value]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(seconds)])
    }
}

/// A short line that floats at the bottom and leaves by itself ("Password copied").
struct VaultToast: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "checkmark.circle.fill")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16).padding(.vertical, 11)
            .background(Capsule().fill(Color.black.opacity(0.82)))
            .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
            .accessibilityAddTraits(.isStaticText)
            .accessibilityIdentifier("passwords.toast")
    }
}

/// A system prompt Passwords itself put up (Face ID, iOS's "Allow AutoFill?"): the scene goes
/// inactive under it, but the person is still looking at this screen, so it stays uncovered.
@MainActor
@Observable
final class VaultSystemPrompt {
    static let shared = VaultSystemPrompt()
    private(set) var showing = 0

    func during<T>(_ work: () async throws -> T) async rethrows -> T {
        // Coming back to the app, Face ID can ask before the scene is active again, while the
        // cover from leaving is still up: the person would see Face ID over a blank page, not
        // the lock screen it is for.
        VaultPrivacyShield.shared.uncoverAll()
        showing += 1
        defer { showing -= 1 }
        return try await work()
    }
}

/// Covers the window the moment iOS starts taking the app away (switching apps, the app
/// switcher), while a Passwords screen is open. SwiftUI's scene phase arrives a few frames
/// after iOS has begun its animation, which still showed the list shrinking away; a UIKit view
/// added in the notification itself is drawn in the first frame of it.
@MainActor
final class VaultPrivacyShield {
    static let shared = VaultPrivacyShield()
    private var screens = 0
    private var covers: [ObjectIdentifier: UIView] = [:]

    private init() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { n in
            let scene = n.object as? UIWindowScene
            MainActor.assumeIsolated { VaultPrivacyShield.shared.cover(scene) }
        }
        nc.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { n in
            let scene = n.object as? UIWindowScene
            MainActor.assumeIsolated { VaultPrivacyShield.shared.uncover(scene) }
        }
    }

    func opened() { screens += 1 }
    func closed() { screens = max(0, screens - 1) }

    private func cover(_ scene: UIWindowScene?) {
        // Face ID and iOS's own AutoFill question deactivate the scene too, over this very screen.
        guard screens > 0, VaultSystemPrompt.shared.showing == 0, let scene,
              covers[ObjectIdentifier(scene)] == nil,
              let window = scene.keyWindow ?? scene.windows.first else { return }
        let v = UIView(frame: window.bounds)
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        v.backgroundColor = .systemGroupedBackground
        let lock = UIImageView(image: UIImage(systemName: "lock.fill",
                                              withConfiguration: UIImage.SymbolConfiguration(pointSize: 44, weight: .semibold)))
        lock.tintColor = .secondaryLabel
        lock.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(lock)
        NSLayoutConstraint.activate([lock.centerXAnchor.constraint(equalTo: v.centerXAnchor),
                                     lock.centerYAnchor.constraint(equalTo: v.centerYAnchor)])
        v.accessibilityElementsHidden = true
        window.addSubview(v)
        covers[ObjectIdentifier(scene)] = v
    }

    func uncoverAll() {
        for v in covers.values { v.removeFromSuperview() }
        covers.removeAll()
    }

    private func uncover(_ scene: UIWindowScene?) {
        guard let scene, let v = covers.removeValue(forKey: ObjectIdentifier(scene)) else { return }
        v.removeFromSuperview()
    }
}

/// Covers an open Passwords screen while the app is not in front, so the app switcher's
/// snapshot shows no password, code or list.
private struct VaultPrivacyCover: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    private let prompt = VaultSystemPrompt.shared

    func body(content: Content) -> some View {
        content
        .onAppear { VaultPrivacyShield.shared.opened() }
        .onDisappear { VaultPrivacyShield.shared.closed() }
        .overlay {
            if scenePhase == .background || (scenePhase == .inactive && prompt.showing == 0) {
                ZStack {
                    Color(uiColor: .systemGroupedBackground)
                    Image(systemName: "lock.fill")
                        .font(.system(size: 44, weight: .semibold))
                        .foregroundStyle(Color.secondary)
                        .accessibilityHidden(true)
                }
                .ignoresSafeArea()
            }
        }
    }
}

extension View {
    func vaultPrivacyCover() -> some View { modifier(VaultPrivacyCover()) }

    /// Shows `text` as a toast for two seconds whenever it is set.
    func vaultToast(_ text: Binding<String?>) -> some View {
        overlay(alignment: .bottom) {
            if let t = text.wrappedValue {
                VaultToast(text: t)
                    .padding(.horizontal, 24)
                    // Above the app's floating tab bar, so it covers neither the bar nor the
                    // last lines of the list.
                    .padding(.bottom, 92)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task(id: t) {
                        try? await Task.sleep(for: .seconds(2))
                        withAnimation { text.wrappedValue = nil }
                    }
            }
        }
        .animation(.spring(duration: 0.3), value: text.wrappedValue)
    }
}

/// "Updated 2 minutes ago" for the last fetch from the Mac.
enum VaultSyncedText {
    static func line(_ date: Date?, now: Date = .now) -> String {
        guard let date else { return "Not updated from your Mac yet" }
        if now.timeIntervalSince(date) < 60 { return "Updated from your Mac just now" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return "Updated from your Mac \(f.localizedString(for: date, relativeTo: now))"
    }
}

extension View {
    /// The app's tab bar floats over the bottom of the screen, so a list's last lines (a footer
    /// such as "Updated from your Mac") need room to scroll clear of it.
    func vaultTabBarClearance() -> some View {
        contentMargins(.bottom, 72, for: .scrollContent)
            // The search field sits in the bar above: the list's default top margin left an empty
            // band of about 70 points under it.
            .contentMargins(.top, 4, for: .scrollContent)
    }
}
