import Foundation

/// The ASCII test that every accessibility identifier in this app is folded
/// through.
///
/// It exists as ONE definition because it was written twice, wrong, in two places:
/// `TaskBoardList.slug` and `BoardModel.railLetter` both used
/// `Character.isLetter || Character.isNumber`, which is UNICODE-aware and
/// therefore answers TRUE for CJK ideographs, accented Latin, and non-ASCII digit
/// scripts. A project named in Chinese sailed straight through both folds and
/// produced ids like `board.heading.proj_<CJK>` and `board.rail.<CJK>`, breaking
/// the repo rule that identifiers stay inside [A-Za-z0-9._-] because automation
/// (maestro / XCUITest) matches them as REGEXES. The folds looked correct and kept
/// exactly the characters they existed to remove (2026-08-29 review).
///
/// `isASCII` is checked FIRST and is what makes this narrow; `isLetter`/`isNumber`
/// then only ever see a single ASCII scalar, where their Unicode reach cannot
/// reintroduce anything.
extension Character {
    /// True only for `A-Z`, `a-z`, `0-9`.
    var isASCIILetterOrDigit: Bool {
        isASCII && (isLetter || isNumber)
    }
}
