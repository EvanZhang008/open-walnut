import Foundation
import WebKit

/// The app makes no sound where a test or an agent runs it (2026-11-08: a test run on
/// someone else's Mac, with a person at it, woke its built-in speaker; a Simulator plays
/// through the Mac's own speakers).
///
/// Silent in the Simulator, under XCTest (the hosted unit tests), with the launch
/// argument `-walnut.silentAudio YES` (every UI test, through `UITestLaunch`), or with
/// `WALNUT_SILENT_AUDIO=1` in the environment. A person who wants sound in the Simulator
/// launches it with `-walnut.allowSound YES`. A real device is never silenced by this.
///
/// Silent means the app plays at volume zero (speech, music, recordings, media) or skips
/// the cue, so its own state (speaking, playing, finished) moves the same way. Nothing
/// here touches the machine's volume or mute. Every sound site reads it; the ratchet is
/// tests/ios/audio-silence-sites.test.ts.
enum AudioSilence {
    static let silentArgument = "walnut.silentAudio"
    static let allowArgument = "walnut.allowSound"

    static let isOn: Bool = decide(
        defaults: UserDefaults.standard,
        environment: ProcessInfo.processInfo.environment,
        simulator: runsInSimulator
    )

    /// The volume a player should use: `volume` normally, 0 while silent.
    static func volume(_ volume: Float) -> Float { isOn ? 0 : volume }

    static func decide(defaults: UserDefaults, environment: [String: String], simulator: Bool) -> Bool {
        if defaults.bool(forKey: silentArgument) { return true }
        if environment["XCTestConfigurationFilePath"] != nil { return true }
        if environment["WALNUT_SILENT_AUDIO"] == "1" { return true }
        return simulator && !defaults.bool(forKey: allowArgument)
    }

    /// A web view plays no sound either: its page is silenced from document start, every
    /// frame included, before any script of its own (an island's, a previewed file's).
    /// Media muted, Web Audio to the speakers through a gain of zero, speech at volume
    /// zero, and muted again when the page's own controls unmute it: the web app's silencer (web/src/utils/automation-silence.ts), which a
    /// WKWebView never loads and whose `navigator.webdriver` gate is false here. App user
    /// scripts run even where the page's own JavaScript is off (a letter).
    static func install(on configuration: WKWebViewConfiguration) {
        guard isOn else { return }
        configuration.userContentController.addUserScript(
            WKUserScript(source: webScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    }

    /// ES5, run as it is; tests/web/automation-silence.test.ts runs this exact text against
    /// the same checks as the web silencer.
    static let webScript = #"(function(){try{var w=globalThis;if(w.__walnutSilent)return;w.__walnutSilent=true;var M=w.HTMLMediaElement&&w.HTMLMediaElement.prototype;if(M){var d=Object.getOwnPropertyDescriptor(M,'muted');if(d&&d.get&&d.set){var s=d.set;Object.defineProperty(M,'muted',{configurable:true,enumerable:d.enumerable,get:d.get,set:function(){s.call(this,true)}})}var p=M.play;if(typeof p==='function'){M.play=function(){try{this.muted=true}catch(e){}return p.apply(this,arguments)}}var q=function(e){var t=e.target;if(t&&M.isPrototypeOf(t)&&!t.muted){try{t.muted=true}catch(x){}}};if(w.document&&w.document.addEventListener){w.document.addEventListener('loadstart',q,true);w.document.addEventListener('play',q,true);w.document.addEventListener('volumechange',q,true)}}var N=w.AudioNode&&w.AudioNode.prototype,D=w.AudioDestinationNode;if(N&&D&&typeof N.connect==='function'){var c=N.connect,z=new WeakMap();N.connect=function(t){var r=Array.prototype.slice.call(arguments,1),x=t instanceof D?t.context:null;if(!x||(w.OfflineAudioContext&&x instanceof w.OfflineAudioContext))return c.apply(this,[t].concat(r));var g=z.get(x);if(!g){g=x.createGain();g.gain.value=0;c.call(g,t);z.set(x,g)}c.apply(this,[g].concat(r));return t}}var S=w.SpeechSynthesis&&w.SpeechSynthesis.prototype;if(S&&typeof S.speak==='function'){var k=S.speak;S.speak=function(u){try{if(u)u.volume=0}catch(e){}return k.call(this,u)}}}catch(e){}})();"#

    static var runsInSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }
}
