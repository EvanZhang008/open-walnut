import Foundation

/// Swift twin of the web picker's `sortByModelStrength`
/// (`web/src/utils/model-strength-order.ts`): the Mac lists a catalog weakest to
/// strongest, and the phone lists it in the same order. Ported rule for rule,
/// patterns included, so `ModelStrengthOrderTests` can hold both to the same
/// output on the real catalog.
///
/// Known provider tier names get an explicit product order; versions and context
/// sizes break ties inside a tier; names with no known tier keep their source
/// order and go last, because a capability can't be read from an arbitrary id.
enum ModelStrengthOrder {
    struct Key: Equatable {
        var tier: Int
        var versionMajor: Int
        var versionMinor: Int
        var context: Int
        var defaultAlias: Int
    }

    /// The web's `/…/i` patterns. `[0-9]` where the web writes `\d`: JavaScript's
    /// `\d` is ASCII-only, NSRegularExpression's is not.
    private static func pattern(_ source: String) -> NSRegularExpression {
        // Literal patterns: a typo fails the first test run, not a user.
        try! NSRegularExpression(pattern: source, options: [.caseInsensitive])
    }

    private static let tiers: [(rank: Int, pattern: NSRegularExpression)] = [
        (10, pattern(#"\b(?:flash[\s._-]*lite|nano|haiku)\b"#)),
        (20, pattern(#"\b(?:flash|mini|small|luna)\b"#)),
        (30, pattern(#"\b(?:sonnet|terra)\b"#)),
        (40, pattern(#"\bfable\b"#)),
        (50, pattern(#"\bsol\b"#)),
        (60, pattern(#"\b(?:large|plus|pro)\b"#)),
        (70, pattern(#"\b(?:max|opus|ultra)\b"#)),
    ]
    private static let baseTier = pattern(#"\b(?:gpt|gemini|qwen|glm|kimi|minimax)\b"#)
    private static let version = pattern(
        #"\b(?:claude|haiku|sonnet|fable|sol|opus|gpt|gemini|qwen|glm|kimi|minimax)[\s._:/-]*([0-9]+)(?:[._-]([0-9]+))?"#
    )
    private static let context = pattern(#"(?:\[|\(|[\s._-])1m(?:\]|\)|\b)"#)
    private static let defaultAlias = pattern(#"\b(?:auto|default)\b"#)

    private static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
        regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    /// nil = no known tier (sorts last, in source order).
    static func key(_ value: String) -> Key? {
        let tier = tiers.first(where: { matches($0.pattern, value) })?.rank
            ?? (matches(baseTier, value) ? 35 : nil)
        guard let tier else { return nil }
        var major = 0
        var minor = 0
        if let match = version.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) {
            major = group(match, 1, in: value) ?? 0
            minor = group(match, 2, in: value) ?? 0
        }
        return Key(
            tier: tier, versionMajor: major, versionMinor: minor,
            context: matches(context, value) ? 1 : 0,
            defaultAlias: matches(defaultAlias, value) ? 0 : 1
        )
    }

    private static func group(_ match: NSTextCheckingResult, _ index: Int, in value: String) -> Int? {
        let range = match.range(at: index)
        guard range.location != NSNotFound, let swiftRange = Range(range, in: value) else { return nil }
        return Int(value[swiftRange])
    }

    /// Lower to higher capability; `text` is what the web sorts each row on.
    static func sorted<T>(_ values: [T], text: (T) -> String) -> [T] {
        let keyed = values.enumerated().map { (index: $0.offset, value: $0.element, key: key(text($0.element))) }
        return keyed.sorted { a, b in
            switch (a.key, b.key) {
            case (nil, nil): return a.index < b.index
            case (nil, _): return false
            case (_, nil): return true
            case let (ka?, kb?):
                if ka.tier != kb.tier { return ka.tier < kb.tier }
                if ka.versionMajor != kb.versionMajor { return ka.versionMajor < kb.versionMajor }
                if ka.versionMinor != kb.versionMinor { return ka.versionMinor < kb.versionMinor }
                if ka.context != kb.context { return ka.context < kb.context }
                if ka.defaultAlias != kb.defaultAlias { return ka.defaultAlias < kb.defaultAlias }
                return a.index < b.index
            }
        }.map(\.value)
    }
}
