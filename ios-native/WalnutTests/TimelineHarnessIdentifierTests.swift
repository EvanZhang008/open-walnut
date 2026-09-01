import XCTest

/// The DEBUG timeline harness is driven entirely by ACCESSIBILITY IDENTIFIER, so
/// its ids are a contract with the tools that tap them (Maestro flows, XCUITest),
/// not labels a human reads. Two properties have to hold, and neither is a value
/// the app can be asked for:
///
///  - NO ID MAY BE CONTAINED IN ANOTHER. An id matcher resolves a name against the
///    view tree by substring or regex, so `harness.rich` also named
///    `harness.richOnly` and `harness.richStream`: a tap on "Rich" silently landed
///    on whichever of the three the search reached first, the transcript ended up
///    in a state the flow never asked for, and a gate agent spent a full pass
///    believing the harness itself was broken. Prefix-freedom is the minimum;
///    containment ANYWHERE is what actually decides a match.
///  - THE MANIFEST BELOW IS THE WHOLE SET. A control added without an id, or with
///    one no flow has ever heard of, is a control nothing can drive — the same
///    dead end, arrived at from the other side.
///
/// Both are checked by reading the harness as TEXT, the way `BoardChromeR30Tests`
/// reads a modifier arrangement: the property is about the id LITERALS in that
/// file, so the source is the only place it exists. Nothing here imports the app,
/// which also keeps the gate working while the harness stays `#if DEBUG`.
final class TimelineHarnessIdentifierTests: XCTestCase {
    private static let harnessSource = "Walnut/Timeline/TimelineHarnessView.swift"

    /// Every identifier the harness exposes, spelled out here on purpose: this is
    /// the list the flows are written against, so a rename costs a deliberate edit
    /// in two places instead of a silent one in the view.
    private let expected: Set<String> = [
        "harness.plainStream",
        "harness.append",
        "harness.bottom",
        "harness.count",
        "harness.richMixed",
        "harness.richOnly",
        "harness.richStream",
        "harness.timeline",
    ]

    func testNoHarnessIdentifierIsContainedInAnother() throws {
        let ids = try harnessIdentifiers().sorted()
        for id in ids {
            for other in ids where other != id {
                XCTAssertFalse(
                    other.contains(id),
                    """
                    `\(id)` is contained in `\(other)`, so an id-based tap on it can \
                    resolve to the wrong control — give one of them a distinct name
                    """
                )
            }
        }
    }

    func testTheManifestIsTheWholeSetOfHarnessIdentifiers() throws {
        let ids = try harnessIdentifiers()
        XCTAssertEqual(
            Set(ids), expected,
            """
            the harness's identifiers and this file's manifest disagree \
            (missing: \(expected.subtracting(ids).sorted()), \
            unlisted: \(Set(ids).subtracting(expected).sorted()))
            """
        )
        // A duplicate is the same defect as containment: two controls, one name,
        // and a tap that resolves to whichever the search finds first.
        XCTAssertEqual(Set(ids).count, ids.count,
                       "two harness controls share one identifier: \(ids.sorted())")
    }

    /// The identifier literals as they appear in the harness source, in order, with
    /// duplicates kept (the manifest case asserts on them).
    private func harnessIdentifiers() throws -> [String] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // WalnutTests/
            .deletingLastPathComponent()      // ios-native/
        let source = try String(contentsOf: root.appendingPathComponent(Self.harnessSource),
                               encoding: .utf8)
        var found: [String] = []
        var rest = Substring(source)
        let marker = ".accessibilityIdentifier(\""
        while let start = rest.range(of: marker) {
            let tail = rest[start.upperBound...]
            guard let close = tail.firstIndex(of: "\"") else { break }
            found.append(String(tail[..<close]))
            rest = tail[close...]
        }
        // Not an assertion about the harness but about THIS file: zero hits means
        // the view moved or the call spelling changed, and every case above would
        // otherwise pass vacuously.
        XCTAssertFalse(found.isEmpty,
                       "no identifiers found in \(Self.harnessSource) — has it moved?")
        return found
    }
}
