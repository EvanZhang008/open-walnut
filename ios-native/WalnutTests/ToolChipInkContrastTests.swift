import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// The tool row's ink, measured from the PIXELS the row draws.
///
/// `ReadableTextContrastTests` pins the colour token. This pins that the row
/// REACHES for it, and the shipped bug lived exactly in that gap: the readable
/// grey existed, the expanded card's INPUT/RESULT labels already used it, and
/// the capsule one line above still drew its subtitle and its expand chevron in
/// `.tertiary` — 1.69:1 light, 2.34:1 dark on the phone, under the 3:1 floor for
/// a UI affordance let alone 4.5:1 for text. A colour-token test cannot see a
/// view reaching for the wrong colour; a rendered row can.
///
/// Method is the one used on the phone: rasterise at 3x, take the modal
/// luminance of a band as its paper and the modal of the 8% farthest from that
/// as its ink, then WCAG-ratio the two. The bands are LOCATED, never hard-coded:
/// the capsule's painted edge is found by scanning in from the empty page, and
/// the chevron and subtitle are cut from the app's own `TimelineMetrics.chipHPad`
/// plus the ink clusters actually present. A layout change therefore fails this
/// test loudly instead of quietly measuring empty background.
@MainActor
final class ToolChipInkContrastTests: XCTestCase {

    /// WCAG AA for text, and the non-text minimum for a meaningful glyph.
    private let textMinimum = 4.5
    private let glyphMinimum = 3.0

    private let pageWidth: CGFloat = 393
    private let scale = 3

    // MARK: - The bars

    func testSubtitleClearsTheTextBarInBothSchemes() throws {
        for dark in [false, true] {
            let shot = try render(detail: "npm run test:quick --silent", dark: dark)
            let plain = try render(detail: nil, dark: dark)
            let band = try subtitleBand(withDetail: shot, withoutDetail: plain)
            let m = shot.measure(band)
            assertScheme(m, dark: dark)
            report("subtitle", dark: dark, m, band)
            XCTAssertGreaterThanOrEqual(
                m.ratio, textMinimum,
                "tool subtitle \(dark ? "dark" : "light"): \(fmt(m.ratio)):1 "
                    + "(band \(band.x0)-\(band.x1)px)")
        }
    }

    func testExpandChevronClearsTheGlyphBarInBothSchemes() throws {
        for dark in [false, true] {
            let shot = try render(detail: "npm run test:quick --silent", dark: dark)
            let band = try chevronBand(shot)
            let m = shot.measure(band)
            assertScheme(m, dark: dark)
            report("chevron", dark: dark, m, band)
            XCTAssertGreaterThanOrEqual(
                m.ratio, glyphMinimum,
                "expand chevron \(dark ? "dark" : "light"): \(fmt(m.ratio)):1 "
                    + "(band \(band.x0)-\(band.x1)px)")
        }
    }

    /// The tool NAME shares the capsule's ink, so it is held to the text bar too.
    /// It shipped at `.secondary` (3.24:1 light, measured on the phone), which is
    /// how the row ended up with its title quieter than AA while its subtitle was
    /// quieter still.
    func testToolNameClearsTheTextBarInBothSchemes() throws {
        for dark in [false, true] {
            let plain = try render(detail: nil, dark: dark)
            let clusters = try plain.capsuleInkClusters()
            // wrench, name, chevron — the name is the middle one.
            guard clusters.count == 3 else {
                XCTFail("expected wrench/name/chevron, got \(clusters.count) ink clusters "
                        + "(\(clusters.map { "\($0.x0)-\($0.x1)" }.joined(separator: " ")))")
                return
            }
            let m = plain.measure(clusters[1])
            assertScheme(m, dark: dark)
            report("name", dark: dark, m, clusters[1])
            XCTAssertGreaterThanOrEqual(
                m.ratio, textMinimum,
                "tool name \(dark ? "dark" : "light"): \(fmt(m.ratio)):1")
        }
    }

    // MARK: - Bands

    /// The chevron: the last ink cluster inside the capsule, which the row's own
    /// layout puts `chipHPad` in from the painted edge.
    private func chevronBand(_ shot: Raster) throws -> Band {
        let clusters = try shot.capsuleInkClusters()
        let last = try XCTUnwrap(clusters.last, "no ink inside the capsule")
        let padEdge = shot.capsuleRight - Int(TimelineMetrics.chipHPad) * scale
        XCTAssertLessThanOrEqual(
            last.x1, padEdge + 2 * scale,
            "the last cluster is not sitting on the capsule's trailing padding — "
                + "the row's layout changed and this band no longer means 'chevron'")
        return last
    }

    /// The subtitle: between where the NAME ends and where the chevron starts.
    /// The name's right edge is read from the detail-less render, whose leading
    /// layout (margin, padding, wrench, spacing, name) is identical.
    private func subtitleBand(withDetail shot: Raster,
                              withoutDetail plain: Raster) throws -> Band {
        let plainClusters = try plain.capsuleInkClusters()
        guard plainClusters.count == 3 else {
            // A thrown error, never an XCTSkip: a band this test can no longer
            // locate is a failure to report, not a case to quietly drop.
            throw LayoutChanged("expected wrench/name/chevron with no subtitle, got "
                                + "\(plainClusters.count) clusters")
        }
        let nameEnd = plainClusters[1].x1
        let chevron = try chevronBand(shot)
        let gap = 3 * scale
        let band = Band(x0: nameEnd + gap, x1: chevron.x0 - gap)
        XCTAssertGreaterThan(
            band.x1 - band.x0, 20 * scale,
            "the subtitle band came out \(band.x1 - band.x0)px wide — the row's "
                + "layout changed and this is no longer measuring the subtitle")
        return band
    }

    /// Guards the whole method: if the override never took, a "dark" render would
    /// be measured on a light page and every ratio would be meaningless.
    private func assertScheme(_ m: Measurement, dark: Bool,
                              file: StaticString = #filePath, line: UInt = #line) {
        if dark {
            XCTAssertLessThan(m.paper, 0.12,
                              "dark render has a light paper (\(fmt(m.paper))) — "
                                  + "the interface-style override did not take",
                              file: file, line: line)
        } else {
            XCTAssertGreaterThan(m.paper, 0.6,
                                 "light render has a dark paper (\(fmt(m.paper))) — "
                                     + "the interface-style override did not take",
                                 file: file, line: line)
        }
    }

    private func fmt(_ v: Double) -> String { String(format: "%.2f", v) }

    /// Every measurement goes to the log whether it passes or not — the numbers
    /// are the point, and a green run that prints nothing cannot be read back.
    private func report(_ role: String, dark: Bool, _ m: Measurement, _ band: Band) {
        print("[toolchip] \(role) \(dark ? "dark " : "light")"
              + "= \(fmt(m.ratio)):1  ink L=\(String(format: "%.4f", m.ink)) "
              + "paper L=\(String(format: "%.4f", m.paper)) band=\(band.x0)-\(band.x1)px")
    }

    // MARK: - Rendering

    /// The real hosted content for a collapsed tool row, rasterised at 3x on the
    /// page background it sits on in the app.
    private func render(detail: String?, dark: Bool) throws -> Raster {
        let row = TimelineRow(
            id: "tool#0", revision: 0,
            content: .toolChip(name: "Bash", detail: detail, inputPreview: nil,
                               resultPreview: nil, agent: nil, expanded: false),
            height: 28)
        // `ImageRenderer` rather than a hosting controller in a window: SwiftUI
        // content that never reached the screen rasterises BLANK through both
        // `drawHierarchy` and `layer.render` (measured: every pixel 1.000), and a
        // blank bitmap silently measures as perfect contrast. The scheme rides the
        // environment, and `assertScheme` is what proves it took.
        let content = TimelineHostedCell.content(for: row, delegate: nil)
            .frame(width: pageWidth)
            .background(Color(.systemBackground))
            .environment(\.colorScheme, dark ? .dark : .light)
        let renderer = ImageRenderer(content: content)
        renderer.scale = CGFloat(scale)
        renderer.isOpaque = true
        let image = try XCTUnwrap(renderer.uiImage, "ImageRenderer produced no image")
        let raster = try Raster(image, scale: scale)
        print("[toolchip] \(dark ? "dark" : "light") detail=\(detail == nil ? "nil" : "yes") "
              + "size=\(Int(image.size.width))x\(Int(image.size.height)) \(raster.debugSummary)")
        return raster
    }

    // MARK: - Pixels

    struct Band { let x0: Int; let x1: Int }
    struct Measurement { let ink: Double; let paper: Double; let ratio: Double }
    struct LayoutChanged: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }

    /// One rasterised row: per-pixel luminance plus the mean channel value, which
    /// is what edge-finding uses. Channels rather than luminance for edges because
    /// dark mode's capsule (28/255 over a black page) is an obvious channel step
    /// and a nearly invisible luminance one.
    struct Raster {
        let width: Int
        let height: Int
        private let lum: [Double]
        private let chan: [Double]
        private let scale: Int
        /// Vertical slice the text and the glyph both live in.
        private let y0: Int
        private let y1: Int
        /// x of the capsule's painted trailing edge (exclusive).
        let capsuleRight: Int
        private let capsuleLeft: Int
        private let capsulePaper: Double

        init(_ image: UIImage, scale: Int) throws {
            let cg = try XCTUnwrap(image.cgImage, "render produced no bitmap")
            width = cg.width
            height = cg.height
            self.scale = scale
            var bytes = [UInt8](repeating: 0, count: width * height * 4)
            let ctx = try XCTUnwrap(CGContext(
                data: &bytes, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue), "no bitmap context")
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
            func linear(_ c: Double) -> Double {
                c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
            }
            var lums = [Double](repeating: 0, count: width * height)
            var chans = [Double](repeating: 0, count: width * height)
            for i in 0..<(width * height) {
                let r = Double(bytes[i * 4]) / 255
                let g = Double(bytes[i * 4 + 1]) / 255
                let b = Double(bytes[i * 4 + 2]) / 255
                lums[i] = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
                chans[i] = (r + g + b) / 3
            }
            lum = lums
            chan = chans
            y0 = Int(Double(height) * 0.28)
            y1 = max(y0 + 1, Int(Double(height) * 0.72))
            // The row is leading-aligned, so the far right is bare page.
            let midY = height / 2
            let page = chans[midY * width + (width - 2)]
            var right = width - 2
            while right > 0, abs(chans[midY * width + right] - page) < 0.025 { right -= 1 }
            capsuleLeft = Int(TimelineMetrics.hMargin) * scale
            capsuleRight = right + 1
            let from = min(capsuleLeft + 2 * scale, width - 1)
            let to = min(max(from + 1, capsuleRight - 2 * scale), width)
            // Paper = the capsule fill: the mode of its interior, where the ink is
            // always the minority.
            var counts: [Double: Int] = [:]
            for y in y0..<y1 {
                for x in from..<to {
                    counts[(chans[y * width + x] * 255).rounded() / 255, default: 0] += 1
                }
            }
            capsulePaper = counts.max { $0.value < $1.value }?.key ?? page
            let lo = chans.min() ?? 0
            let hi = chans.max() ?? 0
            isBlank = hi - lo < 0.02
            debugSummary = "chan \(String(format: "%.3f…%.3f", lo, hi)) page=\(String(format: "%.3f", page)) "
                + "capsule=[\(capsuleLeft),\(capsuleRight)) paper=\(String(format: "%.3f", capsulePaper))"
        }

        /// Nothing drew: every pixel the same. Used to fall back to a second
        /// rendering path rather than measuring an empty bitmap.
        let isBlank: Bool
        let debugSummary: String

        /// Columns inside the capsule that carry ink, grouped into clusters with a
        /// 4pt gap (wider than any letter gap at caption size, narrower than the
        /// row's 5pt element spacing).
        func capsuleInkClusters() throws -> [Band] {
            let inkStep = 0.09
            var inked: [Bool] = []
            let from = capsuleLeft + 2 * scale
            let to = max(from + 1, capsuleRight - 2 * scale)
            for x in from..<to {
                var hit = false
                for y in y0..<y1 where abs(chan[y * width + x] - capsulePaper) > inkStep {
                    hit = true
                    break
                }
                inked.append(hit)
            }
            var out: [Band] = []
            var start: Int?
            var lastInk = 0
            let gap = 4 * scale
            for (i, on) in inked.enumerated() {
                let x = from + i
                if on {
                    if start == nil { start = x }
                    lastInk = x
                } else if let s = start, x - lastInk > gap {
                    out.append(Band(x0: s, x1: lastInk + 1))
                    start = nil
                }
            }
            if let s = start { out.append(Band(x0: s, x1: lastInk + 1)) }
            XCTAssertFalse(out.isEmpty, "no ink found inside the capsule")
            return out
        }

        /// Ink vs paper for one band, the way the phone was measured: paper is the
        /// band's modal luminance, ink is the mode of the 8% farthest from it.
        func measure(_ band: Band) -> Measurement {
            var values: [Double] = []
            for y in y0..<y1 {
                for x in max(0, band.x0)..<min(width, band.x1) {
                    values.append(lum[y * width + x])
                }
            }
            guard !values.isEmpty else { return Measurement(ink: 0, paper: 0, ratio: 1) }
            func mode(_ xs: [Double]) -> Double {
                var counts: [Double: Int] = [:]
                for v in xs { counts[(v * 1000).rounded() / 1000, default: 0] += 1 }
                return counts.max { $0.value < $1.value }?.key ?? xs[0]
            }
            let paper = mode(values)
            let far = values.sorted { abs($0 - paper) > abs($1 - paper) }
                .prefix(max(1, values.count * 8 / 100))
            let ink = mode(Array(far))
            let ratio = (max(ink, paper) + 0.05) / (min(ink, paper) + 0.05)
            return Measurement(ink: ink, paper: paper, ratio: ratio)
        }
    }
}
