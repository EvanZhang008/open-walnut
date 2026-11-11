#!/usr/bin/env python3
"""Why an iOS test run is a voice, microphone or audio run; prints nothing when it is not.

  ios-run-audio.py <ios-native dir> <unit|ui|build|run> [ARGS...]

The answer comes from what the run does, never from words about it: the tests it selects and
what their sources call, or the command it runs (2026-11-11: a board test was refused on a Mac
because its task's description quoted the user's "voice" message).

  build  compiles only: never an audio run.
  unit   WalnutTests, narrowed by -only-testing / -skip-testing. Logic tests of voice code
         touch no device, so a name does not count: only a selected test whose source starts
         audio hardware (AVAudioEngine(), AVAudioRecorder(, a record permission, ...).
  ui     WalnutUITests, narrowed the same way. A UI test drives the app, whose voice screens
         open the microphone, so a selected test named for one (Voice, Talk, Dictation, ...)
         counts, as does one whose source starts audio hardware.
  run    the command itself: an -only-testing it carries is judged as above, else its words.
"""
import os, re, sys

HARDWARE = re.compile(
    r"\b(AVAudioEngine|AVAudioRecorder|AVAudioPlayer|AVAudioPlayerNode|AVSpeechSynthesizer|SFSpeechRecognizer"
    r"|SFSpeechAudioBufferRecognitionRequest)\s*\(|\bAudioServicesPlay\w*\s*\(|\brequestRecordPermission\b"
    r"|\bAVAudioApplication\.requestRecordPermission\b|requestAccess\s*\(\s*for:\s*\.audio")
VOICE_WORDS = {"voice", "talk", "dictation", "dictate", "speech", "microphone", "mic", "audio", "recorder",
               "recording", "stt", "tts", "asr", "siri", "transcribe", "transcription"}
TARGETS = {"unit": "WalnutTests", "ui": "WalnutUITests"}


def words(name):
    """Words of an identifier or a command: VoiceDictationUITests -> voice, dictation, ui, tests."""
    out = []
    for part in re.split(r"[^A-Za-z0-9]+", name):
        out += [w.lower() for w in re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+", part)]
    return out


def voice_word(name):
    return next((w for w in words(name) if w in VOICE_WORDS), None)


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    return re.sub(r"//[^\n]*", " ", src)


def sources(root, target):
    """Class name -> source text of every test file of the target (a file may hold several classes)."""
    found = {}
    base = os.path.join(root, target)
    for folder, _, files in os.walk(base):
        for f in files:
            if not f.endswith(".swift"):
                continue
            try:
                text = open(os.path.join(folder, f), encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            code = strip_comments(text)
            classes = re.findall(r"\bclass\s+(\w+)\s*:", code) or [f[:-6]]
            for c in classes:
                found[c] = code
    return found


def selection(args):
    """(only, skip): lists of (target, class or None, method or None) from xcodebuild's filters."""
    only, skip = [], []
    for a in args:
        m = re.match(r"-(only|skip)-testing:([^/\s]+)(?:/([^/\s]+))?(?:/(\S+))?$", a)
        if m:
            (only if m.group(1) == "only" else skip).append((m.group(2), m.group(3), m.group(4)))
    return only, skip


def judge(root, target, args, names_count):
    only, skip = selection(args)
    srcs = sources(root, target)
    skipped = {c for t, c, m in skip if t == target and c and not m}
    if any(t == target and c is None for t, c, m in skip):
        return None
    picked = [(c, m) for t, c, m in only if t == target and c]
    if not picked and (not only or any(t == target and c is None for t, c, m in only)):
        picked = [(c, None) for c in sorted(srcs)]
    for cls, method in picked:
        if cls in skipped:
            continue
        if names_count:
            w = voice_word(cls) or (voice_word(method) if method else None)
            if w:
                return "it runs %s, a %s test" % (cls + ("/" + method if method else ""), w)
        m = HARDWARE.search(srcs.get(cls, ""))
        if m:
            return "%s starts audio hardware (%s)" % (cls, re.sub(r"\s*\($", "", m.group(0).strip()))
    return None


def main(argv):
    if len(argv) < 3:
        sys.exit("usage: ios-run-audio.py <ios-native dir> <unit|ui|build|run> [ARGS...]")
    root, mode, args = argv[1], argv[2], argv[3:]
    why = None
    if mode in TARGETS:
        why = judge(root, TARGETS[mode], args, names_count=(mode == "ui"))
    elif mode == "run":
        only, _ = selection(args)
        for target, ui in (("WalnutUITests", True), ("WalnutTests", False)):
            if why is None and any(t == target for t, c, m in only):
                why = judge(root, target, args, names_count=ui)
        if why is None and not only:
            w = voice_word(" ".join(args))
            if w:
                why = 'its command names "%s"' % w
    if why:
        print(why)


if __name__ == "__main__":
    main(sys.argv)
