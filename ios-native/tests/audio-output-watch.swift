// audio-output-watch: proves a Simulator run made no sound, without listening to anything.
//
// It opens no audio stream and sets no device, volume or mute: it only reads CoreAudio's
// process list (which processes are running audio input or output right now,
// kAudioProcessPropertyIsRunningOutput / IsRunningInput), the same reading the quiet guard
// on a person's Mac stops a run on (2026-11-26: a UI test's letter mic made the app an
// audio output there).
//
//   audio-output-watch watch OUT    every 100 ms until SIGTERM or SIGINT, append to OUT one
//                                   line per change: "<unix time>\t<pid>\t<out 0|1>\t<in 0|1>\t<path>"
//                                   for every process running from a Simulator (a path under
//                                   CoreSimulator), and "#devices\t<n>" for the output devices
//                                   this Mac has (none means nothing could be heard OR proven)
//
// ios-native/tests/audio-output-check.py reads OUT and fails on any Simulator process that ran
// output. Build: swiftc -O ios-native/tests/audio-output-watch.swift -o audio-output-watch
import CoreAudio
import Darwin
import Foundation

func readU32(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> UInt32? {
    var a = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var v: UInt32 = 0
    var s = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(obj, &a, 0, nil, &s, &v) == noErr ? v : nil
}

func objects(_ sel: AudioObjectPropertySelector) -> [AudioObjectID]? {
    var a = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let sys = AudioObjectID(kAudioObjectSystemObject)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(sys, &a, 0, nil, &size) == noErr else { return nil }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard !ids.isEmpty else { return [] }
    var got = size
    let rc = ids.withUnsafeMutableBytes { AudioObjectGetPropertyData(sys, &a, 0, nil, &got, $0.baseAddress!) }
    return rc == noErr ? ids : nil
}

/// Devices with at least one output stream.
func outputDevices() -> Int {
    (objects(kAudioHardwarePropertyDevices) ?? []).filter { id in
        var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &a, 0, nil, &size) == noErr && size > 0
    }.count
}

func exePath(_ pid: pid_t) -> String {
    var buf = [CChar](repeating: 0, count: 4096)
    return proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : ""
}

var stop: sig_atomic_t = 0
signal(SIGTERM) { _ in stop = 1 }
signal(SIGINT) { _ in stop = 1 }

let args = CommandLine.arguments
guard args.count == 3, args[1] == "watch" else {
    FileHandle.standardError.write("usage: audio-output-watch watch OUT\n".data(using: .utf8)!)
    exit(2)
}
let out = args[2]
FileManager.default.createFile(atPath: out, contents: nil)
guard let handle = FileHandle(forWritingAtPath: out) else { exit(2) }
func write(_ line: String) { handle.write((line + "\n").data(using: .utf8)!) }

write("#devices\t\(outputDevices())")
var last: [pid_t: String] = [:]
var unreadable = 0
while stop == 0 {
    if let ids = objects(kAudioHardwarePropertyProcessObjectList) {
        var seen: [pid_t: String] = [:]
        for id in ids {
            guard let raw = readU32(id, kAudioProcessPropertyPID) else { continue }
            let pid = pid_t(Int32(bitPattern: raw))
            let path = exePath(pid)
            guard path.contains("/CoreSimulator/") else { continue }
            let o = (readU32(id, kAudioProcessPropertyIsRunningOutput) ?? 0) != 0 ? 1 : 0
            let i = (readU32(id, kAudioProcessPropertyIsRunningInput) ?? 0) != 0 ? 1 : 0
            seen[pid] = "\(pid)\t\(o)\t\(i)\t\(path)"
        }
        for (pid, row) in seen where last[pid] != row {
            write(String(format: "%.3f\t", Date().timeIntervalSince1970) + row)
        }
        last = seen
    } else {
        unreadable += 1
        if unreadable == 1 || unreadable % 600 == 0 { write("#unreadable\t\(unreadable)") }
    }
    usleep(100_000)
}
write("#devices\t\(outputDevices())")
handle.closeFile()
exit(0)
