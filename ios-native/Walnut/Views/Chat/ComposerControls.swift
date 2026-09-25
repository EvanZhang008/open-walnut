import SwiftUI

/// The composer's model controls: a MODEL pill and, when the current model has
/// an effort axis, an EFFORT pill beside it. They sit in the input row, next to
/// the message they configure.
///
/// Why the model lives HERE and not in a settings sheet: this mirrors the web
/// console's decision, quoted from `DraftLaunchBar.tsx` ("the model belongs with
/// the message, so the draft renders it inside the composer's controls row,
/// exactly where a real session's model pill sits"). The desktop's session
/// composer and its main-agent composer (`LaneComposerControls.tsx`) both put the
/// model pill in the controls row; the phone matches.
///
/// Effort is its own pill. It used to be a submenu row at the top of the model
/// menu, and a menu with one submenu reserves a trailing chevron column in EVERY
/// row: the model names got about 139pt and "Default (Opus 5.5 1M)" wrapped onto
/// two lines at the default text size. With the model menu holding models only,
/// the names get the full width, and changing the effort is one tap shorter. The
/// web's picker keeps effort in a column of its own for the same reason: it is a
/// separate axis of the same choice. The effort pill offers only the levels the
/// CURRENT model declares, and is absent (not greyed out) for a model without an
/// effort axis, so there is never a control that is disabled for a reason the
/// user can't see.
///
/// What is deliberately NOT in this row (a 44pt row is not a settings screen):
///  - Permission mode stays in the session menu (Session Controls). It is a
///    spawn-shaped safety setting, not a per-message choice.
///  - Path/host are not in a live session's composer at all: they are facts of a
///    running CLI, and belong to session CREATION (see NewSessionChatView).
///
/// The pills are UIKit button menus (`PillMenuButton`), so UIKit places the menu
/// (it can never overflow the screen however many models the catalog carries).
/// The web AGENTS.md rule "menus never overflow the viewport" holds by
/// construction here. With the keyboard up, a tap on a pill puts the keyboard
/// away and the next tap opens the menu: there is no room above a pill that sits
/// on the keyboard, and a menu laid over the pill picked rows on a double tap.
///
/// Text size: side by side up to the largest standard size, STACKED at the
/// accessibility sizes, where the model name also wraps instead of truncating.
/// Side by side at AX5 the model pill got 131pt and "GPT-6 Astra" read "GP…"
/// while the effort pill kept "High" in full (gate r2 D2): a name the user
/// cannot read is not a control. Stacked, the model name has the whole row.
struct ComposerModelPill: View {
    @State var controls: ComposerControlsModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// The model pill's height, for the stacked effort pill's menu to clear.
    @State private var modelPillHeight: CGFloat = 0
    private static let spacing: CGFloat = 6

    var body: some View {
        let stacked = dynamicTypeSize.isAccessibilitySize
        // One layout value switched, not two view trees: the pills keep their
        // identity (and their UIKit buttons) across a text-size change.
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Self.spacing))
            : AnyLayout(HStackLayout(spacing: Self.spacing))
        layout {
            // Nothing known yet (still loading, or an engine with no switchable
            // session): no pill rather than one that lies or a spinner that draws
            // the eye to a control the user did not ask about.
            if let label = controls.pillLabel {
                PillChip(
                    text: label,
                    // The name is the LAST KNOWN one while unreachable, so the pill
                    // itself says so rather than only the menu: a stale value that
                    // looks live is the failure that state exists to avoid.
                    glyph: controls.unreachable ? .warning : (controls.readOnly ? .none : .chevron),
                    state: controls.modelPillState,
                    wraps: stacked,
                    rawID: controls.pillLabelIsRawID,
                    menu: controls.modelMenu,
                    menuID: "model",
                    accessibilityID: "composer.modelPill",
                    accessibilityLabel: controls.pillAccessibilityLabel,
                    controls: controls
                )
                // Side by side, the effort pill ("High") gives way first: the
                // model name is the one that must stay readable.
                .layoutPriority(1)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { modelPillHeight = $0 }
            }
            if let effort = controls.effortPillLabel {
                PillChip(
                    text: effort,
                    // Last known (the Mac is away): a fact to read, no menu.
                    glyph: controls.effortPillState == .lastKnown ? .none : .chevron,
                    state: controls.effortPillState,
                    wraps: stacked,
                    rawID: false,
                    menu: controls.effortMenu,
                    menuID: "effort",
                    // Stacked, the model pill sits above this one, and the effort
                    // menu opening over it would put a level row where the model
                    // pill is. It opens above both.
                    menuClearance: stacked && controls.pillLabel != nil ? modelPillHeight + Self.spacing : 0,
                    accessibilityID: "composer.effortPill",
                    accessibilityLabel: controls.effortPillAccessibilityLabel,
                    controls: controls
                )
            }
        }
    }
}

/// One capsule: the SwiftUI label the user sees, with the UIKit button that owns
/// its menu laid exactly over it (see `PillMenuButton` for why the menu is UIKit).
private struct PillChip: View {
    enum Glyph { case chevron, warning, none }

    let text: String
    let glyph: Glyph
    /// Everything the pill draws and takes follows from this one value.
    let state: ComposerControlsModel.PillState
    /// Wrap onto more lines rather than truncate (the stacked layout).
    let wraps: Bool
    /// The text is a raw model id: at most two lines, shortened in the middle.
    let rawID: Bool
    let menu: PillMenu
    let menuID: String
    var menuClearance: CGFloat = 0
    let accessibilityID: String
    let accessibilityLabel: String
    let controls: ComposerControlsModel
    @State private var pressed = false
    /// The glyph grows with the text: a fixed 8pt chevron sat cramped and tiny
    /// against an XXXL label.
    @ScaledMetric(relativeTo: .caption) private var glyphSize: CGFloat = 8
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 4) {
            if state.spins {
                ProgressView().controlSize(.mini)
            }
            Text(text)
                .font(.caption.weight(.medium))
                .lineLimit(PillChipText.lineLimit(wraps: wraps, rawID: rawID))
                .truncationMode(rawID ? .middle : .tail)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: wraps)
            switch glyph {
            case .warning:
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: glyphSize, weight: .semibold))
            case .chevron:
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: glyphSize, weight: .semibold))
            case .none:
                EmptyView()
            }
        }
        .foregroundStyle(Color(uiColor: ComposerPillInk.ink(for: state)))
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(
            Color(uiColor: ComposerPillInk.capsule),
            in: PillChipShape(oneLineHeight: PillChipText.oneLineHeight(dynamicTypeSize) + 10)
        )
        // The pressed look a SwiftUI Button gives, which the transparent UIKit
        // button on top can't draw itself.
        .opacity(pressed ? 0.5 : 1)
        // ONE accessibility element per pill: the UIKit button, which carries the
        // identifier, the label and the menu.
        .accessibilityHidden(true)
        .overlay {
            PillMenuButton(
                menu: menu,
                accessibilityID: accessibilityID,
                accessibilityLabel: accessibilityLabel,
                menuID: menuID,
                menuClearance: menuClearance,
                onSelect: { choice, token in controls.menuSelect(choice, token: token) },
                onPresentedChange: { id, presented in controls.setMenuPresented(presented, menu: id) },
                onHighlightChange: { pressed = $0 }
            )
            // SwiftUI writes this onto the UIButton's `isEnabled` after every
            // update, so it is the ONLY way to disable it (see PillMenuButton).
            .disabled(!state.takesTaps)
        }
    }
}

/// The pills' colors, as dynamic UIKit colors so `ComposerPillContrastTests` can
/// resolve them in light and dark and measure what the user reads.
///
/// Enabled ink is the label color at 78%: 10.3:1 on the capsule in light and
/// 9.3:1 in dark, measured on simulator screenshots. The old pill inherited the
/// SwiftUI `Menu` label's tinted secondary ink and measured about 2.2:1 and
/// 2.7:1 the same way (the gate read 2.04:1 and 2.44:1). Disabled drops to
/// `tertiaryLabel` (about 1.7:1 and 2.4:1), visibly quieter than enabled: a
/// disabled control is exempt from the 4.5:1 text bar, and should look it.
///
/// Except while the pill's OWN pick is being written: that pill names the model
/// the user just chose, so it keeps the readable ink, and the spinner beside the
/// name is what says "busy" (it still takes no taps). The quiet ink made the new
/// name 1.69:1 for the whole write (gate r2). A last known effort (the Mac is
/// away) is a fact to read as well, so it keeps the readable ink too.
enum ComposerPillInk {
    static let enabled = UIColor { traits in
        UIColor.label.resolvedColor(with: traits).withAlphaComponent(0.78)
    }
    static let disabled = UIColor.tertiaryLabel
    static let capsule = UIColor.tertiarySystemFill

    /// The ink for a pill: quiet only while it waits on something else.
    static func ink(for state: ComposerControlsModel.PillState) -> UIColor {
        state == .waiting ? disabled : enabled
    }
}

/// How a pill's text is laid out.
enum PillChipText {
    /// One line side by side. Stacked (the accessibility sizes) a catalog name
    /// wraps as far as it needs (the longest is "GPT-6 Astra", one line at AX5),
    /// and a raw model id stops at two lines, shortened in the middle.
    static func lineLimit(wraps: Bool, rawID: Bool) -> Int? {
        guard wraps else { return 1 }
        return rawID ? 2 : nil
    }

    /// The height of one line of the pill's font at a text size.
    static func oneLineHeight(_ size: DynamicTypeSize) -> CGFloat {
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))
        return UIFont.preferredFont(forTextStyle: .caption1, compatibleWith: traits).lineHeight
    }
}

/// A capsule while the pill is one line; once its text wraps, a rounded
/// rectangle with a fixed radius. A capsule around five lines was a 262x266pt
/// circle with the text spilling past its edge (gate r3 P2-3).
struct PillChipShape: Shape {
    /// The pill's height with one line of text; taller than about 1.5 times that
    /// means the text wrapped.
    var oneLineHeight: CGFloat
    static let wrappedCornerRadius: CGFloat = 14

    func path(in rect: CGRect) -> Path {
        if rect.height <= oneLineHeight * 1.5 { return Capsule().path(in: rect) }
        return RoundedRectangle(cornerRadius: Self.wrappedCornerRadius, style: .continuous).path(in: rect)
    }
}
