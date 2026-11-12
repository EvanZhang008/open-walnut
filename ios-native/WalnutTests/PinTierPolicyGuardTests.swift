import Foundation
import XCTest

/// The class guard behind `PinTierPolicy`: no tier picker, band, chip or label in the app
/// keeps its own list of built-in tiers, offers the retired Backlog or Wait (Parked), or
/// writes a tier around the store's `pickTier`. Read from the source, so a NEW entry point
/// that brings Parked back, or a parallel tier list beside the policy, fails here.
final class PinTierPolicyGuardTests: XCTestCase {
    private struct Line {
        let file: String
        let number: Int
        let text: String
    }

    private var appRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut")
    }

    /// Every code line of the app's Swift sources, comments left out. The policy itself
    /// and the demo server (a stand-in for older servers, which still store both retired
    /// tiers) are the two places allowed to name them.
    private func codeLines() throws -> [Line] {
        let root = appRoot
        var lines: [Line] = []
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
        for case let url as URL in files where url.pathExtension == "swift" {
            let rel = String(url.path.dropFirst(root.path.count + 1))
            if rel.hasPrefix("Demo/") || rel.hasSuffix("PinTierPolicy.swift") { continue }
            let source = try String(contentsOf: url, encoding: .utf8)
            for (index, text) in source.components(separatedBy: "\n").enumerated() {
                let trimmed = text.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("//") { continue }
                lines.append(Line(file: rel, number: index + 1, text: text))
            }
        }
        XCTAssertGreaterThan(lines.count, 1000, "the scan found the app sources")
        return lines
    }

    private func offenders(_ lines: [Line], _ matches: (String) -> Bool) -> [String] {
        lines.filter { matches($0.text) }.map { "\($0.file):\($0.number): \($0.text.trimmingCharacters(in: .whitespaces))" }
    }

    func testThePolicyIsWhereTheRetiredTiersAreNamed() throws {
        let policy = try String(
            contentsOf: appRoot.appendingPathComponent("Stores/PinTierPolicy.swift"), encoding: .utf8
        )
        XCTAssertTrue(policy.contains("static let retiredBuiltins: Set<String> = [\"backlog\", \"wait\"]"))
        XCTAssertTrue(policy.contains("(\"focus\", \"Focus\")"), "the offered built-ins live in the policy")
    }

    /// No menu, chip or label lists Backlog or Wait as a tier, and nothing says "Parked".
    func testNoEntryPointOffersARetiredTier() throws {
        let lines = try codeLines()
        let tupleHits = offenders(lines) { text in
            // Priority has its own "Backlog" (a priority, not a tier), always beside "None".
            (text.contains("(\"wait\", \"") || text.contains("(\"backlog\", \""))
                && !text.contains("(\"none\", \"None\")")
        }
        XCTAssertEqual(tupleHits, [], "a retired tier offered as a choice: read PinTierPolicy.choices")

        let parked = offenders(lines) { $0.contains("\"Parked\"") }
        XCTAssertEqual(parked, [], "Parked is retired as a pin tier")

        let infoHits = offenders(lines) { text in
            ["FocusTierInfo(id: \"wait\"", "FocusTierInfo(id: \"backlog\"",
             "tierId: \"wait\"", "tierId: \"backlog\""].contains { text.contains($0) }
        }
        XCTAssertEqual(infoHits, [], "a retired tier made into a pickable tier")
    }

    /// A switch on a tier id that names Backlog or Wait is a second fold beside
    /// `PinTierPolicy.displayTier`, or a label the board no longer draws.
    func testNoCodeSwitchesOnARetiredTierOutsideThePolicy() throws {
        let hits = offenders(try codeLines()) { text in
            // TaskPriority's own decode keeps its "backlog" priority.
            (text.contains("case \"wait\"") || text.contains("case \"backlog\""))
                && !text.contains("self = .backlog")
        }
        XCTAssertEqual(hits, [], "fold a retired tier with PinTierPolicy.displayTier")
    }

    /// Unpinning is a tap on the checked tier, never a token or an option of its own.
    func testThereIsNoUnpinChoiceToken() throws {
        let hits = offenders(try codeLines()) { $0.contains("\"unpin\"") }
        XCTAssertEqual(hits, [], "a re-tap of the selected tier unpins (PinTierPolicy.writes)")
    }

    /// One list of built-in tiers: a line naming Focus with Backlog or Wait, or the
    /// Focus pair itself, is a parallel copy of the policy's.
    func testNoParallelBuiltInTierList() throws {
        let lines = try codeLines()
        let mixed = offenders(lines) { text in
            text.contains("\"focus\"") && (text.contains("\"wait\"") || text.contains("\"backlog\""))
        }
        XCTAssertEqual(mixed, [], "a tier list beside PinTierPolicy")
        let builtins = offenders(lines) { $0.contains("(\"focus\", \"Focus\")") }
        XCTAssertEqual(builtins, [], "read PinTierPolicy.offeredBuiltins")
    }

    /// Views reach a tier through `TasksStore.pickTier`, which runs the policy's writes in
    /// order (a pin before a tier, a re-tap as the unpin); only the store calls `setTier`.
    func testTaskViewsUseTheSharedPinChoiceInsteadOfAToggle() throws {
        // Inbox pins letters, not tasks. Every other view reaches task pin choices
        // through the policy, regardless of the name of its store variable.
        let hits = try codeLines().filter {
            $0.file.hasPrefix("Views/") && !$0.file.hasPrefix("Views/Inbox/")
                && $0.text.contains(".setPinned(")
        }.map { "\($0.file):\($0.number)" }
        XCTAssertEqual(hits, [], "task views must use TasksStore.pickTier")
    }

    func testOnlyTheStoreWritesATier() throws {
        let hits = try codeLines().filter { $0.text.contains("setTier(taskId:") }
        let outside = hits.filter { $0.file != "Stores/TasksStoreFocus.swift" }
            .map { "\($0.file):\($0.number)" }
        XCTAssertEqual(outside, [], "call TasksStore.pickTier instead of setTier")
        XCTAssertFalse(hits.isEmpty, "the store's own setTier is still found")
    }
}
