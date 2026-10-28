import Foundation

/// What an html-app island can do beyond drawing: keep its state and hand a result back.
///
/// The phone twin of the web console's `web/src/components/chat/island-runtime.ts`, and
/// the same protocol, so a model writes ONE island for both surfaces
/// (`walnut-rich-output` skill, "Keep the island's state" and "Hand a result back").
///
/// 2026-10-27, the user, halfway through a 15-question quiz: it went back to question 1.
/// An island's web view has a non-persistent data store and an opaque origin, so the
/// page has no storage of its own, and its document is rebuilt on every cell reuse, the
/// live row settling, a light/dark flip, leaving the session and a relaunch. This
/// runtime is injected at the top of every island document and gives it:
///
///  - `localStorage` / `sessionStorage` that work (one store, like a reload of a real
///    page keeps both). Reads are synchronous from a seed the app wrote INTO the
///    document, so the model's first script line already sees its state. Writes post
///    the whole store to the app, one post per burst (a microtask) and flushed on `pagehide` and on
///    the page going hidden (`IslandStateStore` keeps it per island).
///  - `walnut.report(value)`: offer a result to the AI. The app shows it under the
///    island; nothing is sent until the user presses Send. A string as written,
///    anything else as pretty JSON.
///
/// Where the web posts to `parent`, the phone posts to a script message handler in
/// the PAGE world (the island's own code runs there). The handler reference is taken
/// before any of the model's code runs, so an island that replaces `window.webkit`
/// cannot cut the channel. Plain ES5 inside the string.
enum IslandRuntime {
    /// Message types the document posts. Keep in step with island-runtime.ts.
    static let stateMessage = "wn-island-state"
    static let resultMessage = "wn-island-result"
    /// The script message handler the runtime posts to (`.page` content world).
    static let handlerName = "walnutIsland"

    /// The longest result a user can send in one press (characters).
    static let resultMax = 16000
    /// The most an island may keep (characters of its serialized store); the web twin's
    /// ISLAND_STATE_MAX, so one island keeps the same state on both.
    static let stateMax = 48 * 1024

    /// What the native side gave the document: an opaque per-load token the document
    /// names in every message (never the store key itself, so one island cannot name
    /// another's record), and the store to start from.
    struct Seed: Equatable {
        var token: String
        var items: [String: String]
    }

    /// A well-formed message from the document.
    enum Message: Equatable {
        case state(token: String, items: [String: String])
        case result(token: String, text: String)
    }

    /// JSON that is safe inside a `<script>` element: no `</script>`, no `<!--`, and no
    /// U+2028 / U+2029 (line terminators in older JavaScript string grammar).
    static func scriptJSON(_ value: Any) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: value,
                                                options: [.fragmentsAllowed, .sortedKeys,
                                                          .withoutEscapingSlashes]))
            ?? Data("null".utf8)
        let json = String(decoding: data, as: UTF8.self)
        return json
            .replacingOccurrences(of: "<", with: "\\u003c")
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    /// The `<script>` that gives an island its storage and `walnut.report`. It must run
    /// before any of the model's own scripts, so the document puts it first.
    static func script(_ seed: Seed) -> String {
        "<script>(function(){"
            + "var K=\(scriptJSON(seed.token)),S=\(scriptJSON(seed.items));"
            + "var H=null;try{H=window.webkit.messageHandlers.\(handlerName)}catch(e){}"
            + "function send(o){try{if(H)H.postMessage(o)}catch(e){}}"
            + "var m=Object.create(null),t=null,has=Object.prototype.hasOwnProperty;"
            + "for(var s in S){if(has.call(S,s))m[s]=String(S[s]);}"
            + "function post(){t=null;var o={};for(var k in m)o[k]=m[k];"
            + "send({t:\(scriptJSON(stateMessage)),k:K,items:o})}"
            // One post per burst of writes, sent before the task ends (a microtask), so a
            // document replaced right after a tap has already handed its state up.
            + "var P=typeof Promise===\"function\"?Promise.resolve():null;"
            + "function dirty(){if(t===null){t=1;if(P)P.then(function(){if(t!==null)post()});else setTimeout(function(){if(t!==null)post()},0)}}"
            + "function flush(){if(t!==null)post();}"
            + "var api={"
            + "getItem:function(k){k=String(k);return k in m?m[k]:null},"
            + "setItem:function(k,v){m[String(k)]=String(v);dirty()},"
            + "removeItem:function(k){k=String(k);if(k in m){delete m[k];dirty()}},"
            + "clear:function(){var n=0;for(var k in m){delete m[k];n++}if(n)dirty()},"
            + "key:function(i){var ks=Object.keys(m);return i>=0&&i<ks.length?ks[i]:null}};"
            + "Object.defineProperty(api,'length',{get:function(){return Object.keys(m).length}});"
            // `localStorage.score = 3` and `localStorage.score` work on a real page too.
            // The proxy's target is an empty object: a target holding the methods would
            // make `Object.keys(localStorage)` break the proxy invariants on `length`.
            + "var store=api;if(typeof Proxy===\"function\"){store=new Proxy({},{"
            + "get:function(o,p){if(p in api||typeof p!==\"string\")return api[p];return p in m?m[p]:undefined},"
            + "set:function(o,p,v){if(p in api||typeof p!==\"string\")return false;api.setItem(p,v);return true},"
            + "deleteProperty:function(o,p){api.removeItem(p);return true},"
            + "has:function(o,p){return p in api||p in m},"
            + "ownKeys:function(){return Object.keys(m)},"
            + "getOwnPropertyDescriptor:function(o,p){return p in m?{value:m[p],writable:true,enumerable:true,configurable:true}:undefined}"
            + "})}"
            + "['localStorage','sessionStorage'].forEach(function(n){"
            + "try{Object.defineProperty(window,n,{value:store,configurable:true})}catch(e){}});"
            + "addEventListener('pagehide',flush);"
            + "document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')flush()});"
            + "var w=window.walnut||{};"
            + "w.report=function(v){var x;if(typeof v===\"string\")x=v;"
            + "else{try{x=JSON.stringify(v,null,2)}catch(e){x=String(v)}}"
            + "send({t:\(scriptJSON(resultMessage)),k:K,text:String(x)})};"
            + "window.walnut=w;"
            + "})()</script>"
    }

    /// Read a script message body. Anything not exactly one of the two shapes is
    /// dropped; a state message keeps only its string values (the web twin's rule).
    static func parse(_ body: Any) -> Message? {
        guard let dict = body as? [String: Any],
              let type = dict["t"] as? String,
              let token = dict["k"] as? String, !token.isEmpty else { return nil }
        switch type {
        case stateMessage:
            guard let raw = dict["items"] as? [String: Any] else { return nil }
            var items: [String: String] = [:]
            for (key, value) in raw {
                if let string = value as? String { items[key] = string }
            }
            return .state(token: token, items: items)
        case resultMessage:
            guard let text = dict["text"] as? String else { return nil }
            return .result(token: token, text: cleanResultText(text))
        default:
            return nil
        }
    }

    /// Characters that change what the reader sees without being seen. A result keeps
    /// none of them, so the text the user reads is the text the AI gets: every control
    /// and format character (bidi overrides and isolates, zero-width spaces, the BOM, the
    /// soft hyphen, tag characters that can spell out hidden ASCII) except newline, tab
    /// and ZWJ (emoji need it), the blank fillers, and the variation selectors that can
    /// encode hidden bytes. Emoji keep one U+FE0E/U+FE0F; a run of them collapses to one.
    /// The web twin's `cleanResultText`.
    static func cleanResultText(_ text: String) -> String {
        let fillers: Set<UInt32> = [0x034F, 0x115F, 0x1160, 0x3164, 0xFFA0]
        var scalars = String.UnicodeScalarView()
        var lastWasSelector = false
        for scalar in text.unicodeScalars {
            let v = scalar.value
            let category = scalar.properties.generalCategory
            let hidden = (category == .control || category == .format)
                && v != 0x0A && v != 0x09 && v != 0x200D
            if hidden || fillers.contains(v) || (0xFE00...0xFE0D).contains(v)
                || (0xE0100...0xE01EF).contains(v) { continue }
            let selector = v == 0xFE0E || v == 0xFE0F
            if selector && lastWasSelector { continue }
            lastWasSelector = selector
            scalars.append(scalar)
        }
        return String(scalars)
    }

    /// A result that would run as a slash command instead of reaching the AI as words.
    static func isCommandLike(_ text: String) -> Bool {
        text.drop(while: { $0.isWhitespace }).hasPrefix("/")
    }

    /// Length of the store as the web measures it (`JSON.stringify(items).length`,
    /// UTF-16 units), for the `stateMax` cap.
    static func serializedLength(_ items: [String: String]) -> Int {
        guard let data = try? JSONSerialization.data(withJSONObject: items,
                                                        options: [.withoutEscapingSlashes])
        else { return Int.max }
        return String(decoding: data, as: UTF8.self).utf16.count
    }
}
