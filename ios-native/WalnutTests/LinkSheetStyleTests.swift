import XCTest

/// A sheet reads the environment of the view it hangs on. A link handler that sits BEFORE a
/// colour in a modifier chain hangs its viewer and letter sheets inside that colour, so a link in
/// an Org task's Needs-you line opened its viewer in the line's orange-red. The handler goes after
/// every colour in its chain.
final class LinkSheetStyleTests: XCTestCase {
    private func swiftFiles() throws -> [URL] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut")
        let walker = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        return walker.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }

    func testNoLinkHandlerSitsBeforeAColourInItsModifierChain() throws {
        let colours = [".foregroundStyle(", ".foregroundColor(", ".tint(", ".accentColor("]
        var bad: [String] = []
        var handlers = 0
        for file in try swiftFiles() {
            let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
            for (i, line) in lines.enumerated() {
                let t = line.trimmingCharacters(in: .whitespaces)
                guard t.hasPrefix(".handlingFilePathLinks(") || t.hasPrefix(".handlingTaggedFilePathLinks(") else { continue }
                handlers += 1
                var j = i + 1
                while j < lines.count, lines[j].trimmingCharacters(in: .whitespaces).hasPrefix(".") {
                    if colours.contains(where: { lines[j].contains($0) }) { bad.append("\(file.lastPathComponent):\(i + 1)") }
                    j += 1
                }
            }
        }
        XCTAssertGreaterThan(handlers, 5, "the scan found no link handlers: it reads the wrong files")
        XCTAssertEqual(bad, [], "a link handler before a colour opens its sheets in that colour")
    }

    func testTheTintedLinesPutTheHandlerLast() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let org = try String(contentsOf: root.appendingPathComponent("Walnut/Views/Org/OrgNodeTasksView.swift"), encoding: .utf8)
        let tint = try XCTUnwrap(org.range(of: ".foregroundStyle(state == .needs ? Theme.needsText : .secondary)"))
        let handler = try XCTUnwrap(org.range(of: ".handlingFilePathLinks(source: OrgNodeTasksModel.lineSource(task))"))
        XCTAssertLessThan(tint.lowerBound, handler.lowerBound)
    }
}
