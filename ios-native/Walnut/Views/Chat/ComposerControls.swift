import SwiftUI

/// The composer's model control: ONE pill naming the model and its effort
/// ("Opus 5 · High"). It sits in the input row, next to the message it
/// configures, after the mode pill (`ComposerModePill`), in the web composer's
/// order.
///
/// Why the model lives HERE and not in a settings sheet: this mirrors the web
/// console's decision, quoted from `DraftLaunchBar.tsx` ("the model belongs with
/// the message, so the draft renders it inside the composer's controls row,
/// exactly where a real session's model pill sits"). The desktop's session
/// composer and its main-agent composer (`LaneComposerControls.tsx`) both put the
/// model pill in the controls row, with the effort inside the same pill; the
/// phone matches (user, 2026-10-04: one pill, not a model pill and an effort pill).
///
/// A tap opens "Select model" (`PillMenuSheet`), the Claude app's picker: the
/// models as one vertical list, and an "Effort" row that opens the levels as
/// another (user, 2026-10-04: a drawer, every list vertical). It offers only the
/// levels the CURRENT model declares, and no Effort row for a model without an
/// effort axis. The sheet opens on one tap with the keyboard up too.
///
/// What is deliberately NOT in this row (a 44pt row is not a settings screen):
///  - Path/host are not in a live session's composer at all: they are facts of a
///    running CLI, and belong to session CREATION (see NewSessionChatView).
///  - Side questions, the session note and fork are in the `+` menu.
///
/// The mode pill is a UIKit button menu (`PillMenuButton`), so UIKit places it
/// (it can never overflow the screen). With the keyboard up, a tap on it puts
/// the keyboard away and the next tap opens the menu: there is no room above a
/// pill that sits on the keyboard.
///
/// Text size: at the accessibility sizes the name wraps instead of truncating
/// (gate r2 D2: "GPT-6 Astra" read "GP…" at AX5, and a name the user cannot read
/// is not a control).
struct ComposerModelPill: View {
    @State var controls: ComposerControlsModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// The model picker's title, the Claude app's.
    static let sheetTitle = "Select model"

    var body: some View {
        // Nothing known yet (still loading, or an engine with no switchable
        // session): no pill rather than one that lies or a spinner that draws
        // the eye to a control the user did not ask about.
        if let label = controls.combinedPillLabel {
            PillChip(
                text: label,
                // The name is the LAST KNOWN one while unreachable, so the pill
                // itself says so rather than only the menu: a stale value that
                // looks live is the failure that state exists to avoid.
                glyph: controls.unreachable ? .warning : (controls.readOnly ? .none : .chevron),
                state: controls.combinedPillState,
                wraps: dynamicTypeSize.isAccessibilitySize,
                rawID: controls.pillLabelIsRawID,
                menu: controls.combinedMenu,
                menuID: "model",
                accessibilityID: "composer.modelPill",
                accessibilityLabel: controls.pillAccessibilityLabel,
                accessibilityValue: controls.pillAccessibilityValue,
                onSelect: { choice, token in controls.menuSelect(choice, token: token) },
                onPresentedChange: { id, presented in controls.setMenuPresented(presented, menu: id) },
                sheetTitle: Self.sheetTitle
            )
        }
    }
}

/// The permission-mode pill of a live composer (a coding session, or the main
/// chat's lane session): the session's own mode control, read and written
/// through `/sessions/:id/controls`, the same channel the web's mode pill and the
/// Session Controls sheet use.
///
/// Always in the row once the composer has a session to set a mode on, so it
/// never comes and goes: "Mode", quiet, until the first answer; the last known
/// mode, read-only, while the Mac is away; "Mode" with a warning and a Retry
/// when the mode could not be read at all.
struct ComposerModePill: View {
    let mode: ComposerModeModel
    /// The Mac (or the box) can't be reached right now: the model pill says so,
    /// and this pill keeps the last known mode without offering a pick.
    var away = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let label = mode.label ?? ComposerModeModel.placeholderLabel
        let failed = mode.label == nil && mode.loadFailure != nil
        PillChip(
            text: label,
            glyph: away ? .none : (failed ? .warning : .chevron),
            state: away ? .lastKnown : mode.pillState,
            wraps: dynamicTypeSize.isAccessibilitySize,
            rawID: false,
            menu: mode.menu,
            menuID: "mode",
            accessibilityID: "composer.modePill",
            accessibilityLabel: mode.label.map { "Permission mode: \($0)" } ?? "Permission mode",
            accessibilityValue: away && mode.label != nil ? "last known" : nil,
            onSelect: { choice, _ in mode.menuSelect(choice) },
            onPresentedChange: { _, _ in }
        )
    }
}

/// One capsule: the SwiftUI label the user sees, with the UIKit button that owns
/// its menu laid exactly over it (see `PillMenuButton` for why the menu is UIKit).
/// Shared by every pill on a composer's bottom row (mode, model), live or draft,
/// so they all look and open the same way; the owner answers the taps.
struct PillChip: View {
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
    var accessibilityValue: String? = nil
    /// A row was tapped (with the token of the menu it was on).
    let onSelect: (PillMenu.Choice, ComposerControlsModel.MenuToken) -> Void
    /// The menu opened or closed (`menuID`, open).
    let onPresentedChange: (String, Bool) -> Void
    /// Set = the pill opens its menu as a sheet with this title (the model
    /// pill's "Select model", see `PillMenuSheet`) instead of a UIKit menu.
    var sheetTitle: String? = nil
    @State private var pressed = false
    @State private var sheetShown = false
    @State private var sheetFocus = PillSheetFocus()
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
            if let sheetTitle {
                PillSheetButton(
                    accessibilityID: accessibilityID,
                    accessibilityLabel: accessibilityLabel,
                    accessibilityValue: accessibilityValue,
                    focus: sheetFocus,
                    onTap: { openSheet() },
                    onHighlightChange: { pressed = $0 }
                )
                .disabled(!state.takesTaps)
                .sheet(isPresented: $sheetShown, onDismiss: sheetClosed) {
                    PillMenuSheet(title: sheetTitle, menu: menu, onSelect: onSelect)
                        .presentationDetents([.large])
                        .presentationDragIndicator(.visible)
                }
            } else {
                PillMenuButton(
                    menu: menu,
                    accessibilityID: accessibilityID,
                    accessibilityLabel: accessibilityLabel,
                    accessibilityValue: accessibilityValue,
                    menuID: menuID,
                    menuClearance: menuClearance,
                    onSelect: onSelect,
                    onPresentedChange: onPresentedChange,
                    onHighlightChange: { pressed = $0 }
                )
                // SwiftUI writes this onto the UIButton's `isEnabled` after every
                // update, so it is the ONLY way to disable it (see PillMenuButton).
                .disabled(!state.takesTaps)
            }
        }
        // A pill torn down with its sheet up (the composer switched source) never
        // gets the dismiss call, and the model would hold every answer forever.
        .onDisappear {
            if sheetShown { onPresentedChange(menuID, false) }
        }
    }

    /// The sheet counts as open from the tap: while it is up the model holds
    /// every answer, so its rows never change under the finger.
    private func openSheet() {
        guard !sheetShown else { return }
        AppLog.info("chat", "composer pill: sheet opened", ["menu": menuID])
        onPresentedChange(menuID, true)
        sheetShown = true
    }

    private func sheetClosed() {
        AppLog.info("chat", "composer pill: sheet closed", ["menu": menuID])
        onPresentedChange(menuID, false)
        sheetFocus.giveBack()
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
