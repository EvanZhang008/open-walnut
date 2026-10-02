import XCTest
@testable import Walnut

/// The phone's twin of the server's tag display rules (`Core/TagDisplay.swift`, ported from
/// `src/core/tag-model.ts` + `src/core/tag-display-rules.ts`) and the store that reads them.
///
/// The defect this round fixes: the phone joined a task's raw tags into one string, so a
/// ticket task read "ticket:V1234567890, ticket-id:abc, sev:2, label:oncall" while the
/// console showed "V1234567890  sev:2  oncall", and nothing on the phone opened the ticket.
/// Every case below mirrors one the server-side tests pin, so a drift between the two ports
/// shows here.
@MainActor
final class TagDisplayTests: XCTestCase {

    private let ticketPlugin = TagDisplayState(
        rules: TagDisplayRules.builtin + [
            TagDisplayRule(pattern: "ticket:*", display: "value", source: "plugin", pluginId: "tickets", pluginName: "Tickets"),
            TagDisplayRule(pattern: "ticket-id:*", display: "hidden", source: "plugin", pluginId: "tickets", pluginName: "Tickets"),
        ] + TagDisplayRules.defaults,
        links: [TagLinkRule(pattern: "ticket:*", link: "https://tracker.example.com/{value}", source: "plugin", pluginId: "tickets")]
    )

    // MARK: - Tag model

    func testAPlainWordIsALabelAndAKeyIsLowercased() {
        XCTAssertEqual(TagModel.normalize("oncall"), "label:oncall")
        XCTAssertEqual(TagModel.normalize("  Team :  Marina  "), "team:Marina")
        XCTAssertEqual(TagModel.normalize("a  b\u{0007}c"), "label:a b c", "control characters and space runs fold to one space")
        XCTAssertEqual(TagModel.normalize(":oops:"), "label:oops")
        XCTAssertEqual(TagModel.normalize("Bad Key:x"), "label:Bad Key:x", "a key with a space is not a key")
        XCTAssertNil(TagModel.normalize("   "))
        // created:/updated: are Walnut's own dates: a filter may name them, a write may not.
        XCTAssertEqual(TagModel.normalize("created:2026-10-01"), "label:created:2026-10-01")
        XCTAssertEqual(TagModel.normalize("created:2026-10-01", derived: true), "created:2026-10-01")
    }

    func testTheStoredLengthNeverCutsThroughAnEmoji() {
        let tag = "k:" + String(repeating: "z", count: 197) + "\u{1F600}tail"
        XCTAssertEqual(TagModel.normalize(tag), "k:" + String(repeating: "z", count: 197))
    }

    func testKeyAndValueSplitAtTheFirstColon() {
        XCTAssertEqual(TagModel.namespace("ticket:V1"), "ticket")
        XCTAssertEqual(TagModel.value("url:https://x.example.com/a"), "https://x.example.com/a")
        XCTAssertNil(TagModel.namespace("ticket:"))
        XCTAssertNil(TagModel.namespace(":v"))
        XCTAssertEqual(TagModel.value("plain"), "plain")
    }

    // MARK: - Display rules

    func testWalnutsOwnRulesApplyWithNoAnswerFromTheServer() {
        let compiled = CompiledTagDisplay(.walnutOnly)
        XCTAssertEqual(compiled.display("label:oncall"), .value)
        XCTAssertEqual(compiled.display("created:2026-10-01"), .hidden)
        XCTAssertEqual(compiled.display("walnut:external-sessions"), .hidden)
        XCTAssertEqual(compiled.display("sev:2"), .shown)
        // Even an empty list (an older server) keeps them.
        XCTAssertEqual(CompiledTagDisplay(TagDisplayState(rules: [])).display("label:x"), .value)
    }

    func testUserBeatsPluginBeatsDefaultAndTheExactTagBeatsItsKey() {
        let state = TagDisplayState(rules: [
            TagDisplayRule(pattern: "ticket:*", display: "value", source: "plugin"),
            TagDisplayRule(pattern: "ticket:V9", display: "hidden", source: "plugin"),
            TagDisplayRule(pattern: "label:*", display: "shown", source: "user"),
            TagDisplayRule(pattern: "label:quiet", display: "hidden", source: "plugin"),
            TagDisplayRule(pattern: "sev:*", display: "hidden", source: "plugin"),
            TagDisplayRule(pattern: "sev:*", display: "shown", source: "user"),
        ])
        let compiled = CompiledTagDisplay(state)
        XCTAssertEqual(compiled.display("ticket:V1"), .value)
        XCTAssertEqual(compiled.display("ticket:V9"), .hidden, "the exact tag before its key")
        XCTAssertEqual(compiled.display("label:oncall"), .shown, "the user's key rule beats Walnut's default")
        XCTAssertEqual(compiled.display("label:quiet"), .shown, "the user's key rule beats a plugin's exact one: user layer first")
        XCTAssertEqual(compiled.display("sev:2"), .shown, "the user beats the plugin")
        XCTAssertEqual(compiled.ruleFor("ticket:V1")?.source, "plugin")
    }

    func testBetweenTwoPluginsTheQuieterWins() {
        let compiled = CompiledTagDisplay(TagDisplayState(rules: [
            TagDisplayRule(pattern: "team:*", display: "value", source: "plugin", pluginId: "a"),
            TagDisplayRule(pattern: "team:*", display: "hidden", source: "plugin", pluginId: "b"),
            TagDisplayRule(pattern: "team:*", display: "shown", source: "plugin", pluginId: "c"),
        ]))
        XCTAssertEqual(compiled.display("team:marina"), .hidden)
    }

    func testNoRuleCanShowAMachineTagAndBadRulesAreSkipped() {
        let compiled = CompiledTagDisplay(TagDisplayState(rules: [
            TagDisplayRule(pattern: "walnut:*", display: "shown", source: "user"),
            TagDisplayRule(pattern: "Sev:*", display: "hidden", source: "user"),
            TagDisplayRule(pattern: "x:*", display: "sometimes", source: "user"),
            TagDisplayRule(pattern: "bad key:*", display: "hidden", source: "user"),
        ]))
        XCTAssertEqual(compiled.display("walnut:imported"), .hidden)
        XCTAssertEqual(compiled.display("sev:2"), .hidden, "a pattern's key is normalized like a tag's")
        XCTAssertEqual(compiled.display("x:1"), .shown)
    }

    // MARK: - Links

    func testALinkFillsTheValueEncodedLikeEncodeURIComponent() {
        let compiled = CompiledTagDisplay(ticketPlugin)
        XCTAssertEqual(compiled.linkFor("ticket:V1234567890")?.absoluteString, "https://tracker.example.com/V1234567890")
        XCTAssertEqual(
            compiled.linkFor("ticket:a b/c?d#e&\u{00E9}")?.absoluteString,
            "https://tracker.example.com/a%20b%2Fc%3Fd%23e%26%C3%A9"
        )
        XCTAssertEqual(
            TagDisplayRules.href("https://x.example.com/{value}?q={value}", tag: "k:(it's)!*~")?.absoluteString,
            "https://x.example.com/(it's)!*~?q=(it's)!*~"
        )
        XCTAssertNil(compiled.linkFor("sev:2"))
    }

    func testTheUsersLinkWinsAndTheirEmptyOneTurnsAPluginsOff() {
        var state = ticketPlugin
        state.links.append(TagLinkRule(pattern: "ticket:*", link: "https://mine.example.com/t/{value}", source: "user"))
        XCTAssertEqual(CompiledTagDisplay(state).linkFor("ticket:V1")?.absoluteString, "https://mine.example.com/t/V1")
        state.links.append(TagLinkRule(pattern: "ticket:V2", link: "", source: "user"))
        let compiled = CompiledTagDisplay(state)
        XCTAssertNil(compiled.linkFor("ticket:V2"), "the user's empty link for one tag")
        XCTAssertEqual(compiled.linkRuleFor("ticket:V2")?.link, "")
        XCTAssertEqual(compiled.linkFor("ticket:V3")?.host(), "mine.example.com")
    }

    func testBadLinksAndMachineTagsNeverLink() {
        let compiled = CompiledTagDisplay(TagDisplayState(rules: [], links: [
            TagLinkRule(pattern: "a:*", link: "javascript:alert({value})", source: "user"),
            TagLinkRule(pattern: "b:*", link: "https://b.example.com/no-slot", source: "user"),
            TagLinkRule(pattern: "c:*", link: "https://c.example.com/{value} x", source: "user"),
            TagLinkRule(pattern: "d:*", link: "", source: "plugin"),
            TagLinkRule(pattern: "walnut:*", link: "https://w.example.com/{value}", source: "user"),
            TagLinkRule(pattern: "e:*", link: "https://first.example.com/{value}", source: "plugin", pluginId: "one"),
            TagLinkRule(pattern: "e:*", link: "https://second.example.com/{value}", source: "plugin", pluginId: "two"),
        ]))
        for tag in ["a:1", "b:1", "c:1", "d:1", "walnut:x"] { XCTAssertNil(compiled.linkFor(tag), tag) }
        XCTAssertEqual(compiled.linkFor("e:1")?.host(), "first.example.com", "between plugins, the first one set stays")
        XCTAssertEqual(TagDisplayRules.normalizeLink("  "), "")
        XCTAssertNil(TagDisplayRules.normalizeLink("ftp://x.example.com/{value}"))
    }

    // MARK: - Pills

    func testATicketTaskDrawsTheIdTheSeverityAndTheWord() {
        let compiled = CompiledTagDisplay(ticketPlugin)
        let pills = compiled.pills(for: ["ticket:V1234567890", "ticket-id:abc", "sev:2", "oncall", "label:oncall", "walnut:x"])
        XCTAssertEqual(pills.shown.map(\.text), ["V1234567890", "sev:2", "oncall"])
        XCTAssertEqual(pills.shown.map(\.tag), ["ticket:V1234567890", "sev:2", "label:oncall"], "a plain word is its label, once")
        XCTAssertEqual(pills.shown.first?.url?.absoluteString, "https://tracker.example.com/V1234567890")
        XCTAssertEqual(pills.hidden.map(\.tag), ["ticket-id:abc", "walnut:x"])
        XCTAssertTrue(compiled.pills(for: nil).shown.isEmpty)
    }

    // MARK: - Decoding

    func testOneMalformedRuleCostsThatRuleNotTheSet() throws {
        let json = """
        {"rules":[{"pattern":"ticket:*","display":"value","source":"plugin"},{"pattern":7},
                  {"pattern":"sev:*","display":"hidden","source":"user"}],
         "links":[{"pattern":"ticket:*","link":"https://t.example.com/{value}","source":"plugin"},{"link":null}]}
        """
        let state = try JSONDecoder().decode(TagDisplayState.self, from: Data(json.utf8))
        XCTAssertEqual(state.rules.map(\.pattern), ["ticket:*", "sev:*"])
        XCTAssertEqual(state.links.count, 1)
        // An older server sends no links at all.
        let old = try JSONDecoder().decode(TagDisplayState.self, from: Data(#"{"rules":[]}"#.utf8))
        XCTAssertEqual(old.links, [])
    }

    // MARK: - Store

    private func scratchDefaults() -> UserDefaults {
        let name = "tag-display-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return defaults
    }

    func testTheStoreReadsKeepsTheAnswerPerServerAndKeepsItWhenAReadFails() async {
        let defaults = scratchDefaults()
        var server = "https://mac.example.test"
        var answer: Result<TagDisplayState, Error> = .success(ticketPlugin)
        var reads = 0
        var clock = Date(timeIntervalSince1970: 1_000)
        let make = {
            TagDisplayStore(
                defaults: defaults,
                fetch: { reads += 1; return try answer.get() },
                currentServer: { server },
                now: { clock }
            )
        }
        let store = make()
        XCTAssertEqual(store.compiled.display("ticket:V1"), .shown, "nothing read yet: Walnut's rules only")
        await store.refreshIfStale()
        XCTAssertEqual(store.compiled.display("ticket:V1"), .value)
        XCTAssertEqual(reads, 1)

        // Fresh enough: no second read.
        clock.addTimeInterval(60)
        await store.refreshIfStale()
        XCTAssertEqual(reads, 1)

        // A failed read keeps what it had.
        clock.addTimeInterval(600)
        answer = .failure(URLError(.notConnectedToInternet))
        await store.refreshIfStale()
        XCTAssertEqual(reads, 2)
        XCTAssertEqual(store.compiled.display("ticket:V1"), .value)

        // A relaunch shows the kept answer before any read.
        let relaunched = make()
        XCTAssertEqual(relaunched.compiled.display("ticket:V1"), .value)

        // Paired with another server: the old server's rules are not this one's.
        server = "https://other.example.test"
        let elsewhere = make()
        XCTAssertEqual(elsewhere.compiled.display("ticket:V1"), .shown)
        await relaunched.refreshIfStale()
        XCTAssertEqual(relaunched.compiled.display("ticket:V1"), .shown, "the store follows the paired server")
    }

    func testConcurrentReadsShareOneRequest() async {
        let defaults = scratchDefaults()
        var reads = 0
        let store = TagDisplayStore(
            defaults: defaults,
            fetch: {
                reads += 1
                try await Task.sleep(nanoseconds: 50_000_000)
                return TagDisplayState.walnutOnly
            },
            currentServer: { "https://mac.example.test" }
        )
        async let first: Void = store.refresh()
        async let second: Void = store.refresh()
        _ = await (first, second)
        XCTAssertEqual(reads, 1)
    }
}
