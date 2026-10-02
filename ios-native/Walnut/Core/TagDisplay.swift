import Foundation

// MARK: - How a task's tags show: the phone's twin of the server's rule set
//
// Ported from `src/core/tag-model.ts` + `src/core/tag-display-rules.ts`, which the
// server and the web console share. The phone reads the rules in force from
// `GET /api/v1/tasks/meta/tag-display` (`TagDisplayStore`) and compiles them here,
// so a pill reads the same on every surface:
//
//  - Every tag is key:value (`ticket:V1234567890`, `sev:2`). A plain word from an
//    older server is a label (`oncall` is `label:oncall`).
//  - Each tag shows WHOLE, as its VALUE only (`V1234567890`), or is HIDDEN.
//    Strongest first: Walnut's own `walnut:*` (always hidden), the user's rules,
//    plugin defaults (two plugins disagreeing: the quieter wins), Walnut's
//    defaults (`label:*` value, `created:*` / `updated:*` hidden). The exact tag
//    beats its key inside each layer.
//  - A tag may be a LINK: a template with `{value}`, the user's beating a plugin's
//    (the user's empty link turns a plugin's off).
//
// Walnut's own rules apply even when the read never answered (an older server,
// no network), so a pill never shows `label:` or a machine tag.

/// The tag model (`src/core/tag-model.ts`): normalization only, which is all the
/// phone needs (it never writes tags).
enum TagModel {
    static let labelKey = "label"
    static let derivedKeys: Set<String> = ["created", "updated"]
    /// Stored length, in UTF-16 units like the server's.
    static let maxLength = 200

    /// `[a-z0-9][a-z0-9._-]{0,63}`.
    static func isTagKey(_ key: String) -> Bool {
        let scalars = Array(key.unicodeScalars)
        guard (1...64).contains(scalars.count) else { return false }
        for (index, scalar) in scalars.enumerated() {
            let v = scalar.value
            let alnum = (0x61...0x7A).contains(v) || (0x30...0x39).contains(v)
            if !alnum && (index == 0 || !(v == 0x2E || v == 0x5F || v == 0x2D)) { return false }
        }
        return true
    }

    /// A tag in stored form, or nil for text with nothing in it. Control
    /// characters and whitespace runs fold to one space, the key is lowercased,
    /// and text with no usable key (or a derived one, unless `derived`) becomes
    /// a label.
    static func normalize(_ raw: String, derived: Bool = false) -> String? {
        let text = foldSpace(raw)
        guard !text.isEmpty else { return nil }
        // Scalars, not Characters: a combining mark after the colon would otherwise
        // merge with it into one Character and hide the key.
        let scalars = text.unicodeScalars
        if let colon = scalars.firstIndex(of: ":"), colon > scalars.startIndex {
            let key = String(scalars[..<colon]).trimmingCharacters(in: .whitespaces).lowercased()
            let value = String(scalars[scalars.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            if !value.isEmpty, isTagKey(key), derived || !derivedKeys.contains(key) {
                return clip("\(key):\(value)")
            }
        }
        let label = text.trimmingCharacters(in: CharacterSet(charactersIn: ": "))
        return label.isEmpty ? nil : clip("\(labelKey):\(label)")
    }

    /// The tag's key: the text before its first colon, when both sides have text.
    static func namespace(_ tag: String) -> String? {
        let scalars = tag.unicodeScalars
        guard let colon = scalars.firstIndex(of: ":"), colon > scalars.startIndex,
              scalars.index(after: colon) < scalars.endIndex else { return nil }
        return String(scalars[..<colon])
    }

    /// The tag's value: the text after its key, or the whole tag when it has none.
    static func value(_ tag: String) -> String {
        let scalars = tag.unicodeScalars
        guard namespace(tag) != nil, let colon = scalars.firstIndex(of: ":") else { return tag }
        return String(scalars[scalars.index(after: colon)...])
    }

    /// `[\u0000-\u001f\u007f]+` → space, then `\s+` → one space, then trim.
    private static func foldSpace(_ raw: String) -> String {
        var out = ""
        var pendingSpace = false
        for scalar in raw.unicodeScalars {
            let control = scalar.value < 0x20 || scalar.value == 0x7F
            if control || scalar.properties.isWhitespace {
                pendingSpace = true
                continue
            }
            if pendingSpace && !out.isEmpty { out.append(" ") }
            pendingSpace = false
            out.unicodeScalars.append(scalar)
        }
        return out
    }

    /// Cut to the stored length, never through a character, never leaving a space.
    private static func clip(_ tag: String) -> String {
        guard tag.utf16.count > maxLength else { return tag }
        var out = ""
        var units = 0
        for scalar in tag.unicodeScalars {
            let width = scalar.utf16.count
            if units + width > maxLength { break }
            units += width
            out.unicodeScalars.append(scalar)
        }
        while let last = out.unicodeScalars.last, last.properties.isWhitespace {
            out.unicodeScalars.removeLast()
        }
        return out
    }
}

/// One display rule as `GET /api/v1/tasks/meta/tag-display` lists it.
struct TagDisplayRule: Codable, Equatable {
    /// An exact tag, or `<key>:*`.
    let pattern: String
    /// `shown` | `value` | `hidden`; anything else is skipped when compiling.
    let display: String
    /// `builtin` | `default` | `user` | `plugin`.
    let source: String
    var pluginId: String? = nil
    var pluginName: String? = nil
}

/// One link rule: what a tag's pill opens.
struct TagLinkRule: Codable, Equatable {
    let pattern: String
    /// An http(s) URL with `{value}`; the user's `""` takes a plugin's away.
    let link: String
    /// `user` | `plugin`.
    let source: String
    var pluginId: String? = nil
    var pluginName: String? = nil
}

/// The endpoint's whole answer. Decoded leniently: one malformed rule costs that
/// rule, never the set (a thrown decode would fall back to Walnut's rules only).
struct TagDisplayState: Codable, Equatable {
    var rules: [TagDisplayRule]
    var links: [TagLinkRule]

    init(rules: [TagDisplayRule], links: [TagLinkRule] = []) {
        self.rules = rules
        self.links = links
    }

    private enum CodingKeys: String, CodingKey { case rules, links }

    private struct Lossy<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        rules = try container.decode([Lossy<TagDisplayRule>].self, forKey: .rules).compactMap(\.value)
        links = (try? container.decodeIfPresent([Lossy<TagLinkRule>].self, forKey: .links))??.compactMap(\.value) ?? []
    }

    /// What applies with no answer from the server: Walnut's own rules.
    static let walnutOnly = TagDisplayState(rules: TagDisplayRules.builtin + TagDisplayRules.defaults)
}

enum TagDisplayMode: String {
    case shown, value, hidden

    /// hidden, then value, then shown: between two plugins the quieter wins.
    var quietness: Int {
        switch self {
        case .shown: 0
        case .value: 1
        case .hidden: 2
        }
    }
}

/// The pattern helpers and link templates (`src/core/tag-display-rules.ts`).
enum TagDisplayRules {
    static let machineNamespace = "walnut"
    static let builtin = [TagDisplayRule(pattern: "walnut:*", display: "hidden", source: "builtin")]
    static let defaults = [
        TagDisplayRule(pattern: "label:*", display: "value", source: "default"),
        TagDisplayRule(pattern: "created:*", display: "hidden", source: "default"),
        TagDisplayRule(pattern: "updated:*", display: "hidden", source: "default"),
    ]

    private static let namespaceSuffix = ":*"
    private static let valueSlot = "{value}"
    private static let maxPatternLength = 200
    private static let maxLinkLength = 500

    /// The key a `<key>:*` pattern names, else nil (an exact tag).
    static func patternNamespace(_ pattern: String) -> String? {
        guard pattern.hasSuffix(namespaceSuffix) else { return nil }
        let key = String(pattern.dropLast(namespaceSuffix.count))
        return !key.isEmpty && !key.contains(":") ? key : nil
    }

    /// A rule key in stored form, or nil.
    static func normalizePattern(_ raw: String) -> String? {
        let pattern = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !pattern.isEmpty, pattern.utf16.count <= maxPatternLength, !hasControl(pattern) else { return nil }
        if pattern.hasSuffix(namespaceSuffix) {
            guard let key = patternNamespace(pattern)?.trimmingCharacters(in: .whitespaces).lowercased(),
                  TagModel.isTagKey(key) else { return nil }
            return key + namespaceSuffix
        }
        return TagModel.normalize(pattern, derived: true)
    }

    /// A link template in stored form (`""` = no link), or nil when it is not one.
    static func normalizeLink(_ raw: String) -> String? {
        let link = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if link.isEmpty { return "" }
        guard link.utf16.count <= maxLinkLength, link.contains(valueSlot),
              !link.unicodeScalars.contains(where: { $0.properties.isWhitespace || $0.value < 0x20 || $0.value == 0x7F }),
              let url = URL(string: link.replacingOccurrences(of: valueSlot, with: "v")),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host, !host.isEmpty
        else { return nil }
        return link
    }

    /// The URL a tag's pill opens: its value, URL-encoded like `encodeURIComponent`,
    /// in every `{value}`.
    static func href(_ template: String, tag: String) -> URL? {
        guard !template.isEmpty else { return nil }
        let value = TagModel.value(tag).addingPercentEncoding(withAllowedCharacters: uriComponentAllowed) ?? ""
        return URL(string: template.replacingOccurrences(of: valueSlot, with: value))
    }

    static func isMachinePattern(_ pattern: String) -> Bool {
        (patternNamespace(pattern) ?? TagModel.namespace(pattern)) == machineNamespace
    }

    /// `encodeURIComponent`'s unescaped set: A-Z a-z 0-9 - _ . ! ~ * ' ( ).
    private static let uriComponentAllowed: CharacterSet = {
        var set = CharacterSet()
        set.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return set
    }()

    private static func hasControl(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
    }
}

/// One pill a task draws.
struct TagPill: Identifiable, Equatable {
    /// The whole tag (the accessibility label, and what Copy copies).
    let tag: String
    /// What the pill reads: the whole tag, or only its value.
    let text: String
    /// What the pill opens, if anything.
    let url: URL?
    var id: String { tag }
}

/// A rule list indexed once, so a sheet of tags asks per tag in constant time.
struct CompiledTagDisplay {
    private struct Layer<Rule> {
        var exact: [String: Rule] = [:]
        var namespace: [String: Rule] = [:]

        func find(_ tag: String, _ key: String?) -> Rule? {
            exact[tag] ?? key.flatMap { namespace[$0] }
        }
    }

    private var user = Layer<TagDisplayRule>()
    private var plugin = Layer<TagDisplayRule>()
    private var walnut = Layer<TagDisplayRule>()
    private var userLinks = Layer<TagLinkRule>()
    private var pluginLinks = Layer<TagLinkRule>()

    init(_ state: TagDisplayState) {
        for rule in TagDisplayRules.defaults {
            Self.place(&walnut, rule, pattern: rule.pattern, quieterWins: false)
        }
        for rule in state.rules where rule.source == "user" || rule.source == "plugin" {
            guard let pattern = TagDisplayRules.normalizePattern(rule.pattern),
                  !TagDisplayRules.isMachinePattern(pattern),
                  TagDisplayMode(rawValue: rule.display) != nil else { continue }
            // One user rule per pattern (the last one read wins); among plugins, the quieter wins.
            if rule.source == "user" {
                Self.place(&user, rule, pattern: pattern, quieterWins: false)
            } else {
                Self.place(&plugin, rule, pattern: pattern, quieterWins: true)
            }
        }
        for rule in state.links where rule.source == "user" || rule.source == "plugin" {
            guard let pattern = TagDisplayRules.normalizePattern(rule.pattern),
                  !TagDisplayRules.isMachinePattern(pattern),
                  let link = TagDisplayRules.normalizeLink(rule.link),
                  !(link.isEmpty && rule.source != "user") else { continue }
            let key = TagDisplayRules.patternNamespace(pattern)
            let stored = TagLinkRule(pattern: pattern, link: link, source: rule.source,
                                     pluginId: rule.pluginId, pluginName: rule.pluginName)
            if rule.source == "user" {
                if let key { userLinks.namespace[key] = stored } else { userLinks.exact[pattern] = stored }
            } else {
                // Between plugins, the first one set stays.
                if let key { if pluginLinks.namespace[key] == nil { pluginLinks.namespace[key] = stored } }
                else if pluginLinks.exact[pattern] == nil { pluginLinks.exact[pattern] = stored }
            }
        }
    }

    private static func place(_ layer: inout Layer<TagDisplayRule>, _ rule: TagDisplayRule, pattern: String, quieterWins: Bool) {
        let key = TagDisplayRules.patternNamespace(pattern)
        let existing: TagDisplayRule? = if let key { layer.namespace[key] } else { layer.exact[pattern] }
        if quieterWins, let existing,
           let was = TagDisplayMode(rawValue: existing.display), let now = TagDisplayMode(rawValue: rule.display),
           was.quietness >= now.quietness { return }
        let stored = TagDisplayRule(pattern: pattern, display: rule.display, source: rule.source,
                                    pluginId: rule.pluginId, pluginName: rule.pluginName)
        if let key { layer.namespace[key] = stored } else { layer.exact[pattern] = stored }
    }

    /// The rule that decided, or nil (the tag shows whole by default).
    func ruleFor(_ tag: String) -> TagDisplayRule? {
        let key = TagModel.namespace(tag)
        if key == TagDisplayRules.machineNamespace { return TagDisplayRules.builtin[0] }
        return user.find(tag, key) ?? plugin.find(tag, key) ?? walnut.find(tag, key)
    }

    func display(_ tag: String) -> TagDisplayMode {
        ruleFor(tag).flatMap { TagDisplayMode(rawValue: $0.display) } ?? .shown
    }

    /// The link rule that decided, the user's empty one included.
    func linkRuleFor(_ tag: String) -> TagLinkRule? {
        let key = TagModel.namespace(tag)
        if key == TagDisplayRules.machineNamespace { return nil }
        return userLinks.find(tag, key) ?? pluginLinks.find(tag, key)
    }

    /// The URL the tag's pill opens, or nil.
    func linkFor(_ tag: String) -> URL? {
        linkRuleFor(tag).flatMap { TagDisplayRules.href($0.link, tag: tag) }
    }

    /// A task's tags as pills, in order, each once: the shown ones, and the hidden
    /// ones (which a detail view may still reveal on request).
    func pills(for tags: [String]?) -> (shown: [TagPill], hidden: [TagPill]) {
        var shown: [TagPill] = []
        var hidden: [TagPill] = []
        var seen = Set<String>()
        for raw in tags ?? [] {
            guard let tag = TagModel.normalize(raw, derived: true), seen.insert(tag).inserted else { continue }
            switch display(tag) {
            case .hidden:
                hidden.append(TagPill(tag: tag, text: tag, url: linkFor(tag)))
            case .value:
                shown.append(TagPill(tag: tag, text: TagModel.value(tag), url: linkFor(tag)))
            case .shown:
                shown.append(TagPill(tag: tag, text: tag, url: linkFor(tag)))
            }
        }
        return (shown, hidden)
    }
}
