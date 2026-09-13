import Foundation

/// The ONE place the activity drawer reaches the network for a row's WHOLE text.
///
/// WHY IT EXISTS: the list payloads are deliberately slim — a reasoning block
/// arrives clipped at 2,000 characters and a tool result at 700, both marked with
/// a trailing "…" — because those rows ride a read the phone polls and the cloud
/// bridge caps at 1MB. So the drawer, which is the surface whose whole job is
/// "show me all of it", has to ask for the rest on demand.
///
/// Contract (server-side, `GET /api/v1/activity/detail`):
///  - `ref` is an OPAQUE token the row carries (`detailRef`). Never parse it, and
///    never build one: a row without a ref means the excerpt IS the whole text,
///    which is also what an older PRIMARY reports until it carries the field. That
///    is the NORMAL case, not a failure — the drawer shows what it holds and offers
///    no fetch at all.
///  - A thinking row answers with `text`; a tool row answers with `input` and
///    `result` as separate sections, both in one response.
///  - `*Chars` is the length of the string DELIVERED when a section is whole, and a
///    source-based estimate when it is not — so on a section carrying everything the
///    numbers match and nothing is claimed to be missing. It stopped being "the
///    total the server holds" when redaction made the delivered text shorter than
///    its source and the footer started announcing withheld characters on a row that
///    was entirely on screen.
///  - `*Chars` AND `offset` COUNT UTF-16 CODE UNITS, not Characters: the server
///    measures with JavaScript's `string.length`. Anything on this side that compares
///    with them, prints them, or sends one back has to say `utf16.count` — see
///    `TimelineDrawerSection` for what comparing against `String.count` did.
///  - `*Truncated` is the authority on completeness; nothing derives it by comparing
///    numbers any more. `*NextOffset` means "asking again advances", and a truncated
///    section can legitimately have none (the remainder is unreachable).
///  - Every section is redacted at full length by the same masker the previews
///    use, so a secret stays `[REDACTED]` here too.
enum TimelineActivityFullText {
    /// Which section a paging request continues.
    enum Part: String {
        case reasoning
        case input
        case result
    }

    /// One section as the server returned it.
    struct Section: Equatable {
        var text: String
        /// Total available server-side, in UTF-16 code units (nil = it did not say).
        var totalChars: Int?
        /// Offset to continue from, in UTF-16 code units; nil = this is all of it.
        var nextOffset: Int?
        /// The section's OWN `<name>Truncated` flag: the server saying this section
        /// carries less than the row's text. Absent on the wire means whole, and it is
        /// deliberately NOT the payload-wide `truncated`, which is the OR of all three
        /// sections and so cannot name the one that fell short — reading that per
        /// section would make a complete section claim it was elided.
        var truncated: Bool = false
    }

    /// A whole answer. A thinking row fills `reasoning`; a tool row fills
    /// `input`/`result` (either may be absent when the tool had none).
    struct Detail: Equatable {
        var reasoning: Section?
        var input: Section?
        var result: Section?
    }

    /// Why a fetch could not answer. ALL of them are stated to the reader — a silent
    /// dead end is a defect — but only `gone` is worded as itself; the rest share the
    /// "excerpt only" line, and only `unavailable` earns a retry button (see
    /// `TimelineActivitySheet.load`).
    enum Failure: Error, Equatable {
        /// 410 `detail_gone`: the ref parsed and the row is genuinely unreachable —
        /// rewound, compacted away, or slid out of the bounded history window. The
        /// server distinguishes this from "no such route" ON PURPOSE (it never
        /// answers 404 for a gone row any more), which is the only reason it can be
        /// worded at all: a status that also means "old server" would announce
        /// "the text is gone" on nearly every drawer while the excerpt sits there.
        case gone
        /// 404: this box predates the route. The COMMON case for now — the route is not
        /// deployed anywhere yet, so the running Mac answers exactly this. A REPLICA is
        /// not a separate risk here: it relays this call to the primary, so it answers
        /// 404 only when the primary does. Never worded — a row from such a server
        /// carries no `detailRef` anyway, so this is reachable only when a cached row
        /// outlives a rollback.
        case unsupported
        /// 400: a malformed ref or a bad offset — a bug on one side or the other.
        case rejected
        /// 503 / transport: the box could not read the source in time (a daemon or
        /// SSH deadline, or a replica whose primary is offline). Worth one retry.
        case unavailable
    }

    /// Fetch one page. First call: omit `part` and `offset`.
    ///
    /// This is the seam — the only function that talks to the server about a row's
    /// full text — so a route change is a change to this body and nothing else.
    ///
    /// `offset` is a count of UTF-16 CODE UNITS and the only honest source for one is
    /// a `nextOffset` the server sent (or a `text.utf16.count` measured on what it
    /// sent). A grapheme count computed on this side names a different position in the
    /// server's string, which is a silently wrong page rather than an error.
    static func fetch(ref: String, part: Part? = nil,
                      offset: Int? = nil) async throws -> Detail {
        guard !ref.isEmpty else { throw Failure.rejected }
        var path = "/activity/detail?ref=" + encode(ref)
        if let part { path += "&part=" + part.rawValue }
        // `offset` without `part` is a 400 by contract, so the two travel together
        // or not at all — enforced here rather than trusted to every caller.
        if let offset, part != nil { path += "&offset=\(offset)" }
        do {
            let payload: Payload = try await WalnutAPI().get(path)
            return payload.detail
        } catch let error as APIError {
            throw Self.failure(for: error)
        } catch {
            throw Failure.unavailable
        }
    }

    /// HTTP status → the drawer's outcomes.
    ///
    /// 410 and 404 are DIFFERENT ANSWERS and the split is the whole point: 410 is
    /// the server saying "this row is really gone" (it never uses 404 for that), and
    /// 404 is "this box has no such route". Collapsing them is what forced the
    /// drawer to stay silent about a genuinely missing row.
    static func failure(for error: APIError) -> Failure {
        guard case .server(let status, _, _, _, _) = error else {
            // A transport error (offline, timeout) is the retryable shape.
            return .unavailable
        }
        switch status {
        case 410: return .gone
        case 404: return .unsupported
        case 400: return .rejected
        default: return .unavailable
        }
    }

    /// Percent-encode a query VALUE conservatively (unreserved characters only),
    /// because the ref is opaque and may legitimately contain `&`, `=`, `+`, `/`
    /// or `#` — any of which would otherwise re-partition the URL.
    static func encode(_ value: String) -> String {
        let unreserved = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    /// Wire shape. Flat and all-optional so an added field, a missing section, or
    /// a section the row does not have can never fail decoding.
    ///
    /// Internal rather than private so a test can decode REAL response JSON: the field
    /// names here are the contract, and a typo in one of them is invisible until a
    /// device run (the section simply reports itself whole).
    struct Payload: Decodable {
        let text: String?
        let textChars: Int?
        let textNextOffset: Int?
        let textTruncated: Bool?
        let input: String?
        let inputChars: Int?
        let inputNextOffset: Int?
        let inputTruncated: Bool?
        let result: String?
        let resultChars: Int?
        let resultNextOffset: Int?
        let resultTruncated: Bool?
        // The payload-wide `truncated` is deliberately NOT decoded: it is the OR of the
        // three sections, so there is no section it can honestly be applied to.

        var detail: Detail {
            Detail(
                reasoning: Self.section(text, textChars, textNextOffset, textTruncated),
                input: Self.section(input, inputChars, inputNextOffset, inputTruncated),
                result: Self.section(result, resultChars, resultNextOffset, resultTruncated)
            )
        }

        /// An absent section and an EMPTY one are the same answer ("nothing here"),
        /// so both come back nil — a `Section(text: "")` would make the drawer
        /// replace a preview it already has with nothing.
        private static func section(_ text: String?, _ chars: Int?,
                                    _ next: Int?, _ truncated: Bool?) -> Section? {
            guard let text, !text.isEmpty else { return nil }
            return Section(text: text, totalChars: chars, nextOffset: next,
                           truncated: truncated ?? false)
        }
    }
}

extension ChatMessage {
    /// The row's opaque full-text ref, as the wire delivers it (see
    /// `TimelineActivityFullText`). One accessor rather than reads of the stored
    /// property scattered through the builder: the field is additive, so it is absent
    /// on an older PRIMARY and on the one replica path that projects its own mirrored
    /// history instead of relaying the list, and this is the single place that fact is
    /// expressed. A relaying replica is not a case: it hands back the primary's rows.
    var activityDetailRef: String? {
        guard let ref = detailRef?.trimmingCharacters(in: .whitespacesAndNewlines),
              !ref.isEmpty else { return nil }
        return ref
    }
}
