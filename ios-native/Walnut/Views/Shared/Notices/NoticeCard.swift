import SwiftUI

/// The one card every notice is drawn as: the web's `NoticeCard` (web/src/components/common/
/// NoticeCard.tsx) and the Mac app's `NoticeCardView`, on the phone. A rounded card of frosted
/// glass with the same hairline on all four sides (never a coloured bar down one side,
/// 2026-11-20: the user found it ugly and unneeded), a 22 pt avatar tile, a bold title, a status as a
/// 6 pt dot and a word, and a preview of two lines. Optional: an X, and a row of buttons.
///
/// The glass is `.thinMaterial`, one step clearer than `.regularMaterial` (2026-11-20: the user
/// asked for a stronger frosted glass; the web's frost went from 62% to 38% tint the same day).
/// `.ultraThinMaterial` let a chat's text show through clearly enough to fight the preview's grey
/// words in light mode. Light mode lays a grey tint over it, so it reads as glass on a white page.
/// With Reduce Transparency on, the card is solid.
struct NoticeCard: View {
    let item: NoticeItem
    var onClose: (() -> Void)?

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @ScaledMetric(relativeTo: .footnote) private var avatarSide: CGFloat = 22
    @ScaledMetric(relativeTo: .caption) private var dotSide: CGFloat = 6
    /// A notice with nothing to open shows its whole preview on a tap.
    @State private var expanded = false

    static let radius: CGFloat = 14
    /// The X's tap area, the platform minimum (its glyph stays small).
    static let closeSide: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 0) {
                head
                // Every notice can be closed (2026-11-22, the user: "why there is no x so that i cna close"):
                // a live one (an upload, a reconnect) only leaves the screen; its work goes on.
                if let onClose {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: Self.closeSide, height: Self.closeSide)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    // The 44 pt square reaches past the card's padding instead of growing it.
                    .padding(.top, -12)
                    .padding(.trailing, -12)
                    .padding(.bottom, -12)
                    .accessibilityLabel("Dismiss")
                    .accessibilityIdentifier("\(identifier).close")
                }
            }
            if !item.actions.isEmpty {
                HStack(spacing: 8) {
                    ForEach(item.actions) { action in
                        Button(role: action.role) { action.run() } label: {
                            Text(action.title)
                        }
                        // The family's round key; a destructive action keeps its red words.
                        .buttonStyle(.walnut(action.role == .destructive ? .destructive : .secondary, size: .small))
                    }
                }
                .padding(.leading, avatarSide + 10)
            }
        }
        .padding(.vertical, 10)
        .padding(.leading, 12)
        .padding(.trailing, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            shape.fill(ground)
            // Light mode takes a grey tint over the glass, as the web's frost does (2026-11-20, the
            // user, of a near-white card: "not glass, I want glass"): over a white page the
            // material alone reads as a solid white card.
            if !reduceTransparency && scheme == .light {
                shape.fill(Color(uiColor: .systemGray5).opacity(0.55))
            }
        }
        .overlay(shape.strokeBorder(hairline, lineWidth: 1))
        .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.12), radius: 14, y: 6)
        // Chrome, not content: past the large accessibility sizes it would cover half the screen.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private var identifier: String { item.accessibilityId ?? item.id }
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Self.radius, style: .continuous) }

    private var ground: AnyShapeStyle {
        reduceTransparency
            ? AnyShapeStyle(Color(uiColor: .secondarySystemGroupedBackground))
            : AnyShapeStyle(.thinMaterial)
    }

    private var hairline: Color {
        scheme == .dark ? Color.white.opacity(0.16) : Color.black.opacity(0.10)
    }

    /// The avatar, title, status and preview: one element for VoiceOver.
    @ViewBuilder
    private var head: some View {
        let words = HStack(alignment: .top, spacing: 10) {
            NoticeAvatarTile(avatar: item.shownAvatar, tone: item.tone, side: avatarSide)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .layoutPriority(1)
                    if let status = item.status, !status.isEmpty {
                        NoticeStatusLabel(text: status, tone: item.tone, dotSide: dotSide)
                    }
                }
                if let preview = item.preview, !preview.isEmpty {
                    Text(preview)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(expanded ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.spokenText)
        .accessibilityIdentifier("\(identifier).text")
        // The swipe up, for VoiceOver.
        .accessibilityAction(named: "Dismiss") { onClose?() }

        if let onTap = item.onTap {
            Button { onTap() } label: { words }
                .buttonStyle(.plain)
        } else {
            words.onTapGesture { withAnimation(.snappy(duration: 0.2)) { expanded.toggle() } }
        }
    }
}

/// The status: a small dot and its word, coloured by tone (the quick bar's dot and "Delivered"). A live
/// one's dot breathes while it is on its way, and holds still under Reduce Motion.
struct NoticeStatusLabel: View {
    let text: String
    let tone: NoticeTone
    var dotSide: CGFloat = 6

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(tone.color)
                .frame(width: dotSide, height: dotSide)
                .opacity(dim ? 0.35 : 1)
                .onAppear {
                    guard tone == .live, !reduceMotion else { return }
                    withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { dim = true }
                }
            Text(text)
                .font(.caption)
                .foregroundStyle(tone.wordColor)
                .lineLimit(1)
        }
    }
}

/// The 22 pt rounded-square tile: a white glyph or initials on the tone's colour.
struct NoticeAvatarTile: View {
    let avatar: NoticeAvatar
    let tone: NoticeTone
    var side: CGFloat = 22

    var body: some View {
        RoundedRectangle(cornerRadius: side * 7 / 22, style: .continuous)
            .fill(LinearGradient(colors: Self.gradient(tone), startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay {
                switch avatar {
                case .symbol(let name):
                    Image(systemName: name)
                        .font(.system(size: side * 0.55, weight: .semibold))
                case .initials(let letters):
                    Text(letters.prefix(2).uppercased())
                        .font(.system(size: side * 0.45, weight: .bold, design: .rounded))
                }
            }
            .foregroundStyle(.white)
            .frame(width: side, height: side)
            .accessibilityHidden(true)
    }

    /// The web card's tile colours (notice-card.css), light to deep.
    static func gradient(_ tone: NoticeTone) -> [Color] {
        func c(_ hex: Int) -> Color {
            Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
        }
        switch tone {
        case .live: return [c(0x409CFF), c(0x0A6CFF)]
        case .ok: return [c(0x4CD964), c(0x28A745)]
        case .warn: return [c(0xFFB340), c(0xF08C00)]
        case .error: return [c(0xFF6B5E), c(0xD93A2B)]
        case .muted: return [c(0x8E8E93), c(0x636366)]
        }
    }
}
