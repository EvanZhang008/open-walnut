#!/usr/bin/env python3
"""Judge an audio-output-watch log: did anything in the Simulator make sound?

  audio-output-check.py LOG [--require-device]

Fails (exit 1) when a process running from a Simulator ran audio output, or when the app
under test (Walnut.app) ran audio input: a silent run opens no audio hardware at all
(ios-native/Walnut/Core/AudioSilence.swift). With no output device on this Mac, a process
list that could not be read, or an empty log, nothing is proven: the last line says
"not proven", never "silent", and --require-device makes that exit 3.
Prints one line per finding, as GitHub annotations.
"""
import os
import sys


def judge(lines):
    devices, rows, unreadable = [], [], 0
    for line in lines:
        cols = line.rstrip("\n").split("\t")
        if cols[0] == "#devices" and len(cols) > 1 and cols[1].isdigit():
            devices.append(int(cols[1]))
        elif cols[0] == "#unreadable":
            unreadable += 1
        elif len(cols) >= 5 and not cols[0].startswith("#"):
            rows.append({"t": cols[0], "pid": cols[1], "out": cols[2] == "1", "in": cols[3] == "1", "path": cols[4]})
    errors = []
    for r in rows:
        name = os.path.basename(r["path"]) or r["path"]
        if r["out"]:
            errors.append(f"pid {r['pid']} {name} ran audio output in the Simulator at {r['t']} ({r['path']})")
        elif r["in"] and "/Walnut.app/" in r["path"]:
            errors.append(f"pid {r['pid']} {name} opened audio input (the microphone) at {r['t']}: a silent run opens no audio hardware")
    notes = []
    if not devices:
        notes.append("the watch wrote no device count: it did not run")
    elif max(devices) == 0:
        notes.append("this Mac has no audio output device: nothing could be heard, and silence is not proven")
    if unreadable:
        notes.append(f"the audio process list could not be read {unreadable} time(s)")
    return errors, notes, len({r['pid'] for r in rows})


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        with open(argv[1], encoding="utf-8") as f:
            errors, notes, clients = judge(f)
    except OSError as e:
        print(f"::error::audio watch log unreadable: {e}")
        return 1
    for e in errors:
        print(f"::error::{e}")
    for n in notes:
        print(f"::warning::{n}")
    if errors:
        return 1
    if notes:
        # No output device, no process list read, or no log: nothing ran output that the
        # watch saw, and that proves nothing. The last line never says silent then.
        print(f"not proven: {'; '.join(notes)}")
        return 3 if "--require-device" in argv else 0
    print(f"silent: {clients} Simulator process(es) were audio clients, none ran output")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
