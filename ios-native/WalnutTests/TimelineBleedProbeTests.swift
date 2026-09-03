import XCTest
import UIKit
import WebKit
@testable import Walnut

/// Diagnostic probe: attach the real timeline to a real window over a
/// field-shaped transcript and report every view that draws BELOW its own row.
///
/// The engine's rows never self-size, so a cell whose content needs more height
/// than the row was given cannot grow or scroll — it paints over the next row.
/// The cell's own `clipsToBounds` is false (a UICollectionViewCell's is), so
/// there is nothing between "the content is too tall" and ink on ink.
@MainActor
final class TimelineBleedProbeTests: XCTestCase {

    /// Drawn rect of `view` in cell-content coordinates, already intersected
    /// with every clipping ancestor (a code cell's label legitimately overflows
    /// its scroll view; that is clipped, not bleed).
    private struct Probe {
        let bleed: CGFloat
        let describe: String
    }

    private func worstBleed(in cell: UICollectionViewCell) -> Probe {
        var worst = Probe(bleed: 0, describe: "")
        let limit = cell.contentView.bounds.maxY

        func walk(_ view: UIView, clip: CGRect, depth: Int) {
            for sub in view.subviews {
                guard !sub.isHidden, sub.alpha > 0.01 else { continue }
                let frame = cell.contentView.convert(sub.bounds, from: sub)
                let drawn = frame.intersection(clip)
                guard !drawn.isNull else { continue }
                let over = drawn.maxY - limit
                if over > worst.bleed, drawn.height > 0.5, draws(sub) {
                    worst = Probe(
                        bleed: over,
                        describe: "\(type(of: sub)) drawn \(short(drawn)) vs row maxY \(short(limit))"
                    )
                }
                walk(sub, clip: sub.clipsToBounds ? clip.intersection(frame) : clip, depth: depth + 1)
            }
        }
        walk(cell.contentView,
             clip: cell.contentView.clipsToBounds ? cell.contentView.bounds : .infinite,
             depth: 0)
        return worst
    }

    /// Does this view put ink on screen? A pure layout container with an
    /// oversized frame is not yet a defect; a label, image, text view, or any
    /// view with a visible fill is.
    private func draws(_ view: UIView) -> Bool {
        if view is UILabel || view is UIImageView || view is UITextView { return true }
        if view is WKWebView { return true }
        if let color = view.backgroundColor, color != .clear,
           color.cgColor.alpha > 0.01 { return true }
        // SwiftUI draws through private display views whose names are stable
        // enough for a diagnostic (never for a product code path).
        let name = String(describing: type(of: view))
        return name.contains("GraphicsView") || name.contains("DrawingView")
            || name.contains("TextView") || name.contains("ImageLayer")
    }

    private func short(_ value: CGFloat) -> String { String(format: "%.1f", value) }
    private func short(_ rect: CGRect) -> String {
        "y\(short(rect.minY))..\(short(rect.maxY))"
    }

    /// The harness transcript's shape: prose + CJK + code + lists, tool chips
    /// (some with a subagent badge), user turns.
    private func transcript(_ n: Int) -> [ChatMessage] {
        let cjk = "这一轮的分析结论如下:控制面在高负载下的重列风暴会导致缓存穿透,"
            + "监控指标显示每分钟的请求量在峰值时刻翻了三倍。**关键点**:先确认限流开关。"
        let code = "```bash\nkubectl get pods -A | sort | uniq -c | head -20\n```"
        var out: [ChatMessage] = []
        for i in 1...n {
            let ts = String(format: "2026-09-03T06:%02d:%02dZ", (i / 60) % 60, i % 60)
            switch i % 10 {
            case 0..<5:
                out.append(ChatMessage(
                    id: "h-\(i)", role: "assistant",
                    text: i % 3 == 0
                        ? "## 第 \(i) 轮结论\n\n\(cjk)\n\n\(code)\n\n- 项目一:验证完成\n- 项目二:等待复核"
                        : "收到,第 \(i) 步完成。The check for step \(i) passed.",
                    createdAt: ts, kind: nil))
            case 5..<8:
                out.append(ChatMessage(
                    id: "h-\(i)", role: "assistant", text: ["Bash", "Read", "Task"][i % 3],
                    createdAt: ts, kind: .tool, detail: "harness command \(i)",
                    resultPreview: String(repeating: "result line \(i)\n", count: 8),
                    agent: i % 6 == 5 ? "explorer" : nil))
            default:
                out.append(ChatMessage(id: "h-\(i)", role: "user",
                                       text: "继续第 \(i) 项,注意只读操作。", createdAt: ts, kind: nil))
            }
        }
        return out
    }

    func testReportBleedAcrossAScrolledTranscript() async {
        let width: CGFloat = 393
        let controller = TimelineCollectionController()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 852))
        window.rootViewController = controller
        window.isHidden = false
        controller.view.layoutIfNeeded()

        let messages = transcript(120)
        let layoutActor = TimelineLayoutActor()
        let snapshot = await layoutActor.buildSnapshot(TimelineInput(
            messages: messages, streaming: false, liveText: "", liveTextTruncated: false,
            activity: nil, showLoadEarlier: false, width: width, expandedRowIDs: []))
        controller.apply(snapshot)
        // Progressive fill lands over several run-loop turns.
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))

        var worstByKind: [String: (CGFloat, String, String)] = [:]
        var visited = 0
        let cv = controller.collectionView!
        // Walk the whole transcript, a viewport at a time.
        var offset = -cv.adjustedContentInset.top
        while offset < cv.contentSize.height {
            cv.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
            cv.layoutIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            for cell in cv.visibleCells {
                guard let path = cv.indexPath(for: cell),
                      path.item < controller.rows.count else { continue }
                let row = controller.rows[path.item]
                let probe = worstBleed(in: cell)
                visited += 1
                let kind = row.content.reuseKind
                if probe.bleed > (worstByKind[kind]?.0 ?? 0) {
                    worstByKind[kind] = (probe.bleed, row.id, probe.describe)
                }
            }
            offset += cv.bounds.height * 0.8
        }

        print("=== BLEED PROBE: \(visited) cell visits, \(controller.rows.count) rows ===")
        for (kind, (bleed, rowID, describe)) in worstByKind.sorted(by: { $0.value.0 > $1.value.0 }) {
            print(String(format: "%-16@ %7.2fpt  %@  %@",
                         kind as NSString, bleed, rowID as NSString, describe as NSString))
        }
        XCTAssertGreaterThan(visited, 50, "probe never saw enough cells")
    }

    /// A rich card that has just measured itself must not paint over the rows
    /// below it, not even for the one round trip before its row catches up.
    ///
    /// This is the reported symptom, and the cell asks for it on purpose: a
    /// document lays out at its OWN measured height rather than the row's (so its
    /// `contentSize` cannot be floored by a guess), and `report` then calls
    /// `setNeedsLayout` to "grow to the measured height NOW rather than waiting
    /// for the rebuild to come back around". Growing is right; growing INTO THE
    /// NEXT ROW is not. Until the rebuild lands, the row below is the same
    /// message's own next paragraph — which is exactly "the text is overridden
    /// half by the next message, or even by the same message".
    func testARichCardThatOutgrewItsRowDoesNotPaintOverTheNextOne() async {
        RichHTMLHeightCache.shared.resetForTesting()
        let width: CGFloat = 393
        let controller = TimelineCollectionController()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 852))
        window.rootViewController = controller
        window.isHidden = false
        controller.view.layoutIfNeeded()

        // A reply that is a card FOLLOWED BY PROSE, so the row under the card is
        // the same message's own text — the case the reader cannot dismiss as two
        // messages crowding each other.
        let reply = "<div class=\"card\"><p>Retry budget exhausted.</p></div>\n\n"
            + "Run the check before touching the queue, then confirm the daemon owns the pipe."
        let snapshot = await TimelineLayoutActor().buildSnapshot(TimelineInput(
            messages: [ChatMessage(id: "rich-1", role: "assistant", text: reply,
                                   createdAt: "2026-09-03T06:00:00Z", kind: nil)],
            streaming: false, liveText: "", liveTextTruncated: false, activity: nil,
            showLoadEarlier: false, width: width, expandedRowIDs: []))
        controller.apply(snapshot)
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))

        let cv = controller.collectionView!
        guard let richIndex = controller.rows.firstIndex(where: { $0.content.reuseKind == "richHTML" }),
              let cell = cv.cellForItem(at: IndexPath(item: richIndex, section: 0))
                as? TimelineRichHTMLCell else {
            return XCTFail("no rich cell on screen; rows = \(controller.rows.map(\.content.reuseKind))")
        }
        let rowHeight = controller.rows[richIndex].height
        XCTAssertGreaterThan(controller.rows.count, richIndex + 1,
                             "the fixture must put a prose row UNDER the card")

        // What WebKit would say about a document four times taller than the guess.
        let measured = rowHeight * 4
        cell.applyMeasuredHeightForTesting(measured)
        cv.layoutIfNeeded()

        // The honest-measurement invariant stays: the document is laid out at its
        // own height, never squeezed into the row (that is what lets it measure).
        XCTAssertEqual(cell.webViewForTesting?.frame.height ?? 0, measured, accuracy: 1,
                       "the document must keep its own height, or it can never measure honestly")
        // …and none of it may reach the row below.
        let probe = worstBleed(in: cell)
        XCTAssertEqual(probe.bleed, 0, accuracy: 0.5,
                       "the card painted \(probe.bleed)pt past its \(rowHeight)pt row: \(probe.describe)")
    }
}
