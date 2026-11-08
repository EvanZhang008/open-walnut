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
    /// frame included, before any script of its own (an island's, a previewed file's). Media
    /// never plays, an AudioContext cannot be made (WebKit has no way to run one without an
    /// output device), speech is never spoken: the web app's silencer
    /// (src/lib/automation-silence.ts), which a WKWebView never loads and whose
    /// `navigator.webdriver` gate is false here. App user scripts run even where the page's
    /// own JavaScript is off (a letter).
    static func install(on configuration: WKWebViewConfiguration) {
        guard isOn else { return }
        configuration.userContentController.addUserScript(
            WKUserScript(source: webScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    }

    /// ES5, run as it is; tests/web/automation-silence.test.ts runs this exact text against
    /// the same checks as the web silencer.
    static let webScript = #"(function(){try{var w=globalThis;if(w.__walnutSilent)return;w.__walnutSilent=true;var T={contexts:0,blocked:0,plays:0,speech:0};w.__walnutAudio=T;var R=function(n){var E=w.DOMException;return E?new E('No audio in a test run',n):new Error('No audio in a test run')};var M=w.HTMLMediaElement&&w.HTMLMediaElement.prototype;if(M){var d=Object.getOwnPropertyDescriptor(M,'muted'),ms=d&&d.set;if(d&&d.get&&d.set){Object.defineProperty(M,'muted',{configurable:true,enumerable:d.enumerable,get:d.get,set:function(){ms.call(this,true)}})}var ad=Object.getOwnPropertyDescriptor(M,'autoplay'),as=ad&&ad.set;if(ad&&ad.get&&ad.set){Object.defineProperty(M,'autoplay',{configurable:true,enumerable:ad.enumerable,get:ad.get,set:function(){as.call(this,false)}})}var hold=function(t,e){try{if(ms)ms.call(t,true);else t.muted=true;if(as)as.call(t,false);if(e&&e.type==='play'&&t.pause){T.plays++;t.pause()}}catch(x){}};var q=function(e){var t=e.target;if(t&&M.isPrototypeOf(t))hold(t,e)};var listen=function(n){if(n&&n.addEventListener){n.addEventListener('loadstart',q,true);n.addEventListener('play',q,true);n.addEventListener('volumechange',q,true)}};var seen=w.WeakSet?new w.WeakSet():null;var guard=function(t){if(!t||!M.isPrototypeOf(t)||(seen&&seen.has(t)))return t;if(seen)seen.add(t);hold(t);listen(t);return t};listen(w.document);if(typeof M.play==='function'){M.play=function(){guard(this);T.plays++;try{if(this.pause)this.pause()}catch(e){}return w.Promise.reject(R('NotAllowedError'))}}var lo=M.load;if(typeof lo==='function'){M.load=function(){guard(this);return lo.apply(this,arguments)}}var ks=['src','srcObject'];for(var j=0;j<ks.length;j++){(function(k){var sd=Object.getOwnPropertyDescriptor(M,k);if(!sd||!sd.set)return;var ss=sd.set;Object.defineProperty(M,k,{configurable:true,enumerable:sd.enumerable,get:sd.get,set:function(v){guard(this);ss.call(this,v)}})})(ks[j])}var EP=w.Element&&w.Element.prototype;if(EP){var sa=EP.setAttribute;if(typeof sa==='function'){EP.setAttribute=function(n){if(M.isPrototypeOf(this)){guard(this);if(String(n).toLowerCase()==='autoplay')return}return sa.apply(this,arguments)}}var at=EP.attachShadow;if(typeof at==='function'){EP.attachShadow=function(){var r=at.apply(this,arguments);listen(r);return r}}}var DP=w.Document&&w.Document.prototype;if(DP){var cs=['createElement','createElementNS'];for(var c2=0;c2<cs.length;c2++){(function(k){var f=DP[k];if(typeof f==='function'){DP[k]=function(){return guard(f.apply(this,arguments))}}})(cs[c2])}}var A=w.Audio;if(typeof A==='function'){var SA=function(s){return guard(arguments.length?new A(s):new A())};SA.prototype=A.prototype;w.Audio=SA}}var names=['AudioContext','webkitAudioContext'];for(var i=0;i<names.length;i++){(function(name){var N=w[name];if(typeof N!=='function'||N.__walnutSilent)return;var dl=!!N.prototype&&typeof N.prototype.setSinkId==='function';var S=function(o){T.contexts++;if(!dl){if(/ WalnutVoiceTest$/.test((w.navigator&&w.navigator.userAgent)||''))return new N(o);T.blocked++;throw R('NotSupportedError')}var p={};if(o)for(var k in o)p[k]=o[k];p.sinkId={type:'none'};return new N(p)};S.prototype=N.prototype;S.__walnutSilent=true;if(dl)N.prototype.setSinkId=function(){return w.Promise.resolve()};w[name]=S})(names[i])}var P=w.AudioNode&&w.AudioNode.prototype,D=w.AudioDestinationNode;if(P&&D&&typeof P.connect==='function'){var c=P.connect,z=new WeakMap();P.connect=function(t){var r=Array.prototype.slice.call(arguments,1),x=t instanceof D?t.context:null;if(!x||(w.OfflineAudioContext&&x instanceof w.OfflineAudioContext))return c.apply(this,[t].concat(r));var g=z.get(x);if(!g){g=x.createGain();g.gain.value=0;c.call(g,t);z.set(x,g)}c.apply(this,[g].concat(r));return t}}var S2=w.SpeechSynthesis&&w.SpeechSynthesis.prototype;if(S2&&typeof S2.speak==='function'){S2.speak=function(){T.speech++}}}catch(e){}})();"#

    static var runsInSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }
}
