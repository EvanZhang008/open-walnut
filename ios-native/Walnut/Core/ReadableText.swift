import SwiftUI
import UIKit

/// Text colours for content that has to stay SUBORDINATE without going
/// unreadable.
///
/// WHY THIS EXISTS: `.secondary` and `.tertiary` are the SwiftUI defaults for
/// "quieter than the body text", and neither reaches WCAG AA (4.5:1) on the
/// backgrounds Walnut draws them on. Measured on the phone: the live activity
/// row — the tool name the user asked to be able to see — shimmered between
/// 1.85:1 and 3.39:1, and the expanded tool card's INPUT/RESULT labels came out
/// at 1.70:1 light and 2.48:1 dark. Subordinate is a job for SIZE and WEIGHT;
/// spending contrast on it is how a label becomes decoration.
///
/// The colour is the design system's readable grey (`Theme.secondaryOnCard`), so a
/// quiet line reads the same everywhere; it clears 4.5:1 on all three surfaces these
/// rows sit on (`systemBackground`, `secondarySystemBackground`, a `tertiarySystemFill`
/// chip) in both light and dark. `ReadableTextContrastTests` pins that.
enum ReadableText {
    /// The quiet-but-readable text colour.
    static let secondary = Theme.secondaryOnCard

    /// Same colour as UIKit, for the tests and for attributed-string call sites.
    static let secondaryUIColor = Theme.secondaryOnCardColor

    /// Dim end of a "still working" shimmer.
    ///
    /// Deliberately shallow, and deliberately applied to a DECORATIVE glyph
    /// only. The version this replaces faded the whole row (text included) to
    /// 0.35, which is what put the tool name at 1.85:1 for half of every 1.8s
    /// cycle. At this floor the glyph still clears the 3:1 non-text minimum in
    /// both appearances, so the row never has an unreadable half-second.
    static let shimmerFloor: Double = 0.75
}
