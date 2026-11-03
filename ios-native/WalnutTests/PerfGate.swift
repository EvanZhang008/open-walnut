import Foundation

/// The statistics a wall-clock gate is judged on.
///
/// A shared CI runner stalls now and then: on run 41505408126 one pass of the
/// cold first-paint gate took 1.37 s longer in a 0.5 s run-loop drain while its
/// mount stayed at ~60 ms in every pass, and the gate, judging its worst pass,
/// charged the stall to the page. So a gate runs several passes and judges their
/// median, and still prints every pass and the worst so a spike stays visible.
///
/// What the median does and does not tell apart: n passes outvote up to (n-1)/2
/// slow ones (one in three, two in five), so a stall that hits a minority of the
/// passes passes, and so does a regression that only hits a minority. A regression
/// in most passes fails. Each pass must therefore pay the cost being judged: passes
/// that share state (a warm cache, a mounted view) hide a cost paid only once, and
/// such a gate rebuilds the state in every pass.
///
/// `worstButOne` is for one long loop of like steps too dear to repeat: it drops the
/// single worst step, so it must never judge a cost that one particular step pays
/// (a view swap at a threshold, a first-time setup): repeat the loop and take the
/// median of its worst steps instead.
///
/// tests/scripts/ci-ios.test.ts (tests/helpers/swift-wall-clock-gates.ts) fails on an
/// assertion in a CI-run test that puts an upper bound on a duration (each pass on its
/// own included: `for p in passes { XCTAssertLessThan(p, …) }`) or on the clock against a
/// deadline, without going through `median` or `worstButOne`. It reads the source, so it
/// sees a duration only where the test's own class computes one (a timing expression and
/// the names, loop variables, closure parameters and `self.` properties it flows into). It
/// cannot see a timing helper in another file or type, for example one returning a struct
/// of timings: put a new timing helper here instead.
enum PerfGate {
    /// Wall-clock milliseconds of `block`.
    static func ms(_ block: () throws -> Void) rethrows -> Double {
        let t0 = DispatchTime.now()
        try block()
        return Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
    }

    /// `n` timed passes of `pass` (given its index), in order.
    static func passes(_ n: Int, _ pass: (Int) throws -> Double) rethrows -> [Double] {
        try (0..<n).map(pass)
    }

    /// The median: one stalled pass in three (two in five) cannot move it. Below three
    /// passes it guards nothing: one pass is that pass, two are their mean.
    static func median(_ samples: [Double]) -> Double {
        precondition(!samples.isEmpty, "a gate needs at least one pass")
        let s = samples.sorted()
        let mid = s.count / 2
        return s.count % 2 == 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
    }

    /// The worst sample once the single worst is dropped: a step that is slow
    /// twice is the code's, one slow step may be the runner's.
    static func worstButOne(_ samples: [Double]) -> Double {
        let s = samples.sorted()
        return s.count < 2 ? (s.last ?? 0) : s[s.count - 2]
    }

    /// "median X worst Y [a b c]" for the log line beside a gate.
    static func summary(_ samples: [Double]) -> String {
        let all = samples.map { String(format: "%.1f", $0) }.joined(separator: " ")
        return String(format: "median %.1fms worst %.1fms", median(samples), samples.max() ?? 0)
            + " (n=\(samples.count): \(all))"
    }
}
