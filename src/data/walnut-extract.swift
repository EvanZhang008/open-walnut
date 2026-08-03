// walnut-extract — extract searchable text from a PDF or image, entirely with
// macOS system frameworks (PDFKit text layer, Vision OCR). No third-party deps.
//
//   walnut-extract <file>     → UTF-8 text on stdout, exit 0
//                               exit 2: unsupported/unreadable input
//
// PDFs: use the embedded text layer when present; pages without one (scans)
// are rendered at 2x and OCR'd. Images: straight to OCR. Recognition languages
// cover the vault's content (Simplified Chinese + English).
import Foundation
import PDFKit
import Vision
import AppKit

let MAX_OCR_PAGES = 20
let OCR_LANGS = ["zh-Hans", "en-US"]

func ocr(_ cgImage: CGImage) -> String {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = OCR_LANGS
  request.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  guard (try? handler.perform([request])) != nil else { return "" }
  let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
  return lines.joined(separator: "\n")
}

func renderPage(_ page: PDFPage) -> CGImage? {
  let bounds = page.bounds(for: .mediaBox)
  let scale: CGFloat = 2.0
  let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
  guard size.width > 4, size.height > 4,
        let ctx = CGContext(data: nil, width: Int(size.width), height: Int(size.height),
                            bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
  else { return nil }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(origin: .zero, size: size))
  ctx.scaleBy(x: scale, y: scale)
  ctx.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
  page.draw(with: .mediaBox, to: ctx)
  return ctx.makeImage()
}

func extractPdf(_ url: URL) -> String? {
  guard let doc = PDFDocument(url: url) else { return nil }
  var parts: [String] = []
  var ocrBudget = MAX_OCR_PAGES
  for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    let text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if text.count >= 16 {
      parts.append(text)
    } else if ocrBudget > 0, let img = renderPage(page) {
      ocrBudget -= 1
      let recognized = ocr(img)
      if !recognized.isEmpty { parts.append(recognized) }
    }
  }
  return parts.joined(separator: "\n\n")
}

func extractImage(_ url: URL) -> String? {
  guard let image = NSImage(contentsOf: url),
        let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else { return nil }
  return ocr(cg)
}

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write("usage: walnut-extract <file>\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let ext = url.pathExtension.lowercased()
let result: String? = ext == "pdf" ? extractPdf(url) : extractImage(url)
guard let text = result else { exit(2) }
FileHandle.standardOutput.write(text.data(using: .utf8)!)
