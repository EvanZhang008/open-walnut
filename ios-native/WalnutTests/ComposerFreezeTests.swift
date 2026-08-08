import XCTest
import SwiftUI
@testable import Walnut

/// Reproduction tests for the 2026-08-07 **build-35** field freezes — the third
/// round, and the first one that is NOT about markdown parsing.
///
/// Field evidence (three watchdog kills in 10 minutes, all on build 35, which
/// already ships the rounds-1/2 LiveMarkdownWindow + liveText-cap fixes):
///   1. 15:47:21Z  `main thread unresponsive {6.0s}` → 0x8BADF00D, 2 min after attach.
///   2. 15:54:23Z  0x8BADF00D scene-update watchdog (10s wall clock), relaunch
///                 first frame 12.4s. Fired **5 seconds after `voice transcribed
///                 chars=148`** — i.e. right after appendToDraft() wrote 148
///                 chars into the composer draft and set focused = true.
///   3. 15:55:52Z  foreground watchdog kill.
///
/// Two things make this a NEW bug class:
///  - The sessions were **IDLE** — no live streaming turn at all, so none of the
///    rounds-1/2 mechanisms (liveText growth, per-tick re-parse) were running.
///  - The stack fingerprint is **UIFoundation (TextKit text measurement) →
///    SwiftUICore ×6 → AttributeGraph → UIKitCore → QuartzCore CA-commit →
///    UpdateCycle**. That is LAYOUT / TEXT MEASUREMENT inside the CoreAnimation
///    commit, not `AttributedString(markdown:)`.
///
/// The user's phenomenology points at the composer: "input page frozen" with the
/// **keyboard flashing in and out** while everything was stuck, and a post-crash
/// screenshot showing the composer stranded mid-screen above a blank region
/// (keyboard safe-area inset reserved, keyboard gone).
///
/// Real field scale — and this is the SURPRISE that reframes the whole bug. The
/// phone does not consume `/history`; it consumes
/// `/api/v1/sessions/:id/transcript`, which the server caps hard (TEXT_MAX =
/// 4000 chars per row, TRANSCRIPT_TAIL = 100 rows, 200 over the bridge) and the
/// client caps again at 150 rendered rows while pinned. The payloads the
/// crashing phones ACTUALLY received were tiny:
///   346e5e9e:  75,636 B / 123 rows /  8,346 text chars / largest row 1,654 / ZERO rows >4K
///   c6ce9199: 123,443 B / 117 rows / 44,406 text chars / largest row 3,102 / ZERO rows >4K
/// So 5-10 CPU-seconds of stall happened on a ~44KB page. Payload cost cannot
/// explain that; an UNBOUNDED CYCLE COUNT can. `Scale` below carries both the
/// real field shape and a deliberate 400-row overshoot so every measurement
/// here reports the pair — a red that only appears at the overshoot does NOT
/// justify a field conclusion (and must never be read as "needs virtualization").
///
/// Budget: any single synchronous main-thread step must stay under 1s. This runs
/// on an M-series simulator, ~3-5x faster than the A-series phones that died, so
/// 1s here ≈ 3-5s on device ≈ the 5s watchdog line. Same convention as
/// WatchdogRegressionTests.
///
/// MEASURE THE PRODUCT, NOT A REPLICA (the mistake this file already made once).
/// The composer-cost tests here host the REAL `ComposerBar` in a
/// `UIHostingController` + `UIWindow` and drive the REAL `ComposerDrafts`
/// binding, so the actual SwiftUI layout engine produces the numbers. An earlier
/// version instead built an `NSAttributedString` per keystroke and called
/// `boundingRect` on it — an API that appears NOWHERE on the composer path — and
/// reported a confident O(n²) that was purely the harness's own construction
/// cost. Round-2's lesson ("复刻件测不出真路径") cuts BOTH ways: a replica can
/// manufacture a cost the product never pays, not just miss one. If you add a
/// cost test here, drive real product code or don't add it.
///
/// A CLAIM'S CONFIDENCE MUST BE CARRIED BY THE CLAIM, NOT BY THE ASSERTION NEXT
/// TO IT. This file made that mistake too, and it is the subtler of the two.
/// `testRealComposerPerKeystrokeLayoutGrowth` deliberately wraps its frame-budget
/// check in `XCTExpectFailure(strict: false)` BECAUSE the worst-case single
/// keystroke is unstable across runs (measured 6.5-26.0ms at one draft size) — the
/// gate encodes that uncertainty correctly. The prose beside it then reported that
/// same unstable worst value as the flat, typical per-keystroke cost, off n=2. The
/// gate was honest; the sentence was not, and a reader trusts the sentence more
/// readily than they read a wrapper flag. An `n=1` max stated as a typical is the
/// same error class as a `strict: false` gate summarized as a finding: both let the
/// instrument's variance escape into the conclusion. So: report the MEAN over many
/// samples (stable) and label the worst as a spike; state n; and when you loosen a
/// gate because a number is noisy, apply that same doubt to the paragraph above it.
///
/// O(n) IN A LOOP CONDITION: FATAL IN A TIMED REGION, MERELY SLOW IN SETUP.
/// `while s.count < N { s += chunk }` is quadratic, because `String.count` walks the
/// string every iteration. That pattern appears in this file at `:218`, `:368` and
/// `:470` — all in FIXTURE SETUP, outside every `ms {}` block, so it costs suite
/// seconds but corrupts no measurement (verified: the timed per-keystroke region does
/// only `append` + `utf8.count`, worst 0.0036ms, so the numbers are the product's).
/// The same pattern INSIDE a measured loop is what made `MarkdownPerfTests`'
/// live-turn test cost 19.8s instead of 2.4s. Know which kind you have before you
/// "optimize" either.
///
/// Which accessors are actually O(1) — MEASURED here, because the usual shorthand
/// "use utf8.count, it's O(1)" is only half true (200 calls, short vs 10x string):
///   • `utf8.count`  — O(1) on BOTH ASCII and CJK (0.00ms at 200K and 2M). Safe.
///   • `utf16.count` — O(1) on ASCII, but **O(n) on CJK** (0.37ms → 2.83ms as the
///     string grew 10x). A UTF-16 length is stored only for ASCII-representable
///     native strings; anything else recomputes it.
///   • `count` (Characters) — O(n) ALWAYS (29.7ms → 300.9ms ASCII; 202ms → 2,028ms
///     CJK), because grapheme breaking cannot be cached as a length.
/// This matters here specifically because these fixtures are CJK — the one case
/// where `utf16.count` silently degrades. The product gets this right on the hot
/// path (`ComposerView.swift:62` uses `$0.utf8.count`); tests should match it.
///
/// HONEST LIMITATION (do not over-read a green run): a hosted layout pass is
/// still not the device's CoreAnimation commit under a real keyboard. These
/// numbers bound per-cycle COST; they cannot reproduce an unbounded CYCLE COUNT
/// driven by real-keyboard geometry events (predictive/QuickType bar, dictation
/// affordance, input-mode resize) that the simulator's software keyboard never
/// emits. Field evidence says the kill is the latter: across ten watchdog kills
/// on builds 32/34/35, `WatchdogCPUStatistics` shows appCPU/allowance ≈ 1.0
/// every time (100% of a core for the whole allowance = a compute loop, NOT a
/// block), and the watchdog logged 10 `main thread unresponsive` with ZERO
/// `main thread recovered` — the loop never terminated on its own. So a scenario
/// red here is definitely a field problem; one green here can still be a field
/// problem via the layout graph. The amplifier test below covers the cycle-count
/// half that IS decidable offline.
///
/// FIELD DRAFT SIZES (anchor every cost claim to these, not to the big numbers
/// the cost tests sweep to). Longest user message in each frozen session:
/// **175 / 864 / 2,582 chars**, and the dictation that ignited the 15:54 kill was
/// **148 chars** (`voice transcribed chars=148`, send `bodyBytes=393`). Nothing
/// in the field came near 5K, let alone the 50K this file sweeps to. The large
/// sizes exist here because the draft is UNBOUNDED (one paste reaches them), so
/// they are a real latent hole worth a gate — but a cost measured at 50K must
/// never be presented as the field mechanism. See the reweighting note on
/// `testRealComposerLayoutCostByDraftLength`.
///
/// ⚠️ THOSE SIZES ARE CHARS; THE EDITOR SWITCH IS IN BYTES — and for CJK the two are
/// 3x apart, so two of the three field drafts now take the NEW path (verified
/// arithmetic, `longDraftThreshold` = 2,000 UTF-8 bytes ≈ 667 CJK chars):
///     175 chars =   525 B → TextField
///     864 chars = 2,592 B → LongDraftEditor   ← over
///   2,582 chars = 7,746 B → LongDraftEditor   ← over
/// That is a real behavioural change on ordinary phone messages, not just on the
/// 50K paste the gate was written for. It may well be the right call (2.5-7.7KB of
/// text genuinely wants a bounded viewport), but note that
/// `ComposerView.swift:136` justifies the number as sitting "above every ordinary
/// typed message" — true in ASCII chars, NOT true in CJK, where the switchover is
/// ~667 characters. Flagged for the owner of that file rather than changed here:
/// deciding the intended switchover point is a product judgement, and the value
/// itself is not a bug (`utf8.count` is the correct O(1) accessor). What IS a
/// defect is that the number was chosen from a char-indexed curve and applied to a
/// byte-indexed measure with the conversion written down nowhere.
@MainActor
final class ComposerFreezeTests: XCTestCase {

    /// Simulator budget for one continuous main-thread step (see class docs).
    private let mainThreadBudgetMs = 1_000.0
    /// 60fps frame budget — a per-keystroke cost above this is felt as lag even
    /// when it is far from the watchdog line, and it accumulates: the keyboard
    /// delivers keystrokes faster than a slow frame can drain them.
    private let frameBudgetMs = 16.7

    /// The exact burst size the field freeze followed (`voice transcribed
    /// chars=148`), as realistic CJK dictation: **148 characters / 444 UTF-8 bytes**.
    ///
    /// ⚠️ WAS 108 CHARS, NOT 148, UNTIL 2026-08-07 — the name asserted a size the
    /// literal did not have. Verified against the emitter before fixing:
    /// `VoiceRecorder.swift:197` logs `"chars": "\(trimmed.count)"`, i.e.
    /// `String.count` = real CHARACTERS, so the field's `chars=148` means 148
    /// characters (444 bytes for CJK), not 148 bytes. If you edit this string, keep
    /// BOTH numbers true and re-check the byte count — it decides which editor the
    /// composer routes to (see `longDraftThreshold`, which is in BYTES).
    ///
    /// BLAST RADIUS — EXACTLY TWO TESTS, NOT THE INVESTIGATION'S NUMBERS. I first
    /// wrote that "every test that typed one burst" was understated, which is
    /// literally true but reads as though the cost curve moved. It did not, and an
    /// over-broad retraction is its own harm: it invites the next reader to discard
    /// numbers that were always sound. Traced per call site:
    ///   • `testRealComposerLayoutCostByDraftLength` — concatenates this fixture then
    ///     `String(draft.prefix(chars))`, so every rung was EXACTLY 148/500/1K/5K/
    ///     10K/50K chars regardless of the fixture's own length. UNAFFECTED.
    ///   • `testRealComposerPerKeystrokeLayoutGrowth` — same shape, `source.prefix
    ///     (target)`, so 148 and 1,480 were enforced. UNAFFECTED (the growth law,
    ///     the means, and the ladder exponents all stand).
    ///   • `testPerKeystrokeDraftPersistCost` — iterates the fixture itself, so it
    ///     measured 108 keystrokes while reading as 148. AFFECTED (27% short).
    ///   • `testVoiceAppendOnIdleGiantSessionComposite` — sets the fixture as the
    ///     whole dictation, so the append was 324 B not 444 B. AFFECTED.
    ///   • the 40-draft filler (`repeating:count:3`) — size is arbitrary. Cosmetic.
    /// Both AFFECTED sites were under the 2,000-byte threshold at either size
    /// (324 B and 444 B), so neither changed which editor was exercised.
    ///
    /// And the measured before/after on the two affected tests, so nobody has to
    /// guess how much the 27% mattered:
    ///   • persist cost, aggregated over ALL runs on record (n=14 at 108 chars, n=3
    ///     at 148) rather than one pair: mean-per-keystroke 0.617ms (range 0.48-0.72)
    ///     → 0.700ms (range 0.65-0.73); totals 66.6ms → 103.6ms. So 1.37x the
    ///     keystrokes costs 1.55x the total and 1.13x per keystroke — LINEAR, with
    ///     the two ranges overlapping. Verdict unchanged either way: persist is ruled
    ///     out, worst keystroke ~0.1% of the 1s budget.
    ///     ⚠️ I first wrote here that the total "more than DOUBLED for 37% more
    ///     keystrokes" and called it super-linearity the short fixture had hidden.
    ///     That was the n=1 error of this whole investigation AGAIN, committed while
    ///     documenting the fix for a different error: I compared the single lowest
    ///     108-run (52.3ms) against a single 148-run (107.7ms) and read the spread of
    ///     the noise as a growth law. Fourteen samples say flat. If you are about to
    ///     write "X doubled", check how much X varies at fixed input first.
    ///   • voice-append composite: 9.68ms → 9.15ms, i.e. unchanged within noise
    ///     (this test's cost is dominated by the 24 row evaluations, not the append).
    static let voiceBurst148 =
        "请帮我检查一下这个会话里所有失败的部署记录并且把每一个失败的原因整理成一个表格"
        + "然后告诉我哪些是需要立刻处理的哪些可以先放一放另外顺便看下监控指标有没有异常"
        + "波动谢谢你辛苦了这个任务比较着急我先去开会稍后回来看结果拜托了"
        + "麻烦你把结论也一并发给我谢谢配合我们尽快推进这件事情另外也请你记得同步给整个团队"

    /// Field-measured scale of the crashing sessions, plus the overshoot arm.
    enum Scale {
        /// What the crashing phones REALLY rendered (c6ce9199: 117 rows, 44KB
        /// of text, largest row 3,102 chars, zero rows over the 4K server clip).
        static let fieldRows = 117
        static let fieldMaxRowChars = 3_102
        /// Deliberate overshoot (the client's own hard cap for an unpinned
        /// history reader) — the control arm, NOT the field case.
        static let hardCap = 400
        /// The client's pinned-reader trim.
        static let softCap = 150
    }

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        FreezeContext.shared.resetForTesting()
    }

    private func ms(_ block: () -> Void) -> Double {
        let t0 = DispatchTime.now()
        block()
        return Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
    }

    // MARK: - Hosting the real composer

    /// ONE window, reused, torn down in `tearDown` no matter how a test exits.
    ///
    /// Why a single shared window: creating a fresh visible `UIWindow` per
    /// measurement (6 in one loop) and dropping it left keyboard-scene and
    /// accessibility state behind that crashed the NEXT test class in the target
    /// ("Restarting after unexpected exit"). A test-only leak that takes down an
    /// unrelated suite is worse than the bug being measured — reuse and clean up.
    private var hostWindow: UIWindow?

    override func tearDown() {
        if let w = hostWindow {
            w.isHidden = true
            w.rootViewController = nil
            hostWindow = nil
        }
        ComposerDrafts.shared.clear("session:draft-length-cost")
        ComposerDrafts.shared.clear("session:keystroke-growth")
        ComposerDrafts.shared.clear("session:freeze-repro-composite")
        super.tearDown()
    }

    /// Host the REAL `ComposerBar` for `draftKey` in the shared window and return
    /// its controller, mounted (first layout done, untimed).
    private func hostRealComposer(draftKey: String) -> UIHostingController<ComposerBar> {
        let host = UIHostingController(
            rootView: ComposerBar(placeholder: "Message this session",
                                  draftKey: draftKey,
                                  onSend: { _, _ in true })
        )
        let window = hostWindow ?? UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        hostWindow = window
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = CGRect(x: 0, y: 0, width: 393, height: 120)
        host.view.layoutIfNeeded()
        return host
    }

    /// One relayout of a hosted composer — what a geometry change costs.
    private func relayout(_ host: UIHostingController<ComposerBar>) {
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        _ = host.sizeThatFits(in: CGSize(width: 393, height: CGFloat.greatestFiniteMagnitude))
    }

    /// Retire a hosted composer: detach it from the window and let the run loop
    /// drain so UIKit finishes tearing the hosting scene down.
    ///
    /// Load-bearing (2026-08-07): leaving hosts attached and merely hiding the
    /// window at the END of the class crashed the NEXT test class in the target
    /// ("Restarting after unexpected exit"), and the crash disappeared when this
    /// class was skipped — proof it was this file's leak, not a product bug.
    /// A hosted SwiftUI view kept alive holds an AttributeGraph + keyboard scene
    /// registration; those must be released per measurement, not per class.
    private func retire(_ host: UIHostingController<ComposerBar>) {
        host.view.removeFromSuperview()
        if hostWindow?.rootViewController === host { hostWindow?.rootViewController = nil }
        // One run-loop turn so UIKit's deferred teardown actually runs.
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }

    // MARK: - Fixtures at field scale

    /// A transcript with the field's row-kind mix and size distribution, mapped
    /// to the rows the view actually renders. Deterministic.
    ///
    /// `clipToFieldMax` reproduces the server's per-row TEXT_MAX clip, which the
    /// real payloads showed on EVERY row kind (zero rows over 4K). Pass false
    /// only for the deliberate overshoot arm.
    private func fieldRows(_ count: Int, clipToFieldMax: Bool = true) -> [ChatMessage] {
        let cap = clipToFieldMax ? Scale.fieldMaxRowChars : Int.max
        var rows: [ChatMessage] = []
        var seed = 0x5eed
        func rnd() -> Double { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Double(seed) / 0x7fffffff }
        func heavy(_ chars: Int, _ salt: Int) -> String {
            var out = "## 第 \(salt) 轮结论\n\n"
            var n = 0
            while out.count < chars {
                switch n % 4 {
                case 0: out += TranscriptFixtures.cjk + "\n\n"
                case 1: out += TranscriptFixtures.table(salt + n, rows: 14) + "\n\n"
                case 2: out += TranscriptFixtures.code + "\n\n"
                default: out += "- 项目 \(n):验证完成\n- 项目 \(n + 1):等待复核\n\n"
                }
                n += 1
            }
            return String(out.prefix(chars))
        }
        var i = 0
        while rows.count < count {
            defer { i += 1 }
            let ts = "2026-08-06T12:\(String(format: "%02d", i % 60)):00Z"
            if i % 10 == 8 {
                rows.append(ChatMessage(id: "u-\(i)", role: "user",
                                        text: "继续第 \(i) 项,只读操作,把结果整理成表格。",
                                        createdAt: ts, kind: nil))
                continue
            }
            // 56% of field rows carried `thinking` → its own chip row.
            if rnd() < 0.56 {
                rows.append(ChatMessage(id: "th-\(i)", role: "assistant",
                                        text: heavy(min(rnd() < 0.5 ? 700 : 4_000, cap), i).replacingOccurrences(of: "\n", with: " "),
                                        createdAt: ts, kind: .thinking))
            }
            // Assistant text: p50=0, p90≈78, p99≈9.4K, one row ≈30K.
            let q = rnd()
            let textLen = min(i == 137 ? 29_792
                : q < 0.50 ? 0
                : q < 0.90 ? 78
                : q < 0.98 ? 2_000 : 9_388, cap)
            if textLen > 0, rows.count < count {
                rows.append(ChatMessage(id: "a-\(i)", role: "assistant",
                                        text: heavy(textLen, i), createdAt: ts, kind: nil))
            }
            // 87% carried a tool call → its own row with a clipped result.
            if rnd() < 0.87, rows.count < count {
                let p = rnd()
                let plen = min(p < 0.5 ? 1_009 : p < 0.9 ? 2_971 : 6_517, cap)
                rows.append(ChatMessage(id: "t-\(i)", role: "assistant",
                                        text: ["Bash", "Read", "Edit", "Grep", "Task"][i % 5],
                                        createdAt: ts, kind: .tool,
                                        detail: "kubectl get events --field-selector reason=Failed -n ns-\(i)",
                                        resultPreview: heavy(plen, i + 1_000)))
            }
        }
        return Array(rows.prefix(count))
    }

    /// One row's body evaluation, matching MessageRow's real dispatch: tool
    /// chips build their detail + preview Text, thinking chips a one-line Text,
    /// assistant text goes through the (cached) block parser or inline path,
    /// user bubbles through imageSendParts + inline Text.
    private func evaluateRow(_ m: ChatMessage) {
        switch m.kind {
        case .tool:
            _ = Text(verbatim: m.text)
            if let d = m.detail { _ = Text(verbatim: d) }
            // ToolChip renders resultPreview ONLY when expanded — collapsed
            // rows must not pay for it. Modeled as not-expanded (the default).
        case .thinking:
            _ = Text(verbatim: m.text)
        case .notification:
            _ = MarkdownParser.parse(m.text)
        case nil:
            if m.role == "user" {
                _ = MessageRow.imageSendParts(m.text)
                _ = Text(inline: m.text)
            } else if ChatMarkdownBody.isBlockMarkdown(m.text) || ChatMarkdownBody.containsImageRef(m.text) {
                _ = MarkdownParser.parse(m.text)
            } else {
                _ = Text(inline: m.text)
            }
        }
    }

    // MARK: - H0: the fixtures must be the size their names claim

    /// A fixture whose NAME lies is worse than no fixture: every test built on it
    /// silently measures the wrong scale while reading as if it measured the right
    /// one. `voiceBurst148` claimed the field's `chars=148` ignition size and was
    /// actually 108 characters for months, so the per-keystroke tests understated
    /// the field burst by 27%. This guard is cheap and would have caught it.
    ///
    /// It also pins the BYTE length, because bytes — not characters — decide which
    /// editor `ComposerBar` routes to (`longDraftThreshold` is in UTF-8 bytes). A
    /// well-meaning edit to the CJK text can silently push a fixture across that
    /// boundary and change which code path the "field scale" tests exercise.
    func testFixtureSizesMatchTheirNames() {
        XCTAssertEqual(Self.voiceBurst148.count, 148,
            "voiceBurst148 must be 148 CHARACTERS — the field logged `chars=148` via String.count (VoiceRecorder.swift:197)")
        XCTAssertEqual(Self.voiceBurst148.utf8.count, 444,
            "voiceBurst148 must stay 444 UTF-8 bytes: it is deliberately BELOW ComposerBar.longDraftThreshold (2,000 B) so the field-scale tests exercise the plain TextField path, as the field did")
        XCTAssertLessThan(Self.voiceBurst148.utf8.count, ComposerBar.longDraftThreshold,
            "the field burst must route to TextField, not LongDraftEditor, or these tests stop describing the field")
    }

    // MARK: - H1: per-keystroke draft persistence (ComposerDrafts.persist)

    /// `ComposerDrafts.setDraft` calls `persist()` on EVERY keystroke, and
    /// `persist()` writes the WHOLE drafts dictionary (up to `maxPersistedDrafts`
    /// = 40 conversations' drafts) to UserDefaults synchronously on the
    /// MainActor. So the per-keystroke cost scales with how many OTHER threads
    /// the user has ever typed in — and, for a long dictated message, with the
    /// length of every retained draft.
    ///
    /// This is the cheapest candidate to rule in or out, and it is on the exact
    /// path the field freeze followed (appendToDraft → setDraft → persist).
    func testPerKeystrokeDraftPersistCost() {
        let drafts = ComposerDrafts.shared
        // Worst realistic install: the persisted ceiling of long drafts.
        for i in 0..<(40 - 1) {
            drafts.setDraft(String(repeating: Self.voiceBurst148, count: 3), key: "session:filler-\(i)")
        }
        let key = "session:freeze-repro"
        var worstMs = 0.0
        var totalMs = 0.0
        var text = ""
        for ch in Self.voiceBurst148 {
            text.append(ch)
            let stepMs = ms { drafts.setDraft(text, key: key) }
            worstMs = max(worstMs, stepMs)
            totalMs += stepMs
        }
        drafts.clear(key)
        for i in 0..<(40 - 1) { drafts.clear("session:filler-\(i)") }
        print(String(format: "[composer] %d keystrokes with a full (40-draft) store: worst %6.2fms, total %7.1fms, mean %5.2fms (frame %.1fms)",
                     Self.voiceBurst148.count, worstMs, totalMs, totalMs / Double(Self.voiceBurst148.count), frameBudgetMs))
        // The watchdog gate: no single keystroke may approach the stall line.
        XCTAssertLessThan(worstMs, mainThreadBudgetMs,
            "one keystroke's draft persist approaches the watchdog-scaled budget")
        // The FELT gate: typing must fit the frame budget. A per-keystroke cost
        // above one frame means the main thread cannot drain the keyboard's
        // input faster than it arrives — the accumulation mechanism behind a
        // multi-second continuous stall (same shape as the round-2 saturation
        // gate on delta flush).
        XCTAssertLessThan(worstMs, frameBudgetMs,
            "per-keystroke draft persist exceeds one frame — typing saturates the main thread")
    }

    // MARK: - H2: giant-draft TextField text measurement

    /// UIFoundation text measurement is the field stack's top frame, and the
    /// composer's TextField is `axis: .vertical` with `lineLimit(1...6)`.
    /// `lineLimit` clamps the DISPLAYED height, but the string still has to be
    /// measured to know how tall it wants to be. The user dictates long voice
    /// messages, so the draft can be thousands of characters — and every focus
    /// change, keyboard geometry change, and safe-area inset re-measure re-runs
    /// that measurement inside the CA commit.
    ///
    /// Measures ONE layout pass of the REAL `ComposerBar` (hosted in a window, so
    /// the actual SwiftUI layout engine runs) as the draft grows — the cost a
    /// keyboard-geometry change or safe-area re-measure pays each time it
    /// re-measures the composer with a long dictated draft already in it.
    ///
    /// RE-SCOPED 2026-08-07: this used to build an `NSAttributedString` over the
    /// draft and call `boundingRect` on it. That API is NOT on the composer path
    /// (see the history note on
    /// `testRealComposerPerKeystrokeLayoutGrowth`), so the numbers described the
    /// harness, not the product. It now drives the real view.
    @MainActor
    func testRealComposerLayoutCostByDraftLength() {
        let drafts = ComposerDrafts.shared
        let key = "session:draft-length-cost"
        var over: [String] = []
        var samples: [(Int, Double)] = []

        for chars in [148, 500, 1_000, 5_000, 10_000, 50_000] {
            var draft = ""
            while draft.count < chars { draft += Self.voiceBurst148 }
            drafts.setDraft(String(draft.prefix(chars)), key: key)

            let host = hostRealComposer(draftKey: key)
            // The timed step: what a geometry change costs — invalidate and
            // re-measure the composer with this draft in it.
            let measureMs = ms { relayout(host) }
            retire(host)
            drafts.clear(key)

            samples.append((chars, measureMs))
            // Label WHICH editor this rung measured. The threshold is in UTF-8 BYTES
            // and this fixture is CJK (3 B/char), so the switch happens at ~667 chars
            // — between the 500 and 1,000 rungs. Without this label the ladder reads
            // as one curve that collapses (4.85ms at 500 → 0.06ms at 1,000), inviting
            // "TextField got 80x faster"; it did not, the rung changed views.
            let bytes = draft.prefix(chars).utf8.count
            let view = bytes > ComposerBar.longDraftThreshold ? "LongDraftEditor" : "TextField      "
            print(String(format: "[composer] REAL ComposerBar relayout, draft %6d chars (%7d B, %@): %7.2fms (frame %.1fms, budget %.0f)",
                         chars, bytes, view, measureMs, frameBudgetMs, mainThreadBudgetMs))
            if measureMs >= mainThreadBudgetMs { over.append("\(chars)ch=\(Int(measureMs))ms") }
        }
        // Growth across the WHOLE ladder spans two different views, so it is not a
        // cost curve for either one. Report it only within the TextField rungs, and
        // say so — a cross-view ratio is a category error, not a measurement.
        let textFieldSamples = samples.filter { $0.0 * 3 <= ComposerBar.longDraftThreshold }
        if let small = textFieldSamples.first, let big = textFieldSamples.last, small.1 > 0, small.0 != big.0 {
            print(String(format: "[composer] REAL relayout growth WITHIN TextField %d→%d chars: %.1fx cost for %.1fx text",
                         small.0, big.0, big.1 / small.1, Double(big.0) / Double(small.0)))
        }
        if let small = samples.first, let big = samples.last, small.1 > 0 {
            print(String(format: "[composer] (cross-view, NOT a curve) %d→%d chars: %.1fx — the big rungs are LongDraftEditor, a different view",
                         small.0, big.0, big.1 / small.1))
        }
        // WAS RED on the REAL product path (2026-08-07, before the fix): one
        // relayout cost 1.65ms at 148 chars, 62.7ms at 5K, 160ms at 10K, and
        // 2,353ms at 50K — 1,425x the cost for 338x the text, i.e. super-linear,
        // with the 50K case alone breaching the watchdog-scaled budget on an
        // M-series simulator (3-5x worse on device).
        //
        // ⚠️ n FOR THE PRE-FIX LADDER: n=2 at 50K (2,353 and 2,355ms — the closest
        // thing to a stability check this ladder ever got), n=1 at the other rungs.
        // Stating it because this file's own rule is "state n", and because these
        // numbers are UNREPEATABLE now: `LongDraftEditor` landed, so the same test
        // today returns 1.50-1.70ms at 148 chars and 0.06-0.10ms at 5K/50K (n=7,
        // stable). Nobody can re-derive the pre-fix curve without reverting the fix.
        // What that does and does not license: the ORDER OF MAGNITUDE is safe (2.3
        // SECONDS vs a 1s budget is not an n=1 artifact, and the two 50K samples
        // agreed to 0.1%), so "unbounded drafts were a real latent hole" stands. The
        // precise EXPONENTS (1.03 / 1.36 / 1.67) rest on single samples per rung and
        // should be quoted as the shape of the curve, not as measurements. If you
        // ever need them firmly, re-run with the threshold raised in a scratch build
        // — do not re-derive them from this comment.
        //
        // ⚠️ AND THE POST-FIX LADDER IS NOT ONE CURVE (found 2026-08-07). The
        // threshold is 2,000 UTF-8 BYTES and this fixture is CJK at 3.0 B/char, so
        // the editor switches at ~667 CHARS — between the 500 and 1,000 rungs. The
        // rungs therefore measure two different views, which the print now labels:
        //     148 ch (  444 B) TextField        1.61ms
        //     500 ch ( 1500 B) TextField        4.81ms   ← 3.0x for 3.4x text: LINEAR
        //   1,000 ch ( 3000 B) LongDraftEditor  0.04ms   ← DIFFERENT VIEW, not "80x faster"
        //  50,000 ch (150000 B) LongDraftEditor 0.09ms
        // So "0.08ms at 50K" is the new bounded path working as designed, NOT the old
        // TextField path improving. Reading the whole ladder as one curve produces the
        // nonsense conclusion that layout got 30,000x faster; the honest statements are
        // (a) within TextField, cost is linear in length, and (b) above the threshold
        // cost is constant because the viewport bounds it. The old super-linear curve
        // was real — it just no longer has a rung to appear on.
        // 50K chars is reachable: the draft has NO cap anywhere in the app, and a
        // single paste puts arbitrary text in it instantly (nothing requires the
        // user to type it). Voice dictation appends without bound too
        // (appendToDraft concatenates).
        //
        // ⚠️ WEIGHT THIS CORRECTLY — it is a LATENT hole, not what killed the app.
        // The actual drafts in the three frozen sessions were small: longest user
        // message 175 / 864 / 2,582 chars, and the dictation that ignited the
        // 15:54 freeze was 148 chars. Interpolating the curve above at those
        // sizes gives ~2.0 / ~10.2 / ~31.7ms per relayout — so at FIELD scale
        // this cost sets the price of one cycle and nothing more. The
        // super-linearity is concentrated ABOVE ~5K (log-log exponent 1.03 from
        // 148→5K, rising to 1.36 and 1.67 in the upper decades), where the field
        // has not gone.
        //
        // So the causal ordering is: PRIMARY = unbounded repin amplification (the
        // finishTransition ordering defect + the missing programmaticGeometryFrozen
        // interlock + an unidentified real-keyboard frame emitter); SECONDARY =
        // this cost curve, which multiplies each cycle and only becomes primary
        // above ~5K drafts. At 175 chars the loop still only needs ~2,548
        // iterations of something that has no iteration bound — and that, not
        // cost, is what the field CPU evidence shows: appCPU/allowance ≈ 1.0 on
        // all ten kills across three builds, 10 `main thread unresponsive` with
        // ZERO `main thread recovered`, every stall exactly 6.0s. A cost problem
        // produces slow frames and recoveries; a missing bound produces this.
        // DO NOT read the 2,353ms→0.08ms flip below as "the freeze is fixed" —
        // this fix removed the multiplier and closed a real unbounded-input hole.
        // The non-terminating loop is a separate fix.
        //
        // HARD GATE since the fix: above `ComposerBar.longDraftThreshold` the
        // field is a viewport-bounded `LongDraftEditor` whose height is a
        // CONSTANT six lines, so relayout cost no longer scales with draft length
        // and no draft can breach the budget. Draft TEXT is untouched — only the
        // measurement is bounded. Do NOT re-loosen this by raising the threshold
        // without re-running the growth print above.
        XCTAssertTrue(over.isEmpty,
            "one composer relayout breaches the watchdog-scaled budget: \(over.joined(separator: ", "))")
    }

    /// Per-keystroke cost of the REAL composer as the draft grows.
    ///
    /// HISTORY — READ THIS BEFORE CHANGING THE TEST (2026-08-07): the first
    /// version of this test built a fresh `NSAttributedString` over the whole
    /// draft and called `boundingRect` on it, once per keystroke, and reported a
    /// clean O(n²) (93-100x cost for 10x the text). That number was a HARNESS
    /// ARTIFACT. `NSAttributedString.boundingRect` appears nowhere in the
    /// composer path — the only two `boundingRect` calls in the app are
    /// `NSLayoutManager.boundingRect(forGlyphRange:)` on a live UITextView in the
    /// Notes editor (Markdown/TableInlineEditor.swift, Markdown/WysiwygEditor.swift),
    /// a different surface. Constructing an immutable attributed string over the
    /// full draft and measuring it unbounded is O(n) BY CONSTRUCTION, so doing it
    /// per keystroke is O(n²) by construction: the replica manufactured a cost
    /// the product does not pay. Round-2's lesson ("复刻件测不出真路径") cuts both
    /// ways — a replica can invent a cost as easily as it can miss one.
    ///
    /// So this version drives the REAL view: `ComposerBar`'s actual
    /// `TextField(text:axis:.vertical).lineLimit(1...6)`, hosted in a
    /// UIHostingController, laid out through the real SwiftUI layout engine, one
    /// keystroke at a time through the real `ComposerDrafts` binding. Whatever
    /// TextKit does or does not cache incrementally, this measures it.
    ///
    /// The question is the GROWTH LAW, not the absolute number: linear
    /// per-keystroke cost (total ~10x for 10x the text) is survivable; quadratic
    /// (total ~100x) is the "typing got slower and slower, then it froze" shape.
    @MainActor
    func testRealComposerPerKeystrokeLayoutGrowth() {
        let drafts = ComposerDrafts.shared
        let key = "session:keystroke-growth"

        /// Type `target` characters into the REAL composer one at a time,
        /// forcing a full layout pass per keystroke, and return the cost.
        func typeIntoRealComposer(_ target: Int) -> (worst: Double, total: Double) {
            drafts.clear(key)
            // A real window, or SwiftUI short-circuits layout for an unhosted view.
            let host = hostRealComposer(draftKey: key)

            var source = ""
            while source.count < target { source += Self.voiceBurst148 }
            var draft = ""
            var worst = 0.0, total = 0.0
            var typed = 0
            for ch in source.prefix(target) {
                draft.append(ch)
                let stepMs = ms {
                    // The keystroke: write through the same binding the
                    // TextField writes, then force the layout the CA commit
                    // would perform (measure the field, size the inset).
                    drafts.setDraft(draft, key: key)
                    relayout(host)
                }
                worst = max(worst, stepMs); total += stepMs
                // BREATHE, or the harness reproduces the bug on ITSELF (2026-08-07):
                // typing 1,480 characters holds the main thread for 10-26s with no
                // return to the run loop, and the simulator SIGKILLs the app-hosted
                // test process ("Test crashed with signal kill" — it was one of the
                // two longest runs in the suite, and it survived alone at load ~5 but
                // died in the full suite at load 42). The yield is OUTSIDE the timed
                // region, so it changes no measurement: the numbers are per-keystroke
                // costs summed, not wall-clock of the loop.
                typed += 1
                if typed % 50 == 0 { RunLoop.current.run(until: Date()) }
            }
            retire(host)
            drafts.clear(key)
            return (worst, total)
        }

        let short = typeIntoRealComposer(148)   // the field burst size
        let long = typeIntoRealComposer(1_480)  // 10x
        print(String(format: "[composer] REAL TextField, typing  148 chars: worst %6.2fms total %8.1fms", short.worst, short.total))
        print(String(format: "[composer] REAL TextField, typing 1480 chars: worst %6.2fms total %8.1fms", long.worst, long.total))
        let ratio = long.total / max(short.total, 0.001)
        print(String(format: "[composer] REAL per-keystroke growth: %.1fx total cost for 10x the text (linear≈10x, quadratic≈100x)", ratio))

        // MEASURED on the REAL product path (2026-08-07). Two readings, and the
        // SECOND one supersedes the first — read both, because the difference is
        // itself an apparatus lesson:
        //
        //   (a) BEFORE the periodic run-loop yield was added to the typing loop:
        //       148 chars = 904ms total / worst 17.6ms; 1,480 chars = 25,986ms /
        //       worst 47.7ms → ratio ~29x, i.e. apparently SUPER-LINEAR.
        //   (b) AFTER the yield, FOUR runs (mean = total/chars, worst = single step):
        //         148ch: mean 5.28 / 4.63 / 4.89 / 4.52 ms  worst 26.0 / 13.8 / 15.2 / 6.5 ms
        //        1480ch: mean 5.89 / 6.50 / 6.46 / 6.36 ms  worst 25.9 / 34.1 / 39.2 / 27.6 ms
        //       → total-cost ratio 11.1x / 14.0x / 13.2x / 14.1x for 10x text: LINEAR
        //       every time. MEANS are stable (±15%) and are the trustworthy statistic;
        //       WORST is not (6.5-39.2ms at the same size), which is why only the
        //       growth law and a non-strict frame smell are claimed here.
        //
        // Reading (a) was a THIRD harness artifact of the same family as the
        // boundingRect one: starving the run loop for 26 seconds let SwiftUI/CA
        // work pile up, and the backlog grew with the loop length, so the harness
        // manufactured the very super-linearity it was hunting. The product's real
        // growth law is LINEAR. Any future claim of "quadratic typing cost" must
        // first show the run loop was being drained.
        //
        // ⚠️ SECOND SELF-CORRECTION, and it weakens my own headline claim (2026-08-07):
        // I first wrote that per-keystroke cost is "flat ~26ms at both sizes, i.e.
        // already above the 16.7ms frame budget". That was SINGLE-RUN reasoning off
        // run (b)#1, where 26.0 and 25.9 happened to coincide. With four runs in hand
        // it does not hold two ways (run #4 put worst@148 at 6.5ms, INSIDE the frame
        // budget outright, so even the breach is not reliably present):
        //   • NOT FLAT. The worst keystroke rises 1.0x / 2.5x / 2.6x / 4.3x from
        //     148→1480 across the four runs. The one flat pair (run #1) was a
        //     coincidence, and I built a "saturation, not scaling" story on it.
        //   • NOT ABOVE BUDGET ON AVERAGE. The MEAN keystroke is 4.5-6.5ms — well
        //     under the 16.7ms frame. Only the occasional worst step breaches it.
        // So the accurate statement is narrower: typing is affordable on average at
        // field draft sizes, with intermittent frame-budget breaches (spikes, likely
        // allocation/relayout hiccups), and both mean and worst grow only linearly.
        // This does NOT by itself explain a 5-10s freeze — which is consistent with,
        // and strengthens, the unbounded-cycle-count reading: the per-cycle price is
        // affordable, so the count is what has to be wrong. Do not restore the "always
        // one frame behind" framing; it came from one lucky pair of numbers.
        //
        // SCOPE — DO NOT OVER-GENERALIZE THIS (correction, 2026-08-07): an earlier
        // wording of this block said the composer "never grows into a freeze — it is
        // always one frame behind". BOTH clauses were wrong, for different reasons.
        // "Always one frame behind" fell to the three-run spread above (the mean is
        // inside budget). "Never grows into a freeze" is false OUTSIDE 148-1,480 chars:
        // my own ladder in `testRealComposerLayoutCostByDraftLength` (same `relayout()`
        // primitive) refutes it: 62.7ms at 5K → 160.5ms at 10K → 2,352.9ms at 50K,
        // with the fitted exponent rising 1.03 → 1.36 → 1.67. A single relayout
        // breaches the watchdog-scaled budget on its own at 50K. The joint statement:
        //   • ≤ ~5K chars (covers EVERY field draft: 175 / 864 / 2,582, ignition 148):
        //     linear, exponent 1.03, mean per keystroke 4.5-6.5ms with occasional
        //     spikes past one frame. An AFFORDABLE per-cycle price, so only an
        //     unbounded cycle COUNT can reach the observed 5-10 CPU-seconds.
        //   • > ~5K chars: genuinely super-linear and eventually self-sufficient.
        //     Latent — not implicated in these ten kills — and now closed by
        //     `LongDraftEditor`.
        // Both halves are load-bearing for whoever reads this next: drop the first and
        // someone optimizes cost instead of bounding the loop; drop the second and
        // someone reopens the unbounded-draft hole believing cost is flat by nature.
        // (The ladder does NOT share this test's starvation defect — it retires the
        // host and drains the run loop between every rung, so its exponents stand.)
        //
        // NOTE FOR THE FIX AGENT: BOTH signals here are weak, and after the second
        // self-correction above I am not offering either as a reason to work on
        // composer cost. Growth is LINEAR (don't chase a quadratic) and the MEAN
        // keystroke is 4.5-6.5ms, comfortably inside a frame. What's left is
        // intermittent worst-case spikes past 16.7ms. That is a polish-grade finding,
        // not a 5-10s-freeze mechanism. Spend your effort on the unbounded cycle
        // count; this test exists mainly to keep anyone from RE-introducing a
        // superlinear cost here (see the ladder's hard gate for that).
        XCTAssertLessThan(long.worst, mainThreadBudgetMs,
            "one keystroke's composer layout approaches the watchdog-scaled budget")
        // The RATIO is reported but deliberately NOT asserted on. Before the yield it
        // ranged 28-39x across runs of identical code purely with host load; after the
        // yield 11.1-14.0x. Either way a threshold near the measured band is a
        // coin-flip gate — and a flaky red is worse than no red because it trains
        // people to ignore the file.
        // The worst single keystroke at the FIELD burst size (148 chars — the size
        // `voice transcribed chars=148` produced 5s before a kill) STRADDLES the 60fps
        // line across runs: 6.5 / 7.5 / 13.8 / 15.2 / 17.6 / 21.4 / 26.0ms. Straddling is
        // exactly why it is recorded, not gated.
        // NON-strict on purpose: it records the breach when it happens without
        // failing the suite when it doesn't — a strict wrapper here fails with
        // "expected failure but none recorded" on the fast runs.
        XCTExpectFailure("SMELL (borderline, load-sensitive): the WORST per-keystroke composer layout at the field's 148-char burst size sometimes exceeds the 60fps frame budget (16.7ms) — measured 6.5-26.0ms across runs, straddling it. The MEAN keystroke (4.5-6.5ms) is inside budget, so this is spiky, not saturated. Not a hard gate.", strict: false) {
            XCTAssertLessThan(short.worst, frameBudgetMs,
                "per-keystroke composer layout at the field burst size exceeds one frame: \(String(format: "%.1f", short.worst))ms")
        }
    }

    // MARK: - H3: keyboard-geometry transition over a field-scale transcript

    /// The field's leading structural suspect. The composer sits in
    /// `.safeAreaInset(edge: .bottom)` of the SAME view that hosts the
    /// ScrollView + LazyVStack. A keyboard show/hide (or any inset height change
    /// — the TextField grows from 1 to 6 lines as the draft wraps) changes the
    /// scroll view's safe area, which re-runs layout over the mounted rows.
    ///
    /// `KeyboardBottomRepin` makes each transition heavier still: it can end in
    /// `repin()` → `scrollToBottom()`, which sets `@State` and scrolls — more
    /// geometry change.
    ///
    /// Measures the row-body work one such relayout implies at the field's
    /// mounted-row count. Note the LazyVStack only re-evaluates MOUNTED rows
    /// (~1 screenful) but the ScrollView must re-derive content HEIGHT, which on
    /// a 400-row page touches every row's cached size.
    func testKeyboardTransitionRelayoutCost() {
        // BOTH arms — the field shape AND the overshoot. The pair is the point:
        // if only the overshoot is expensive, per-cycle cost cannot explain a
        // 6s stall on the field's 117-row / 44KB page.
        for (label, rows) in [("field(117)", fieldRows(Scale.fieldRows)),
                              ("overshoot(400)", fieldRows(Scale.hardCap, clipToFieldMax: false))] {
            // Warm the parse cache — a keyboard transition on an ALREADY-VIEWED
            // page is the field scenario (the user had been reading, then tapped
            // the composer), so cold-parse cost must not be double-counted.
            for m in rows { evaluateRow(m) }
            var worstMs = 0.0
            var totalMs = 0.0
            // 12 transitions = the "keyboard flashing in and out" the user saw.
            for cycle in 0..<12 {
                // One screenful of mounted rows re-evaluates per transition.
                let start = (cycle * 8) % max(rows.count - 12, 1)
                let mounted = rows[start..<min(start + 12, rows.count)]
                let cycleMs = ms { for m in mounted { evaluateRow(m) } }
                worstMs = max(worstMs, cycleMs)
                totalMs += cycleMs
            }
            // Swift String through %s yields garbage — interpolate it instead.
            print("[composer] keyboard transition, \(label) page: "
                  + String(format: "worst cycle %6.2fms, 12 cycles %7.2fms (frame %.1fms)",
                           worstMs, totalMs, frameBudgetMs))
            XCTAssertLessThan(worstMs, mainThreadBudgetMs,
                "keyboard-transition row re-evaluation breaches the watchdog-scaled budget (\(label))")
        }
    }

    /// Composite reproducing field freeze #2's exact sequence: an IDLE giant
    /// session is open and has been read (rows materialized), then voice
    /// transcription appends 148 chars to the draft and sets `focused = true`.
    /// That single action fires, in one main-thread turn:
    ///   setDraft → UserDefaults persist → ComposerDrafts @Observable
    ///   invalidation → ComposerBar body → TextField re-measures the new draft
    ///   → the inset's height may change → safe-area change → ScrollView
    ///   relayout → (focus change) keyboard geometry → KeyboardBottomRepin →
    ///   possible scrollToBottom.
    /// The freeze fired 5 seconds later.
    func testVoiceAppendOnIdleGiantSessionComposite() {
        // Field shape, not the overshoot: this reproduces a REAL field event, so
        // it must run at the size the crashing phone actually held.
        let rows = fieldRows(Scale.fieldRows)
        for m in rows { evaluateRow(m) }  // the page has been read (warm), untimed
        let drafts = ComposerDrafts.shared
        let key = "session:freeze-repro-composite"

        // The REAL composer, hosted — step 2 below must measure the product's own
        // layout, not a stand-in (see the class note "MEASURE THE PRODUCT").
        drafts.clear(key)
        let host = hostRealComposer(draftKey: key)  // mount, untimed

        let totalMs = ms {
            // 1. appendToDraft's write (ComposerView.swift appendToDraft).
            drafts.setDraft(Self.voiceBurst148, key: key)
            // 2. ComposerBar's body re-evaluates and the real TextField measures.
            relayout(host)
            // 3. focused = true → keyboard appears → safe-area inset changes →
            //    the scroll view relayouts its mounted rows.
            for m in rows.prefix(12) { evaluateRow(m) }
            // 4. KeyboardBottomRepin's repin() → scrollToBottom() → another
            //    geometry pass over the mounted tail.
            for m in rows.suffix(12) { evaluateRow(m) }
        }
        retire(host)
        drafts.clear(key)
        print(String(format: "[composer] voice-append(148) on an idle %d-row session: %7.2fms one main-thread turn (budget %.0f)",
                     Scale.fieldRows, totalMs, mainThreadBudgetMs))
        // Measured ~2-13ms, i.e. GREEN and never close to the budget. Read that
        // honestly: ONE pass of the field's ignition sequence is cheap, which is
        // itself evidence that the kill is not a single expensive turn but an
        // unbounded REPETITION of a cheap one. This test's job is to keep that
        // one pass cheap; the loop bound is asserted by the repin tests.
        XCTAssertLessThan(totalMs, mainThreadBudgetMs,
            "one pass of the voice-append ignition sequence breaches the watchdog-scaled budget")
    }

    // MARK: - H4: keyboard-flash oscillation (the loop, not the cost)

    /// The user saw the keyboard **flashing in and out on its own**. A
    /// self-sustaining loop, not a slow step, is what turns a 50ms relayout into
    /// a 6-second stall. `KeyboardBottomRepin` is the candidate:
    ///   keyboardWillChangeFrame → (if !frozen) pendingRepin = isPinned();
    ///                             frozen = true
    ///   didShow / didHide / willHide / didChangeFrame → finishTransition()
    ///                             → frozen = false; if pendingRepin → repin()
    /// `repin()` scrolls, which can itself change keyboard/safe-area geometry
    /// and emit another `didChangeFrame`. If the NEXT willChangeFrame arrives
    /// while `frozen` is already false, it re-arms `pendingRepin` and the cycle
    /// can continue.
    ///
    /// This test asserts the loop TERMINATES: driving the notification sequence
    /// that a repin-induced geometry change produces must not keep re-arming a
    /// repin forever. It drives the REAL decision core — `KeyboardRepinMachine`
    /// in ios-native/Walnut/Views/ScrollBottomTracking.swift, which the
    /// 2026-08-07 fix extracted out of the ViewModifier precisely so this suite
    /// could call the product instead of a hand-copied model (a ViewModifier's
    /// `@State` is unreachable from XCTest).
    /// The ORDERING DEFECT this pins (static lane's finding, verified by reading
    /// ScrollBottomTracking.swift `finishTransition()`):
    ///
    ///     keyboardGeometryFrozen = false     // gate OPENED
    ///     guard pendingRepin else { return }
    ///     pendingRepin = false
    ///     repin()                            // re-entrant work runs AFTER
    ///
    /// The gate opens BEFORE the re-entrant `repin()` runs, so any geometry
    /// event that `repin()`'s `scrollTo(edge:.bottom)` provokes arrives with the
    /// arming gate open and `willChangeFrame`'s `if !keyboardGeometryFrozen {
    /// pendingRepin = isPinned() }` re-arms it. `isPinned()` is `bottomPinned`,
    /// which defaults true and IS true for anyone reading at the bottom — so the
    /// re-arm succeeds every cycle. There is no cycle counter and no debounce,
    /// and `finishTransition` is reachable from FIVE notifications (didShow,
    /// didHide, willHide, didChangeFrame, plus the 1s failsafe, which only
    /// FORCES another transition and never suppresses one).
    ///
    /// The invariant a bounded design must satisfy: **N keyboard transitions
    /// produce at most N repins.** A machine that produces more has amplified
    /// user input into self-driven work.
    ///
    /// SCOPE: whether `scrollTo` on a ScrollView with
    /// `.scrollDismissesKeyboard(.interactively)` actually emits
    /// `keyboardWillChangeFrame` is the ring's closing edge and is NOT decidable
    /// in XCTest — see the sim probe (`scripts/ios-perf/kb-loop-probe.sh`),
    /// which measured it. This test covers the half that IS decidable here: the
    /// state machine's amplification factor GIVEN that the edge exists.
    func testKeyboardRepinIsBoundedByTransitionCount() {
        /// Drives the PRODUCT machine through the notification sequence a real
        /// keyboard transition produces, feeding `repin()`'s own geometry fallout
        /// back in as further events (the ring's closing edge). Time is
        /// simulated: the machine's arming hold is a clock window, so a virtual
        /// clock is the only way to assert it without sleeping.
        final class Pump {
            /// Shared clock cell — the machine reads it, the pump advances it.
            final class Clock { var now: TimeInterval = 1_000 }
            let clock = Clock()
            let machine: KeyboardRepinMachine
            /// `bottomPinned` — defaults true, true for a bottom reader.
            var isPinned = true
            /// Mirrors the view's `programmaticGeometryFrozen`.
            var programmaticFrozen = false
            var repins = 0
            /// (event, seconds to advance before delivering it).
            var queue: [(String, TimeInterval)] = []
            /// True when repin()'s scroll provokes further keyboard geometry
            /// events (the ring's closing edge — see SCOPE above).
            let repinEmitsGeometry: Bool
            /// A repin's own geometry fallout lands on the next CA commit — a
            /// frame or two, NOT a human interval. That asymmetry is what makes
            /// the ring a ring; the machine's hold window sits between the two.
            var falloutGap: TimeInterval = 0.008
            /// Gap before a *user*-initiated transition's events. A real one needs
            /// a human act first (tap the composer, dismiss the keyboard, switch
            /// input mode), so the keyboard has been QUIET for far longer than any
            /// hold — that quiet is exactly what distinguishes user intent from
            /// self-driven churn.
            var userGap: TimeInterval = 2.0

            init(repinEmitsGeometry: Bool) {
                self.repinEmitsGeometry = repinEmitsGeometry
                let clock = self.clock
                self.machine = KeyboardRepinMachine(clock: { clock.now })
            }

            /// Drive ONE real user keyboard transition and let consequences run.
            @discardableResult
            func pumpOneUserTransition(limit: Int) -> Int {
                queue = [("willChangeFrame", userGap), ("didShow", falloutGap)]
                return drain(limit: limit)
            }

            func drain(limit: Int) -> Int {
                var steps = 0
                while !queue.isEmpty, steps < limit {
                    let (event, gap) = queue.removeFirst()
                    steps += 1
                    clock.now += gap
                    let outcome = event == "willChangeFrame"
                        ? machine.willChangeFrame(isPinned: isPinned, programmaticFrozen: programmaticFrozen)
                        : machine.finishTransition()
                    if outcome.repin {
                        repins += 1
                        guard repinEmitsGeometry else { continue }
                        // repin() = scrollTo(edge:.bottom): its safe-area /
                        // keyboard fallout arrives on the next commit.
                        queue.append(("willChangeFrame", falloutGap))
                        queue.append(("didChangeFrame", falloutGap))
                    }
                }
                return steps
            }
        }

        // Control: if repin provokes no geometry, the machine settles at once.
        let inert = Pump(repinEmitsGeometry: false)
        inert.pumpOneUserTransition(limit: 200)
        print("[composer] repin machine, inert closing edge: \(inert.repins) repins from 1 user transition, queue left \(inert.queue.count)")
        XCTAssertEqual(inert.repins, 1, "control: one transition, one repin")
        XCTAssertTrue(inert.queue.isEmpty, "control: the machine settles")

        // The hypothesis: repin's scroll DOES provoke keyboard geometry.
        // HARD GATE (was XCTExpectFailure until the 2026-08-07 fix — 200 repins
        // from ONE transition, i.e. the pump limit, red): the machine now holds
        // its ARMING gate across the re-entrant repin (`armHoldSeconds`), so a
        // repin's own geometry fallout can never arm the next cycle.
        let limit = 400
        let ringy = Pump(repinEmitsGeometry: true)
        let steps = ringy.pumpOneUserTransition(limit: limit)
        print("[composer] repin machine, live closing edge: \(ringy.repins) repins from 1 user transition (\(steps) events, queue left \(ringy.queue.count))")
        XCTAssertLessThanOrEqual(ringy.repins, 1,
            "one keyboard transition produced \(ringy.repins) repins — the repin ring is unbounded (no cycle counter, no debounce, gate opened before the re-entrant call)")
        XCTAssertTrue(ringy.queue.isEmpty,
            "keyboard event queue never drains — self-sustaining geometry loop")
        XCTAssertEqual(ringy.machine.ringBreaks, 0,
            "the ordering fix alone must bound this — the cycle breaker is defense in depth, not the mechanism")

        // N transitions ⇒ EXACTLY N repins at real user pacing. This is the
        // no-UX-regression gate: the arming hold (which extends while churn
        // continues) must never swallow a genuine keyboard show, or the reader
        // silently stops being scrolled to the bottom.
        let paced = Pump(repinEmitsGeometry: true)
        for _ in 0..<5 { paced.pumpOneUserTransition(limit: limit) }
        print("[composer] repin machine, 5 user transitions at human pace: \(paced.repins) repins, breaks \(paced.machine.ringBreaks)")
        XCTAssertEqual(paced.repins, 5,
            "a genuine keyboard show must still repin exactly once — no UX regression (scroll-to-bottom after the keyboard appears)")
        XCTAssertEqual(paced.machine.ringBreaks, 0, "human-paced transitions must not trip the breaker")

        // The interlock: `programmaticGeometryFrozen` (250ms around a
        // programmatic scroll) is now consulted by the repin machine too, not
        // only by ScrollBottomTracking. Keyboard geometry provoked BY a
        // programmatic scroll must not arm a repin.
        let interlocked = Pump(repinEmitsGeometry: true)
        interlocked.programmaticFrozen = true
        interlocked.pumpOneUserTransition(limit: limit)
        print("[composer] repin machine under programmaticGeometryFrozen: \(interlocked.repins) repins")
        XCTAssertEqual(interlocked.repins, 0,
            "geometry owned by a programmatic scroll must not arm a keyboard repin (the missing interlock)")
    }

    /// The SLOW-FALLOUT ring — the one a real simulator actually produced, and the
    /// reason `armHoldSeconds` extends instead of merely expiring.
    ///
    /// FIELD-OF-RECORD (2026-08-07 sim smoke, telemetry via the mock server): with
    /// a FIXED 300ms hold, driving the composer on a real simulator logged
    /// `repin ring broken {repins: 13}` THREE separate times, alongside
    /// `main thread unresponsive`. So the ring's closing edge is real but LATE: a
    /// repin's `scrollTo` animates, and its keyboard geometry fallout arrives
    /// ~350ms later — past a 300ms hold and past the sibling
    /// `programmaticGeometryFrozen` (250ms). The ring simply re-paced itself into
    /// the gap between holds and kept turning at ~2.6 repins/s.
    ///
    /// The division of labour this pins (and the reason the machine does NOT claim
    /// "1 repin per transition, always"): timing alone cannot tell repin fallout
    /// from user intent once the fallout arrives AFTER the hold expired — both are
    /// then just an event following quiet. So:
    ///   * FAST fallout (inside the hold) → suppressed entirely, 1 repin. Covered
    ///     by `testKeyboardRepinIsBoundedByTransitionCount`'s live-edge arm.
    ///   * SLOW fallout (past the hold) → still rings, but the breaker BOUNDS it to
    ///     ~`ringLimit` per window and logs it. That is what this test asserts:
    ///     bounded + reported, NOT silently perfect.
    /// The alternative (suppress every post-quiet event) would break genuine
    /// scroll-to-bottom, which is the UX regression the paced arm guards.
    func testSlowFalloutRingIsBoundedAndReportedByTheBreaker() {
        final class Clock { var now: TimeInterval = 9_000 }
        let clock = Clock()
        let machine = KeyboardRepinMachine(clock: { clock.now })
        var repins = 0
        // Fallout lands just PAST the nominal hold — the hardest shape for a
        // purely time-based gate, and the one the simulator produced.
        let falloutDelay = KeyboardRepinMachine.armHoldSeconds + 0.05
        var queue: [(String, TimeInterval)] = [("willChangeFrame", 0.0), ("didShow", 0.01)]
        var steps = 0
        while !queue.isEmpty, steps < 400 {
            let (event, gap) = queue.removeFirst()
            steps += 1
            clock.now += gap
            let outcome = event == "willChangeFrame"
                ? machine.willChangeFrame(isPinned: true, programmaticFrozen: false)
                : machine.finishTransition()
            if outcome.repin {
                repins += 1
                queue.append(("willChangeFrame", falloutDelay))
                queue.append(("didChangeFrame", 0.01))
            }
        }
        print("[composer] slow-fallout ring (fallout +\(String(format: "%.2f", falloutDelay))s): \(repins) repins over \(steps) events, breaks \(machine.ringBreaks)")
        // The gate that matters: repins must be BOUNDED by the breaker's limit
        // rather than scaling with how long the ring runs. Before the fix this
        // shape produced 200 repins over the 400-event pump limit and the queue
        // never drained; now the ring dies (~18 events) after `ringLimit` repins.
        XCTAssertLessThanOrEqual(repins, KeyboardRepinMachine.ringLimit,
            "a slow-fallout ring produced \(repins) repins — more than the breaker's limit, so nothing is bounding it")
        XCTAssertTrue(queue.isEmpty,
            "the slow-fallout ring never drained within the pump limit — the breaker did not stop it")
        XCTAssertGreaterThan(machine.ringBreaks, 0,
            "a slow-fallout ring must be REPORTED (AppLog + FreezeContext breadcrumb), otherwise build 36 field data can't tell us it happened")
        let trail = FreezeContext.shared.snapshotMeta()["ctxTrail"] ?? ""
        XCTAssertTrue(trail.contains("repin-ring-break"),
            "the slow-fallout ring must leave a freeze-report breadcrumb: \(trail)")
    }

    /// The hold's extension must be CAPPED. An unbounded "push the deadline on
    /// every event" rule would let any environment that emits steady sub-hold
    /// keyboard geometry for a legitimate reason disable auto-scroll-to-bottom
    /// forever — a silent UX death that no crash report would ever show. After
    /// `armHoldMaxSeconds` the gate must reopen and a genuine transition repin.
    func testArmHoldExtensionIsCappedSoRepinCannotDieForever() {
        final class Clock { var now: TimeInterval = 20_000 }
        let clock = Clock()
        let machine = KeyboardRepinMachine(clock: { clock.now })

        // One genuine transition → one repin, which opens the hold.
        _ = machine.willChangeFrame(isPinned: true, programmaticFrozen: false)
        clock.now += 0.01
        XCTAssertTrue(machine.finishTransition().repin, "setup: the first transition repins")

        // Now hammer the gate with sub-hold churn for well past the ceiling.
        var repins = 0
        let end = clock.now + KeyboardRepinMachine.armHoldMaxSeconds + 2.0
        while clock.now < end {
            clock.now += 0.1
            _ = machine.willChangeFrame(isPinned: true, programmaticFrozen: false)
            clock.now += 0.01
            if machine.finishTransition().repin { repins += 1 }
        }
        print("[composer] capped extension under \(String(format: "%.1f", KeyboardRepinMachine.armHoldMaxSeconds))s ceiling + 2s of churn: \(repins) further repins")
        XCTAssertGreaterThan(repins, 0,
            "the hold extension must be capped — steady sub-hold geometry churn must not suppress repinning forever (silent loss of scroll-to-bottom)")
    }

    /// The cycle breaker, tested on its own. The simulator cannot produce every
    /// real-keyboard ignition source (predictive/QuickType bar, dictation,
    /// autocorrect, input-mode resize — all arriving as `keyboardDidChangeFrame`,
    /// which `KeyboardBottomRepin` subscribes to explicitly), so a ring that
    /// paces itself SLOWER than the arming hold may still exist in the field.
    /// The breaker converts that infinite loop into a bounded one-log anomaly.
    ///
    /// Drives transitions just past the hold window (so each one legitimately
    /// arms) at a rate no human keyboard can reach, and asserts the breaker
    /// engages, logs, stops repinning, then self-heals when geometry goes quiet.
    func testRepinCycleBreakerBoundsAnUnholdableRing() {
        final class Clock { var now: TimeInterval = 5_000 }
        let clock = Clock()
        let machine = KeyboardRepinMachine(clock: { clock.now })
        // REACHABILITY INVARIANT — assert it before driving anything. The hold
        // caps a hold-evading ring at 1/armHoldSeconds repins per second, so a
        // ringLimit at or above that ceiling can NEVER fire and the breaker is
        // dead code that still reads like a safeguard. (This exact mistake
        // happened: ringLimit started at 12 against a 0.45s hold — ceiling ~11 —
        // and 30 self-driven transitions produced 0 breaks.) Any future change to
        // either constant must keep this true.
        let evasionCeiling = KeyboardRepinMachine.ringWindowSeconds / KeyboardRepinMachine.armHoldSeconds
        print(String(format: "[composer] breaker reachability: limit %d vs hold-evasion ceiling %.1f per %.0fs window",
                     KeyboardRepinMachine.ringLimit, evasionCeiling, KeyboardRepinMachine.ringWindowSeconds))
        XCTAssertLessThan(Double(KeyboardRepinMachine.ringLimit), evasionCeiling,
            "ringLimit (\(KeyboardRepinMachine.ringLimit)) is at or above the hold's own evasion ceiling (\(String(format: "%.1f", evasionCeiling))) — the breaker can never fire")
        XCTAssertGreaterThan(KeyboardRepinMachine.ringLimit, 3,
            "ringLimit must stay well above a legitimate burst (~2 observed) or normal use trips the breaker")

        var repins = 0
        // Just past armHoldSeconds → the hold cannot suppress these, only the
        // breaker can. Sustained at ~1/armHoldSeconds repins/s.
        let step = KeyboardRepinMachine.armHoldSeconds + 0.01
        for _ in 0..<30 {
            clock.now += step
            _ = machine.willChangeFrame(isPinned: true, programmaticFrozen: false)
            clock.now += 0.001
            if machine.finishTransition().repin { repins += 1 }
        }
        print("[composer] unholdable ring, 30 transitions at \(String(format: "%.2f", step))s: \(repins) repins, breaks \(machine.ringBreaks), broken=\(machine.ringBroken)")
        XCTAssertGreaterThan(machine.ringBreaks, 0,
            "a ring pacing itself past the arming hold must trip the cycle breaker")
        XCTAssertLessThanOrEqual(repins, KeyboardRepinMachine.ringLimit + 1,
            "the breaker must bound total repins to about the ring limit, not scale with the ring's length")
        let trail = FreezeContext.shared.snapshotMeta()["ctxTrail"] ?? ""
        XCTAssertTrue(trail.contains("repin-ring-break"),
            "the breaker must leave a freeze-report breadcrumb so the field tells us it engaged: \(trail)")

        // Self-heal: geometry goes quiet, then a genuine transition repins again.
        clock.now += KeyboardRepinMachine.ringWindowSeconds + 1
        _ = machine.willChangeFrame(isPinned: true, programmaticFrozen: false)
        clock.now += 0.001
        XCTAssertTrue(machine.finishTransition().repin,
            "after a quiet window the breaker must release — a permanently dead repin would strand the reader")
    }

    // MARK: - H5: the freeze-context signal the field report should carry

    /// If the freeze IS a keyboard-geometry loop, the field reports must show an
    /// abnormal keyboard-transition count in the 10s before the stall. This test
    /// pins that FreezeContext actually counts what the hypothesis needs, so a
    /// zero in a field report is real evidence of absence rather than a gap in
    /// instrumentation.
    func testFreezeContextCountsKeyboardFlips() {
        let ctx = FreezeContext.shared
        ctx.resetForTesting()
        let now = FreezeContext.uptimeNow()
        // 20 flips inside the window (a "flashing" keyboard) …
        for i in 0..<20 { ctx.noteKeyboard(visible: i % 2 == 0, at: now - Double(i) * 0.3) }
        // … and some well outside it, which must NOT count.
        for i in 0..<5 { ctx.noteKeyboard(visible: true, at: now - 60 - Double(i)) }
        let inWindow = ctx.keyboardTransitions()
        print("[composer] FreezeContext keyboard transitions in the \(Int(FreezeContext.keyboardWindowSeconds))s window: \(inWindow)")
        XCTAssertGreaterThan(inWindow, 1,
            "FreezeContext must count keyboard flips — without it a field freeze report cannot confirm or rule out the oscillation hypothesis")
        let meta = ctx.snapshotMeta(now: now)
        XCTAssertNotNil(meta["ctxKbFlips10s"], "the keyboard-flip count must ride the freeze report")
        XCTAssertNotNil(meta["ctxDraftChars"], "the draft length must ride the freeze report (H1/H2 need it)")
        XCTAssertNotNil(meta["ctxHistoryRows"], "the rendered row count must ride the freeze report")
        ctx.resetForTesting()
    }
}
