import SwiftUI

/// The ink a text field's PLACEHOLDER is drawn in, and the modifier that draws it.
///
/// # Why this exists instead of `TextField("Add a task…", text:)`
///
/// A `TextField`'s label is drawn by the platform in `UIColor.placeholderText`, which is
/// `label` at 30% alpha. Over the card these fields sit on
/// (`secondarySystemGroupedBackground`) that measured **2.48:1 in dark mode** off a real
/// screenshot, and about **1.7:1 in light** (same 30% alpha, over white) — both far under
/// WCAG AA's 4.5:1, and light is the worse of the two even though dark is the one that
/// gets noticed. Apple's own placeholders fail the same way, so this is not a bug in one
/// of our fields; it is the platform default, and a field whose placeholder is only
/// decoration could live with it.
///
/// Ours cannot, because the placeholder is the only thing that says WHERE the typed task
/// will go: the calendar's reads "Add task on Tuesday…". That is
/// load-bearing information presented as text, so it is held to the text bar.
///
/// # The numbers, and why they are stated per scheme
///
/// Measured against `BoardBandCard.surfaceColor` (the card, not the page — these rows are
/// inset-grouped cells): light **5.05:1**, dark **5.93:1**, with the increased-contrast
/// variants at **6.83:1** and **8.06:1**. Headroom over 4.5 is deliberate: the same ink
/// is used on the page's own background in a couple of places, which is a slightly
/// different paper. `FieldPlaceholderContrastTests` resolves the pair per scheme and
/// asserts the ratio; the two normal-contrast numbers were then read back off real
/// screenshots of the board — light ink `(110,110,118)` on `(255,255,255)`, dark
/// `(152,152,158)` on `(28,28,30)` — so the value under test is the value that ships.
///
/// A placeholder at 4.5:1 is still obviously a placeholder: entered text is `label`
/// (black on white / white on near-black), which is 3-4× further from the paper again.
enum FieldPlaceholder {

    /// The dynamic ink, kept with the other colours in `Theme.placeholderInkColor`. Four
    /// values, because `accessibilityContrast == .high` is a request for exactly this and
    /// answering it costs two lines: light (110,110,118), boosted (90,90,98); dark
    /// (152,152,158), boosted (178,178,184).
    static let inkColor = Theme.placeholderInkColor

    /// `inkColor` as a SwiftUI colour.
    static let ink = Color(inkColor)
}

extension View {
    /// Draw `text` as this field's placeholder in `FieldPlaceholder.ink`, in place of the
    /// platform's. Apply to the `TextField` itself, and give the field an EMPTY label.
    ///
    /// Three details that are easy to get wrong and each cost something real:
    ///
    ///  - The overlay is `accessibilityHidden` and the FIELD takes the label, so the
    ///    string appears exactly once in the accessibility tree. Two elements carrying
    ///    "Add a task…" would make automation's first match a decoration.
    ///  - No `font` here: the overlay inherits the same environment font the field does,
    ///    so a caller that restyles the row cannot desynchronise the two.
    ///  - `allowsHitTesting(false)` — an overlay above a text field swallows the tap that
    ///    is supposed to focus it.
    func fieldPlaceholder(_ text: String, showing: Bool) -> some View {
        overlay(alignment: .leading) {
            if showing {
                Text(text)
                    .foregroundStyle(FieldPlaceholder.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityLabel(text)
    }
}
