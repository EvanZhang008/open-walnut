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

    // MARK: - Quick folders (draft-column.ts quickDirsFor)

    private func dir(_ cwd: String, host: String = "", hostLabel: String? = nil,
                     count: Int, daysAgo: Double) -> SessionLaunchOptions.Dir {
        let stamp = Date(timeIntervalSince1970: 1_790_000_000 - daysAgo * 86_400)
        return SessionLaunchOptions.Dir(cwd: cwd, host: host, hostLabel: hostLabel,
                                        lastUsed: ISO8601DateFormatter().string(from: stamp), count: count)
    }

    /// The wire can carry the same directory twice (seen on a real listing: the
    /// same local folder once with count 1105 and once with count 1). One chip.
    func testQuickDirsShowOneChipPerDirectory() {
        let dirs = [
            dir("/Users/me/walnut", count: 1105, daysAgo: 0.1),
            dir("/Users/me/other", count: 5, daysAgo: 1),
            dir("/Users/me/walnut", count: 1, daysAgo: 0),
        ]
        let quick = PathRanking.quickDirs(dirs)
        XCTAssertEqual(quick.map(\.cwd), ["/Users/me/walnut", "/Users/me/other"])
    }

    /// Three worktrees of one repo end in the same folder name: one chip, the
    /// checkout used last, ranked by the use of all three (2026-10-06). The same
    /// name on another host is still its own chip.
    func testQuickDirsShowOneChipPerFolderNameOnAHost() {
        let dirs = [
            dir("/w/alpha/review", host: "box", count: 100, daysAgo: 10),
            dir("/w/beta/review", host: "box", count: 90, daysAgo: 1),
            dir("/w/gamma/review/", host: "box", count: 1, daysAgo: 0.5),
            dir("/w/delta/Review", host: "other", count: 80, daysAgo: 2),
            dir("/w/alpha/notes", host: "box", count: 150, daysAgo: 3),
        ]
        XCTAssertEqual(PathRanking.quickDirs(dirs).map(\.cwd),
                       ["/w/beta/review", "/w/alpha/notes", "/w/delta/Review"],
                       "alpha is most used but stale, gamma newest but a one-off: frecency picks beta")
    }

    /// A generic name keeps the folder used every day, not a one-off sharing it.
    func testQuickDirsGenericNameKeepsTheEverydayFolder() {
        let dirs = [dir("/repo/web", count: 300, daysAgo: 7), dir("/scratch/web", count: 1, daysAgo: 0)]
        XCTAssertEqual(PathRanking.quickDirs(dirs).map(\.cwd), ["/repo/web"])
    }

    /// The draft's own folder owns its name's slot, so the lit chip is the folder
    /// in use; a folder the listing never saw still claims the slot.
    func testQuickDirsCurrentFolderTakesItsNamesSlot() {
        let dirs = [
            dir("/w/alpha/review", count: 100, daysAgo: 10),
            dir("/w/beta/review", count: 90, daysAgo: 1),
            dir("/w/notes", count: 50, daysAgo: 3),
        ]
        XCTAssertEqual(PathRanking.quickDirs(dirs, current: ("/w/alpha/review", "")).map(\.cwd),
                       ["/w/alpha/review", "/w/notes"])
        XCTAssertEqual(PathRanking.quickDirs(dirs, current: ("/fresh/review", "")).map(\.cwd),
                       ["/fresh/review", "/w/notes"])
        XCTAssertEqual(PathRanking.quickDirs(dirs, current: ("/w/alpha/review", "box")).map(\.cwd),
                       ["/w/beta/review", "/w/notes"], "same path on another host is another folder")
        XCTAssertEqual(PathRanking.quickDirs(dirs, current: ("", "")).map(\.cwd), ["/w/beta/review", "/w/notes"])
    }

    /// A lit chip that several checkouts share still spells out the path.
    func testPathSummaryShowsWhenTheLitChipNameIsShared() {
        let dirs = [dir("/w/alpha/review", count: 100, daysAgo: 10), dir("/w/beta/review", count: 90, daysAgo: 1),
                    dir("/w/notes", count: 5, daysAgo: 1)]
        let chips = PathRanking.quickDirs(dirs, current: ("/w/alpha/review", ""))
        XCTAssertTrue(NewSessionChatView.showsPathSummary(cwd: "/w/alpha/review", host: "", quickDirs: chips, allDirs: dirs))
        XCTAssertFalse(NewSessionChatView.showsPathSummary(cwd: "/w/notes", host: "", quickDirs: chips, allDirs: dirs))
        let slash = [dir("/w/notes", count: 5, daysAgo: 1), dir("/w/notes/", count: 1, daysAgo: 2)]
        XCTAssertFalse(NewSessionChatView.showsPathSummary(
            cwd: "/w/notes", host: "", quickDirs: PathRanking.quickDirs(slash), allDirs: slash),
            "one folder spelled with and without a trailing slash is not a shared name")
    }

    /// Most-used first (ties broken by recency, never by array order), then the
    /// most recent of the rest, with the web's 4+4 cap.
    func testQuickDirsAreTopByCountThenTopByRecencyCappedAtFourPlusFour() {
        var dirs: [SessionLaunchOptions.Dir] = []
        for i in 0..<6 { dirs.append(dir("/used/u\(i)", count: 100 - i, daysAgo: 30 + Double(i))) }
        for i in 0..<6 { dirs.append(dir("/recent/r\(i)", count: 1, daysAgo: Double(i))) }
        let quick = PathRanking.quickDirs(dirs)
        XCTAssertEqual(quick.map(\.cwd), [
            "/used/u0", "/used/u1", "/used/u2", "/used/u3",
            "/recent/r0", "/recent/r1", "/recent/r2", "/recent/r3",
        ])
    }

    func testQuickDirsTieOnCountBreaksOnRecencyNotArrayOrder() {
        let dirs = [
            dir("/older", count: 7, daysAgo: 5),
            dir("/newer", count: 7, daysAgo: 1),
        ]
        XCTAssertEqual(PathRanking.quickDirs(dirs).map(\.cwd), ["/newer", "/older"])
    }

    /// A short listing is shown whole; an empty one yields no row at all.
    func testQuickDirsWithFewerCandidatesThanTheCap() {
        let dirs = [dir("/a", count: 3, daysAgo: 1), dir("/b", count: 1, daysAgo: 2)]
        XCTAssertEqual(PathRanking.quickDirs(dirs).map(\.cwd), ["/a", "/b"])
        XCTAssertTrue(PathRanking.quickDirs([]).isEmpty)
    }

    /// A pick must not reshuffle the row: membership is a pure function of the
    /// listing, so the same input gives the same chips in the same order.
    func testQuickDirsAreStableForTheSameListing() {
        let dirs = (0..<10).map { dir("/d/\($0)", count: ($0 * 7) % 5, daysAgo: Double(($0 * 3) % 7)) }
        XCTAssertEqual(PathRanking.quickDirs(dirs).map(\.id), PathRanking.quickDirs(dirs).map(\.id))
    }

    /// An unparseable stamp sorts last rather than poisoning the comparison.
    func testQuickDirsUnparseableStampSortsLast() {
        let bad = SessionLaunchOptions.Dir(cwd: "/bad", host: "", hostLabel: nil, lastUsed: "not a date", count: 1)
        let good = dir("/good", count: 1, daysAgo: 100)
        XCTAssertEqual(PathRanking.quickDirs([bad, good]).map(\.cwd), ["/good", "/bad"])
    }

    // MARK: - Quick chip label (DraftLaunchBar.tsx useQuickChipHostLabels)

    /// A lone chip is a bare folder name; a host appears only to tell two chips
    /// with the same basename apart, and then on BOTH of them.
    func testQuickChipLabelAddsTheHostOnlyOnABasenameCollision() {
        let local = dir("/Users/me/walnut", count: 9, daysAgo: 1)
        let remote = dir("/home/me/walnut", host: "box", hostLabel: "Build box", count: 3, daysAgo: 2)
        let lone = dir("/Users/me/notes", count: 2, daysAgo: 3)
        let chips = [local, remote, lone]
        XCTAssertEqual(PathRanking.quickChipLabel(local, among: chips, hostLabel: nil), "walnut · Mac")
        XCTAssertEqual(PathRanking.quickChipLabel(remote, among: chips, hostLabel: nil), "walnut · Build box")
        XCTAssertEqual(PathRanking.quickChipLabel(lone, among: chips, hostLabel: nil), "notes")
    }

    /// The live host label wins over the wire's, which wins over the raw alias;
    /// the collision check is case-insensitive like the web's.
    func testQuickChipLabelHostNamePrecedenceAndCaseInsensitiveCollision() {
        let a = dir("/x/Walnut", host: "box", hostLabel: "Wire label", count: 1, daysAgo: 1)
        let b = dir("/y/walnut", host: "other", hostLabel: nil, count: 1, daysAgo: 1)
        let chips = [a, b]
        XCTAssertEqual(PathRanking.quickChipLabel(a, among: chips, hostLabel: "Live label"), "Walnut · Live label")
        XCTAssertEqual(PathRanking.quickChipLabel(a, among: chips, hostLabel: nil), "Walnut · Wire label")
        XCTAssertEqual(PathRanking.quickChipLabel(b, among: chips, hostLabel: nil), "walnut · other")
        XCTAssertEqual(PathRanking.quickChipLabel(a, among: chips, hostLabel: ""), "Walnut · Wire label",
                       "an empty live label is absent, not a name")
    }

    // MARK: - The full path is shown only when no chip is lit for it

    func testPathSummaryShowsOnlyWhenTheFolderIsNotAQuickChip() {
        let chips = [dir("/Users/me/walnut", count: 9, daysAgo: 1),
                     dir("/home/me/infra", host: "box", count: 3, daysAgo: 2)]
        XCTAssertFalse(NewSessionChatView.showsPathSummary(cwd: "", host: "", quickDirs: chips),
                       "nothing chosen, nothing to spell out")
        XCTAssertFalse(NewSessionChatView.showsPathSummary(cwd: "/Users/me/walnut", host: "", quickDirs: chips),
                       "the lit chip and the pill already say it")
        XCTAssertFalse(NewSessionChatView.showsPathSummary(cwd: "/home/me/infra", host: "box", quickDirs: chips))
        XCTAssertTrue(NewSessionChatView.showsPathSummary(cwd: "/Users/me/elsewhere", host: "", quickDirs: chips),
                      "a hand-picked folder outside the row is spelled out")
        XCTAssertTrue(NewSessionChatView.showsPathSummary(cwd: "/Users/me/walnut", host: "box", quickDirs: chips),
                      "same path on another host is another folder")
        XCTAssertTrue(NewSessionChatView.showsPathSummary(cwd: "/Users/me/walnut", host: "", quickDirs: []),
                      "no row at all: the path is the only statement of where it runs")
    }

    /// A fresh draft opens on the FIRST CHIP, not on the server list's head: the two
    /// differ when the head is neither most-used nor most-recent, and a preselect
    /// outside the row would light no chip and bring the full path back on open.
    func testPreselectIsTheFirstQuickChip() {
        var dirs = [dir("/server-head", count: 5, daysAgo: 10)]
        for i in 0..<4 { dirs.append(dir("/used/u\(i)", count: 100 - i, daysAgo: 30)) }
        for i in 0..<4 { dirs.append(dir("/recent/r\(i)", count: 1, daysAgo: Double(i))) }
        let picked = NewSessionChatView.preselectedDir(dirs)
        XCTAssertEqual(picked?.cwd, "/used/u0")
        XCTAssertEqual(picked?.id, PathRanking.quickDirs(dirs).first?.id)
        XCTAssertFalse(NewSessionChatView.showsPathSummary(cwd: picked!.cwd, host: picked!.host,
                                                           quickDirs: PathRanking.quickDirs(dirs)))
        XCTAssertNil(NewSessionChatView.preselectedDir([]))
    }
}
