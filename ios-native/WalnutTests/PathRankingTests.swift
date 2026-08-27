import XCTest
@testable import Walnut

/// Parity gate for `PathRanking.swift`, which is a hand port of the web console's
/// path-selector logic (web/src/utils/fuzzy.ts, path-selector/ranking.ts,
/// path-selector/input-model.ts, DraftLaunchBar.tsx).
///
/// These are not "does it run" tests. Each one pins a rule the two
/// implementations must agree on, because the failure mode of a drifted port is
/// silent: the phone offers a different top folder than the Mac for the same
/// keystrokes, and the user picks the wrong directory believing it is the one the
/// console would have picked.
final class PathRankingTests: XCTestCase {

    // MARK: - Chip key: the "" vs nil local host quirk

    /// `/api/v1/sessions/launch-options` spells the primary box as `host: ""`
    /// while the web model uses `null`. Both mean local, so both MUST key the
    /// same chip: two keys for one directory would render it twice and break
    /// selection identity.
    func testEmptyStringHostAndNilHostProduceTheSameLocalKey() {
        XCTAssertEqual(PathRanking.pathChipKey(cwd: "/x", host: ""), "__local__::/x")
        XCTAssertEqual(PathRanking.pathChipKey(cwd: "/x", host: nil), "__local__::/x")
        XCTAssertEqual(PathRanking.pathChipKey(cwd: "/x", host: ""),
                       PathRanking.pathChipKey(cwd: "/x", host: nil))
    }

    func testRemoteAliasKeysByAlias() {
        XCTAssertEqual(PathRanking.pathChipKey(cwd: "/x", host: "alias"), "alias::/x")
    }

    /// The wire type goes through the same normalizer, so a `Dir` from the server
    /// and a locally built key agree.
    func testChipKeyFromWireDirNormalizesTheEmptyHost() {
        let local = SessionLaunchOptions.Dir(cwd: "/x", host: "", hostLabel: nil,
                                             lastUsed: "2026-08-27T00:00:00Z", count: 3)
        let remote = SessionLaunchOptions.Dir(cwd: "/x", host: "alias", hostLabel: "Alias",
                                             lastUsed: "2026-08-27T00:00:00Z", count: 3)
        XCTAssertEqual(PathRanking.pathChipKey(dir: local), "__local__::/x")
        XCTAssertEqual(PathRanking.pathChipKey(dir: remote), "alias::/x")
    }

    // MARK: - Basename and pill label

    func testBasenameIsTrailingSlashTolerant() {
        XCTAssertEqual(PathRanking.pathBasename("/a/b"), "b")
        XCTAssertEqual(PathRanking.pathBasename("/a/b/"), "b")
        XCTAssertEqual(PathRanking.pathBasename("/a/b///"), "b")
        XCTAssertEqual(PathRanking.pathBasename("/"), "/", "root has no leaf to show")
        XCTAssertEqual(PathRanking.pathBasename(""), "/")
    }

    func testPathLabelLocalRemoteAndEmpty() {
        XCTAssertEqual(PathRanking.pathLabel(cwd: "/Users/me/walnut", host: nil, hostLabel: nil), "walnut")
        XCTAssertEqual(PathRanking.pathLabel(cwd: "/Users/me/walnut", host: "", hostLabel: nil), "walnut",
                       "the empty host is local, not a remote named \"\"")
        XCTAssertEqual(PathRanking.pathLabel(cwd: "/Users/me/walnut", host: "alias", hostLabel: nil),
                       "walnut · alias")
        XCTAssertEqual(PathRanking.pathLabel(cwd: "/Users/me/walnut", host: "alias", hostLabel: "Alias Box"),
                       "walnut · Alias Box", "the label wins over the raw alias")
        XCTAssertEqual(PathRanking.pathLabel(cwd: "", host: nil, hostLabel: nil), "Choose folder…")
    }

    // MARK: - MatchQuality bands

    func testEmptyNeedleIsPrefixSoItAdmitsEverything() {
        XCTAssertEqual(MatchQuality.of(needle: "", hay: "/anything"), .prefix)
        XCTAssertEqual(MatchQuality.prefix.rank, 3)
        XCTAssertEqual(MatchQuality.substring.rank, 2)
        XCTAssertEqual(MatchQuality.subsequence.rank, 1)
        XCTAssertEqual(MatchQuality.none.rank, 0)
        XCTAssertEqual(MatchQuality.of(needle: "", hay: "").rank, 3)
    }

    func testQualityBandsAndCaseInsensitivity() {
        XCTAssertEqual(MatchQuality.of(needle: "wal", hay: "walnut"), .prefix)
        XCTAssertEqual(MatchQuality.of(needle: "nut", hay: "walnut"), .substring)
        XCTAssertEqual(MatchQuality.of(needle: "wnt", hay: "walnut"), .subsequence)
        // Written as `MatchQuality.none`: a bare `.none` here reads as Optional.none.
        XCTAssertEqual(MatchQuality.of(needle: "zq", hay: "walnut"), MatchQuality.none)
        XCTAssertEqual(MatchQuality.of(needle: "WAL", hay: "walnut"), .prefix)
        XCTAssertEqual(MatchQuality.of(needle: "wal", hay: "WALNUT"), .prefix)
    }

    // MARK: - fuzzyScore weights

    /// A path the whole query sits inside must outscore one where only the tokens
    /// line up: the +10/+6 substring signals are what make an exact-ish hit lead.
    func testWholePathSubstringOutscoresATokenOnlyHit() {
        let substringHit = PathFuzzy.fuzzyScore("walnut docs", "/Users/me/walnut docs")
        let tokenOnlyHit = PathFuzzy.fuzzyScore("walnut docs", "/Users/me/walnut/docs")
        XCTAssertEqual(substringHit, 28, "10 path + 6 leaf + (4+2) + (4+2)")
        XCTAssertEqual(tokenOnlyHit, 10, "two exact token hits, one of them in the leaf")
        XCTAssertGreaterThan(substringHit, tokenOnlyHit)
    }

    func testTotalNonMatchScoresZero() {
        XCTAssertEqual(PathFuzzy.fuzzyScore("zzz", "/a/b"), 0)
        XCTAssertEqual(PathFuzzy.fuzzyScore("   ", "/a/b"), 0, "a blank query is no signal, not a match")
    }

    /// The loose fallback is worth exactly 1 and only fires when every other
    /// signal missed, so it can re-rank but never resurrect a real non-match.
    func testSubsequenceFallbackScoresExactlyOne() {
        XCTAssertEqual(PathFuzzy.fuzzyScore("ab", "/a/x/b"), 1)
    }

    func testTokenizeSplitsOnEveryNonAlphanumeric() {
        XCTAssertEqual(PathFuzzy.tokenize("a/b-c_d"), ["a", "b", "c", "d"])
        XCTAssertEqual(PathFuzzy.tokenize("MyLongPackageName"), ["mylongpackagename"])
    }

    // MARK: - Frecency

    func testMoreRecentBeatsOlderAtEqualCount() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let fresh = PathRanking.frecencyScore(count: 5, lastUsed: now.addingTimeInterval(-3600), now: now)
        let stale = PathRanking.frecencyScore(count: 5, lastUsed: now.addingTimeInterval(-30 * 86_400), now: now)
        XCTAssertGreaterThan(fresh, stale)
    }

    func testOneHalfLifeHalvesTheScore() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let halfLifeAgo = now.addingTimeInterval(-PathRanking.frecencyHalfLife)
        XCTAssertEqual(PathRanking.frecencyScore(count: 8, lastUsed: halfLifeAgo, now: now),
                       4.0, accuracy: 0.0001)
        XCTAssertEqual(PathRanking.frecencyScore(count: 8, lastUsed: now, now: now), 8.0, accuracy: 0.0001)
    }

    /// A future stamp (clock skew between phone and server) must not inflate the
    /// score above the raw count: the TS clamps the age at 0 and so does this.
    func testFutureStampClampsToTheRawCount() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(PathRanking.frecencyScore(count: 6, lastUsed: now.addingTimeInterval(9_999), now: now),
                       6.0, accuracy: 0.0001)
    }

    /// The TS yields NaN here, which poisons every comparison the value touches.
    /// 0 is the deliberate difference: an unreadable stamp is simply no history
    /// signal, which is what the sort keys already know how to handle.
    func testUnparseableISOScoresZeroRatherThanNaN() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(PathRanking.frecencyScore(count: 9, lastUsedISO: "not-a-date", now: now), 0)
        XCTAssertEqual(PathRanking.frecencyScore(count: 9, lastUsedISO: "", now: now), 0)
        // A parseable stamp, one half-life back, still decays exactly like the
        // Date overload, so the ISO path is not a separate code path in disguise.
        let iso = ISO8601DateFormatter().string(from: now.addingTimeInterval(-PathRanking.frecencyHalfLife))
        XCTAssertEqual(PathRanking.frecencyScore(count: 9, lastUsedISO: iso, now: now),
                       4.5, accuracy: 0.0001)
    }

    // MARK: - classifyInput

    func testNonPathInputIsBrowse() {
        XCTAssertEqual(PathInput.classifyInput("walnut"), .browse(query: "walnut"))
    }

    func testTrailingSlashIsDirBrowse() {
        XCTAssertEqual(PathInput.classifyInput("/a/b/"), .dirBrowse(dir: "/a/b/"))
    }

    func testPartialLastComponentIsSegment() {
        XCTAssertEqual(PathInput.classifyInput("/a/b/c"), .segment(dir: "/a/b/", partial: "c"))
    }

    func testSpaceAfterAPathIsAScopedSearch() {
        XCTAssertEqual(PathInput.classifyInput("/a/b key"), .scopedSearch(base: "/a/b/", keyword: "key"))
    }

    /// The ambiguous case, asserted as the TS actually behaves: the token after
    /// the LAST space holds no "/", so a spaced directory name classifies as a
    /// scoped search first. Only live children can settle it.
    func testSpacedDirNameFirstClassifiesAsScopedSearch() {
        XCTAssertEqual(PathInput.classifyInput("/a/b/dir with space"),
                       .scopedSearch(base: "/a/b/dir with/", keyword: "space"))
    }

    func testResolveSpaceAmbiguityPrefersARealChildDirectory() {
        let state = PathInput.classifyInput("/a/b/dir with space")
        let exact = PathInput.resolveSpaceAmbiguity(state: state,
                                                   childrenOfBase: ["/a/b/dir with space"])
        XCTAssertEqual(exact, .dirBrowse(dir: "/a/b/dir with space/"),
                       "an exact child means the space was part of the name")

        let midTyping = PathInput.resolveSpaceAmbiguity(state: state,
                                                        childrenOfBase: ["/a/b/dir with spaces"])
        XCTAssertEqual(midTyping, .segment(dir: "/a/b/", partial: "dir with space"),
                       "a child that extends it means the user is still typing that name")

        let noMatch = PathInput.resolveSpaceAmbiguity(state: state, childrenOfBase: ["/a/b/unrelated"])
        XCTAssertEqual(noMatch, state, "no child matches, so the keyword reading stands")
    }

    func testDeleteLastSegmentKeepsTheTrailingSlash() {
        XCTAssertEqual(PathInput.deleteLastSegment("/a/b/c"), "/a/b/")
        XCTAssertEqual(PathInput.deleteLastSegment("/a/b/c/"), "/a/b/")
        XCTAssertEqual(PathInput.deleteLastSegment("/a"), "/")
        XCTAssertEqual(PathInput.deleteLastSegment("/"), "/")
        XCTAssertEqual(PathInput.deleteLastSegment("~/x"), "~/")
        XCTAssertEqual(PathInput.deleteLastSegment("walnut"), "", "no slash at all clears the field")
    }

    func testParentDirOfEachState() {
        XCTAssertNil(PathInput.parentDirOf(.browse(query: "x")), "browse does no live listing")
        XCTAssertEqual(PathInput.parentDirOf(.dirBrowse(dir: "/a/")), "/a/")
        XCTAssertEqual(PathInput.parentDirOf(.segment(dir: "/a/", partial: "b")), "/a/")
        XCTAssertEqual(PathInput.parentDirOf(.scopedSearch(base: "/a/", keyword: "k")), "/a/")
    }

    // MARK: - rankCandidates

    private func live(_ cwd: String, host: String? = nil, depth: Int = 1,
                      history: PathCandidate.HistoryEntry? = nil) -> PathCandidate {
        PathCandidate(cwd: cwd, host: host, hostLabel: nil, source: .live, depth: depth, history: history)
    }

    private func historyOnly(_ cwd: String, host: String? = nil,
                             count: Int, lastUsed: String) -> PathCandidate {
        PathCandidate(cwd: cwd, host: host, hostLabel: nil, source: .history, depth: 0,
                      history: .init(count: count, lastUsed: lastUsed))
    }

    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private var yesterdayISO: String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-86_400))
    }

    /// The documented headline rule: "what you typed" outranks "where you've
    /// been". Typing 'mcp' must put the live '/w/mcps' (leaf prefix) on top even
    /// though a heavily used history dir also matches, because that one only
    /// matches mid-path as a subsequence. Getting this backwards points the top
    /// row (and the ghost completion) at an unrelated frequent directory.
    func testExactLeafPrefixBeatsHighFrecencyMidPathSubsequence() {
        let candidates = [
            historyOnly("/m/c/p/other", count: 500, lastUsed: yesterdayISO),
            live("/w/mcps"),
        ]
        let ranked = PathRanking.rankCandidates(state: .segment(dir: "/w/", partial: "mcp"),
                                                candidates: candidates, now: now)
        XCTAssertEqual(ranked.map(\.cwd), ["/w/mcps", "/m/c/p/other"])
        XCTAssertTrue(ranked[0].leafHit)
        XCTAssertEqual(ranked[0].quality, .prefix)
        XCTAssertFalse(ranked[1].leafHit)
        XCTAssertEqual(ranked[1].quality, .subsequence)
        XCTAssertGreaterThan(ranked[1].frecency, 0, "the history row still carries its frecency")
    }

    /// Admission rule (the user-verified deep-noise case): a LIVE candidate whose
    /// only match is a middle segment is dropped outright.
    func testLiveMidPathOnlyCandidateIsDropped() {
        let ranked = PathRanking.rankCandidates(
            state: .segment(dir: "/w/", partial: "mcp"),
            candidates: [live("/w/mcp/node_modules/thing", depth: 3)],
            now: now
        )
        XCTAssertTrue(ranked.isEmpty, "a deep live mid-path hit is noise, not a suggestion")
    }

    /// The same candidate is KEPT when it is also a history entry, since then the
    /// user has actually been there.
    func testSameMidPathCandidateIsKeptWhenItCarriesHistory() {
        let ranked = PathRanking.rankCandidates(
            state: .segment(dir: "/w/", partial: "mcp"),
            candidates: [live("/w/mcp/node_modules/thing", depth: 3,
                              history: .init(count: 4, lastUsed: yesterdayISO))],
            now: now
        )
        XCTAssertEqual(ranked.map(\.cwd), ["/w/mcp/node_modules/thing"])
        XCTAssertFalse(ranked[0].leafHit)
        XCTAssertEqual(ranked[0].quality, .substring)
    }

    /// With no needle every row is leafHit+prefix, so keys 1 and 2 are uniform
    /// and the order collapses to history-then-frecency (the old browse behavior).
    func testEmptyNeedleDegeneratesToFrecencyOrdering() {
        let candidates = [
            historyOnly("/w/rare", count: 1, lastUsed: yesterdayISO),
            live("/w/fresh-dir"),
            historyOnly("/w/hot", count: 50, lastUsed: yesterdayISO),
        ]
        let ranked = PathRanking.rankCandidates(state: .dirBrowse(dir: "/w/"),
                                                candidates: candidates, now: now)
        XCTAssertEqual(ranked.map(\.cwd), ["/w/hot", "/w/rare", "/w/fresh-dir"],
                       "history first by frecency, then the no-history live row")
        XCTAssertTrue(ranked.allSatisfy { $0.leafHit && $0.quality == .prefix })
    }

    /// Key 4 makes the order total: equal on every relevance and history key, the
    /// shallower row leads and then cwd decides. Swift's sort is not stable, so
    /// without this the row order would wobble between runs.
    func testDepthThenAlphabeticalMakeTheOrderDeterministic() {
        let candidates = [
            live("/w/zeta", depth: 1),
            live("/w/a/deep", depth: 2),
            live("/w/alpha", depth: 1),
        ]
        let ranked = PathRanking.rankCandidates(state: .dirBrowse(dir: "/w/"),
                                                candidates: candidates, now: now)
        XCTAssertEqual(ranked.map(\.cwd), ["/w/alpha", "/w/zeta", "/w/a/deep"])
    }

    /// browse mode matches loosely across the whole path (multi-token fuzzy) where
    /// a path mode demands a real quality band, so the two states admit different
    /// sets for the same needle.
    func testBrowseModeAdmitsMultiTokenFuzzyThatPathModeRejects() {
        let candidate = historyOnly("/Users/me/walnut/docs", count: 2, lastUsed: yesterdayISO)
        let browse = PathRanking.rankCandidates(state: .browse(query: "walnut zzzz"),
                                                candidates: [candidate], now: now)
        XCTAssertEqual(browse.map(\.cwd), ["/Users/me/walnut/docs"])
        XCTAssertEqual(browse[0].quality, .substring, "browse collapses any fuzzy hit to substring")

        let pathMode = PathRanking.rankCandidates(state: .segment(dir: "/Users/", partial: "walnut zzzz"),
                                                  candidates: [candidate], now: now)
        XCTAssertTrue(pathMode.isEmpty, "path mode needs a real band on the path string")
    }

    // MARK: - buildSections

    func testHostGroupingPutsLocalFirstThenRemotesByActivity() {
        let ranked = PathRanking.rankCandidates(
            state: .dirBrowse(dir: "/w/"),
            candidates: [
                live("/w/one", host: "busy"),
                live("/w/two", host: "quiet"),
                live("/w/zzz", host: ""),      // the wire's local spelling, and it ranks LAST
            ],
            now: now
        )
        XCTAssertEqual(ranked.map(\.cwd), ["/w/one", "/w/two", "/w/zzz"], "local is the last row")
        let sections = PathRanking.buildSections(ranked: ranked, hostGrouping: true,
                                                 hostActivity: ["busy": 100, "quiet": 5])
        XCTAssertEqual(sections.map(\.hostKey), ["__local__", "busy", "quiet"],
                       "local leads even though it ranked last and has no activity")
        XCTAssertEqual(sections.map(\.id), ["host:__local__", "host:busy", "host:quiet"])
        XCTAssertEqual(sections[0].label, "Local")
        XCTAssertEqual(sections[1].label, "busy", "no hostLabel, so the alias is the label")
        XCTAssertEqual(sections[0].items.map(\.cwd), ["/w/zzz"])
    }

    func testHostSectionUsesTheHostLabelWhenPresent() {
        let candidate = PathCandidate(cwd: "/w/x", host: "alias", hostLabel: "Alias Box",
                                      source: .live, depth: 1, history: nil)
        let ranked = PathRanking.rankCandidates(state: .dirBrowse(dir: "/w/"),
                                                candidates: [candidate], now: now)
        let sections = PathRanking.buildSections(ranked: ranked, hostGrouping: true, hostActivity: [:])
        XCTAssertEqual(sections.map(\.label), ["Alias Box"])
    }

    /// Non-grouped mode splits history from live and orders the two by their best
    /// member's GLOBAL rank, not a fixed history-first rule. Empty needle: history
    /// frecency floats it up.
    func testUngroupedSectionsSplitAndHistoryLeadsOnAnEmptyNeedle() {
        let candidates = [
            live("/w/mcps"),
            historyOnly("/m/c/p/other", count: 500, lastUsed: yesterdayISO),
        ]
        let ranked = PathRanking.rankCandidates(state: .dirBrowse(dir: "/w/"),
                                                candidates: candidates, now: now)
        let sections = PathRanking.buildSections(ranked: ranked, hostGrouping: false, hostActivity: [:])
        XCTAssertEqual(sections.map(\.id), ["history", "live"])
        XCTAssertEqual(sections.map(\.label), ["🕘 history", "📁 subdirectories"])
        XCTAssertEqual(sections[0].hostKey, "__local__")
    }

    /// Same two candidates, but now the typed needle hits the live dir's leaf, so
    /// the live section must lead: the section split cannot undo the global order.
    func testUngroupedSectionOrderFollowsTheTopRankedMember() {
        let candidates = [
            live("/w/mcps"),
            historyOnly("/m/c/p/other", count: 500, lastUsed: yesterdayISO),
        ]
        let ranked = PathRanking.rankCandidates(state: .segment(dir: "/w/", partial: "mcp"),
                                                candidates: candidates, now: now)
        let sections = PathRanking.buildSections(ranked: ranked, hostGrouping: false, hostActivity: [:])
        XCTAssertEqual(sections.map(\.id), ["live", "history"])
    }

    func testEmptySectionsAreOmittedEntirely() {
        let ranked = PathRanking.rankCandidates(state: .dirBrowse(dir: "/w/"),
                                                candidates: [live("/w/only")], now: now)
        let sections = PathRanking.buildSections(ranked: ranked, hostGrouping: false, hostActivity: [:])
        XCTAssertEqual(sections.map(\.id), ["live"], "no history rows means no history header")
        XCTAssertTrue(PathRanking.buildSections(ranked: [], hostGrouping: false, hostActivity: [:]).isEmpty)
        XCTAssertTrue(PathRanking.buildSections(ranked: [], hostGrouping: true, hostActivity: [:]).isEmpty)
    }
}
