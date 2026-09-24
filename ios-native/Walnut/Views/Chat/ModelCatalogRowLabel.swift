import Foundation

/// The model menu's row labels, spelled EXACTLY as the web picker spells them.
///
/// The Mac's picker names rows with `catalogRowLabel`
/// (`web/src/components/sessions/ModelPicker.tsx`) over `formatModelName`
/// (`web/src/utils/model-name.ts`). The phone used the catalog's bare `label`,
/// so the same catalog read "Fable", "Opus 5.5 (1M context)", "Haiku" on the
/// phone and "Fable 5 1M", "Opus 5.5 1M", "Haiku 4.5" on the Mac. These are line
/// for line twins of those two functions; keep them in step, and pin any change
/// with the golden table in `ModelCatalogRowLabelTests`, whose expected strings
/// were produced by running the web functions themselves.
///
/// `WalnutSession.shortModelName` is NOT a twin (it drops the " 1M" suffix and
/// reads versions differently), which is why it still names the pill but never
/// a menu row.
enum ModelCatalogRowLabel {

    /// `catalogRowLabel`: the versioned name derived from `resolvedModel ?? id`
    /// when one is derivable; the `default` row says what it resolves to; every
    /// other row falls back to the catalog's own label.
    ///
    /// A primary that predates `resolvedModel` still gets this rule over `id`,
    /// which is what the web does with such a row: versioned ids keep their
    /// version, and alias rows (`default`, `opus`, `haiku`) keep their label.
    static func label(for row: SessionModelOptions.Model) -> String {
        let derived = formatModelName(row.resolvedModel ?? row.id)
        let versioned = isVersionedFamily(derived) ? derived : nil
        if row.id == "default" {
            if let versioned { return "Default (\(versioned))" }
            return row.label.isEmpty ? "Default" : row.label
        }
        return versioned ?? row.label
    }

    /// `/^(Opus|Sonnet|Haiku|Fable) \d/`
    private static func isVersionedFamily(_ name: String) -> Bool {
        for family in ["Opus ", "Sonnet ", "Haiku ", "Fable "] where name.hasPrefix(family) {
            let rest = name.dropFirst(family.count)
            if let first = rest.first, first.isASCII, first.isNumber { return true }
        }
        return false
    }

    /// `formatModelName`, step for step (including its quirks: a dated id such
    /// as "opus-4-20250514" reads "Opus 4.20250514" there, so it does here).
    static func formatModelName(_ model: String?) -> String {
        guard let model, !model.isEmpty else { return "" }
        let lower = model.lowercased()
        let family: String
        if lower.contains("opus") { family = "Opus" }
        else if lower.contains("sonnet") { family = "Sonnet" }
        else if lower.contains("haiku") { family = "Haiku" }
        else if lower.contains("fable") { family = "Fable" }
        else if lower.hasPrefix("gpt-") { return gptName(model) }
        else { return model }
        let suffix = lower.contains("[1m]") ? " 1M" : ""
        if let groups = firstMatch(versionPattern, in: lower), groups.count == 2 {
            return "\(family) \(groups[0]).\(groups[1])\(suffix)"
        }
        if let groups = firstMatch(majorPattern, in: lower), groups.count == 1 {
            return "\(family) \(groups[0])\(suffix)"
        }
        return "\(family)\(suffix)"
    }

    /// The `gpt-` branch: first part upper-cased, the rest capitalised, joined by
    /// "-", then a "-" before a capitalised word becomes a space ("GPT-6 Astra").
    private static func gptName(_ model: String) -> String {
        let joined = model.split(separator: "-", omittingEmptySubsequences: false)
            .enumerated()
            .map { index, part in
                index == 0 ? part.uppercased() : part.prefix(1).uppercased() + part.dropFirst()
            }
            .joined(separator: "-")
        let range = NSRange(joined.startIndex..., in: joined)
        return wordBreak.stringByReplacingMatches(in: joined, range: range, withTemplate: " ")
    }

    // `[0-9]`, not `\d`: JavaScript's `\d` is ASCII-only, NSRegularExpression's is not.
    private static let versionPattern = try! NSRegularExpression(
        pattern: "(?:opus|sonnet|haiku|fable)-([0-9]+)-([0-9]+)"
    )
    private static let majorPattern = try! NSRegularExpression(
        pattern: "(?:opus|sonnet|haiku|fable)-([0-9]+)"
    )
    private static let wordBreak = try! NSRegularExpression(pattern: "-(?=[A-Z][a-z])")

    private static func firstMatch(_ pattern: NSRegularExpression, in text: String) -> [String]? {
        let range = NSRange(text.startIndex..., in: text)
        guard let match = pattern.firstMatch(in: text, range: range) else { return nil }
        return (1..<match.numberOfRanges).compactMap { index in
            Range(match.range(at: index), in: text).map { String(text[$0]) }
        }
    }

    // MARK: - The menu's rows, in the Mac's order

    /// One row of the model menu.
    struct Row: Equatable {
        enum Kind: Equatable {
            /// A catalog row: pickable.
            case catalog
            /// The model the conversation runs, which the catalog does not list
            /// (a custom proxy model, a retired id). Shown checked and NOT
            /// pickable, exactly like the web's `current` row: the truth is
            /// displayed even when it can't be chosen again.
            case current
        }
        var kind: Kind
        /// The catalog row id, or the raw model for a `current` row.
        var id: String
        var title: String
        var checked: Bool
    }

    /// The web's live-session row list (`claudeModelRows`, ModelPicker.tsx
    /// 626-644): the catalog plus a `current` row when the running model matches
    /// no catalog row, sorted with `sortByModelStrength` on the same text the web
    /// sorts on. The web's third kind, the `auto` row, exists only in a DRAFT's
    /// picker (a launch that has not picked a model yet); a composer pill always
    /// belongs to a conversation that has a model, so it never has one.
    static func menuRows(models: [SessionModelOptions.Model], currentModelID: String?) -> [Row] {
        let active = activeRow(in: models, for: currentModelID)
        var rows: [(row: Row, text: String)] = []
        if let currentModelID, !currentModelID.isEmpty, active == nil {
            rows.append((
                Row(kind: .current, id: currentModelID, title: shortModelLabel(currentModelID), checked: true),
                currentModelID
            ))
        }
        for model in models {
            let title = label(for: model)
            rows.append((
                Row(kind: .catalog, id: model.id, title: title, checked: model.id == active?.id),
                "\(model.id) \(model.resolvedModel ?? "") \(title)"
            ))
        }
        return ModelStrengthOrder.sorted(rows, text: \.text).map(\.row)
    }

    /// `matchSessionModelCatalogEntry` (src/core/types.ts): which catalog row a
    /// runtime model id is. The order is the server's and is load-bearing: exact
    /// id, then a concrete row by `resolvedModel`, then `default` by it (a
    /// concrete row must beat the `default` alias sharing its resolved model),
    /// then the same three compared without `[1m]` and provider version suffixes.
    static func activeRow(
        in models: [SessionModelOptions.Model], for model: String?
    ) -> SessionModelOptions.Model? {
        guard let model, !model.isEmpty else { return nil }
        if let exact = models.first(where: { $0.id == model }) { return exact }
        if let resolved = models.first(where: { $0.id != "default" && $0.resolvedModel == model }) {
            return resolved
        }
        if let alias = models.first(where: { $0.id == "default" && $0.resolvedModel == model }) {
            return alias
        }
        let needle = normalizedID(model)
        return models.first { row in
            normalizedID(row.id) == needle || row.resolvedModel.map { normalizedID($0) == needle } == true
        }
    }

    /// `normalizeSessionModelCatalogId`: lower case, no trailing `[1m]`, no
    /// trailing provider version (`-v1`, `-v1:0`).
    static func normalizedID(_ model: String) -> String {
        var id = model.lowercased()
        if id.hasSuffix("[1m]") { id.removeLast(4) }
        let range = NSRange(id.startIndex..., in: id)
        return providerVersion.stringByReplacingMatches(in: id, range: range, withTemplate: "")
    }

    private static let providerVersion = try! NSRegularExpression(pattern: "[-_]v[0-9]+(:[0-9]+)?$")

    /// The web's `shortModelLabel` (ModelPicker.tsx:224-229), which names the
    /// `current` row: the id after `….claude-`, without a provider version,
    /// with `[1m]` spelled " 1M".
    static func shortModelLabel(_ raw: String) -> String {
        guard !raw.isEmpty else { return raw }
        let is1M = raw.contains("[1m]")
        var short = raw
        short = replacing(claudePrefix, in: short)
        short = replacing(versionTail, in: short)
        short = short.replacingOccurrences(of: "[1m]", with: "")
        return short + (is1M ? " 1M" : "")
    }

    private static let claudePrefix = try! NSRegularExpression(pattern: "^.*\\.claude-")
    private static let versionTail = try! NSRegularExpression(pattern: "[-_]v[0-9]+.*$")

    private static func replacing(_ pattern: NSRegularExpression, in text: String) -> String {
        pattern.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
    }
}
