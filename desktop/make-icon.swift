// Turns a full-bleed square PNG into a macOS Big Sur–style app icon:
// the artwork is scaled into an 824×824 rounded-rect (continuous-corner
// squircle approximation) centered on a transparent 1024×1024 canvas,
// matching Apple's icon grid so it sits in the Dock like every other app.
//
// Usage: swift make-icon.swift <input.png> <output.png>

import AppKit

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write("usage: make-icon.swift <input.png> <output.png>\n".data(using: .utf8)!)
    exit(1)
}
let inputPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]

guard let source = NSImage(contentsOfFile: inputPath) else {
    FileHandle.standardError.write("cannot read \(inputPath)\n".data(using: .utf8)!)
    exit(1)
}

let canvas = 1024
// Apple icon grid: artwork square is 824pt of the 1024pt canvas, corner
// radius ≈ 185.4pt.
let art = 824.0
let inset = (Double(canvas) - art) / 2
let radius = 185.4

guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: canvas, pixelsHigh: canvas,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else { exit(1) }

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

let artRect = NSRect(x: inset, y: inset, width: art, height: art)
let clip = NSBezierPath(roundedRect: artRect, xRadius: radius, yRadius: radius)
clip.addClip()
// from: .zero = the whole source image (its native point space; passing pixel
// dimensions here shifts the artwork when points != pixels).
source.draw(in: artRect, from: .zero, operation: .sourceOver, fraction: 1.0)

NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: outputPath))
