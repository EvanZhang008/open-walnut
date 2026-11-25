// WebContentProcess.layerCensus: the count of the app's own layers the watchdog logs beside a page's
// memory breakdown, to tell whether the page's leftover graphics sit in the web view's layer tree.
// Run: scripts/test-desktop.sh (macOS).
import Cocoa

@main
enum LayerCensusTests {
    static func main() {
        var failures = 0
        func check(_ ok: Bool, _ what: String) {
            print((ok ? "ok   " : "FAIL ") + what)
            if !ok { failures += 1 }
        }

        let root = CALayer()
        let shown = CALayer(); shown.contents = NSImage(size: NSSize(width: 1, height: 1))
        let hiddenParent = CALayer(); hiddenParent.isHidden = true
        let underHidden = CALayer(); underHidden.contents = NSImage(size: NSSize(width: 1, height: 1))
        let clear = CALayer(); clear.opacity = 0
        let deep = CALayer()
        root.addSublayer(shown)
        root.addSublayer(hiddenParent)
        hiddenParent.addSublayer(underHidden)
        root.addSublayer(clear)
        clear.addSublayer(deep)

        let c = WebContentProcess.layerCensus(root)
        check(c.total == 6, "counts every layer, the root included (\(c.total))")
        check(c.withContents == 2, "counts the layers that draw something (\(c.withContents))")
        check(c.hidden == 4, "a layer under a hidden or transparent one counts as hidden (\(c.hidden))")
        check(c.maxDepth == 2, "the deepest layer is two below the root (\(c.maxDepth))")
        check(WebContentProcess.layerCensusField(c) == "6/2/4/2", "the log field reads total/withContents/hidden/maxDepth")
        check(WebContentProcess.layerCensus(nil) == WebContentProcess.LayerCensus(), "no layer: an empty census")
        check(WebContentProcess.layerCensus(root, limit: 3).total == 3, "a huge tree stops at the limit")

        if failures > 0 { print("\(failures) failure(s)"); exit(1) }
        print("layer census: all passed")
    }
}
