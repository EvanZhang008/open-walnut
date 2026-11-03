"""Copy the evidence of failed UI tests out of an .xcresult bundle into a small directory CI
may upload: what the screen showed (screenshots), the UI hierarchy and other plain text the
test attached, and each failed test's step log (which taps XCTest made, when, and what it
waited for). The bundle itself is never uploaded (.github/workflows/ci.yml, job ios).

Everything kept is screened, because a public repo's artifacts are anyone's to download:
  - only attachments the bundle's manifest lists for a failed test, and of those only PNG or
    JPEG images (metadata chunks removed) and UTF-8 plain text; nothing else of the bundle;
  - text with a secret-shaped string is dropped whole (a key, a token, a credential
    assignment or field value, a password in a URL); redacted in place are the user name in
    /Users and /home paths, /var/folders temp dirs, other /var and /private/var paths, the
    volume name in /Volumes paths, e-mail addresses, private host names (.local, .lan,
    .internal, .corp and the like), IPv4 and IPv6 addresses other than loopback, and
    environment lines (NAME=value at the start of a line). Simulator and device UDIDs are
    kept: they name a runner's throwaway simulator, nothing of anyone's;
  - the total is capped (25 MB): the largest files go first, the failure's own capture
    and the step log last, and a note says which.
Matched text is never printed: notes give counts and rule names only. The leak audit
workflow scans the uploaded artifact again.

Usage: ui-failure-evidence.py --bundle B.xcresult --out DIR [--max-bytes N] [--tool CMD]
Always exits 0: a missing or unreadable bundle is a note, never a second failure.
Writes kept=<files> to $GITHUB_OUTPUT and a short table to $GITHUB_STEP_SUMMARY when set.
"""
import argparse
import json
import os
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile

MAX_BYTES = 25 * 1024 * 1024
MAX_TESTS = 20
MAX_TEXT_BYTES = 2 * 1024 * 1024
TOOL_TIMEOUT = 300

# Every rule below runs on text up to MAX_TEXT_BYTES, so every quantifier in it is bounded
# and no rule starts with an open run before its anchor: an unbounded `[\w.-]*` before a
# keyword made a 20,000-character line of 'a-' take minutes (2026-11-02), long enough for
# the job's time limit to cancel it and keep no evidence. A secret rule is only searched,
# so a fixed minimum length ({12}) decides as much as an open one ({12,}).
# Before the rules, a run of more than MAX_TOKEN non-space characters becomes one marker.
MAX_TOKEN = 1000
LONG_TOKEN = re.compile(r"(?<!\S)\S{%d,}" % (MAX_TOKEN + 1))

# A hit drops the whole text file: a partial redaction of a credential is not trusted.
SECRET_RULES = [
    ("private-key", re.compile(r"-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----")),
    # No leading \b where a word before the prefix changes nothing (a dropped file is the safe
    # side): a pattern that starts with its literal is found by re's fast prefix scan, one
    # that starts with \b or a class is tried at every character.
    ("aws-access-key", re.compile(r"A(?:KIA|SIA|BIA|CCA)[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"g(?:h[pousr]_[A-Za-z0-9]{30}|ithub_pat_[A-Za-z0-9_]{30})")),
    ("slack-token", re.compile(r"xox[abposr]-[A-Za-z0-9-]{10}")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_-]{8,%d}\.eyJ[A-Za-z0-9_-]{8,%d}\.[A-Za-z0-9_-]{8}" % (MAX_TOKEN, MAX_TOKEN))),
    ("bearer", re.compile(r"[Bb](?i:earer)[ \t]{1,8}[A-Za-z0-9._~+/=-]{16}")),
    # OpenAI and Anthropic style keys: a named kind (sk-proj-, sk-ant-), or the old 32+ run.
    # Here a word before matters ('desk-admin-...'): the \b is checked after the literal.
    ("sk-key", re.compile(r"sk-(?<!\wsk-)(?:(?:proj|ant|svcacct|admin)-[A-Za-z0-9_-]{20}|[A-Za-z0-9]{32})")),
    ("npm-token", re.compile(r"npm_[A-Za-z0-9]{30}")),
    # an AWS secret key (40 characters) named nearby, with or without '=' between
    ("aws-secret-key", re.compile(
        r"(?i)(?:aws.{0,20}secret|secret.?access.?key).{0,20}?(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])")),
    # a password in a URL: scheme://user:password@host (searched from the '://')
    ("url-credentials", re.compile(r"://[^\s/:@\"'<>]{1,256}:[^\s/@\"'<>]{1,256}@")),
    # 'name: value' or name=value, the name possibly quoted ("token": "..."); searched from the
    # keyword, which may sit inside the name (api_token, x-auth). The rest of the name is
    # taken whole, never given back (a look-ahead and its group: re has no atomic group
    # before Python 3.11): no separator can sit inside it, and giving it back one character
    # at a time made 'secretsecret...' cost 64 steps per keyword.
    ("credential-assignment", re.compile(
        r"(?i:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|auth)(?=(?P<name>[\w.-]{0,64}))(?P=name)[\"']?[ \t]{0,8}[:=][ \t]{0,8}[\"']?[A-Za-z0-9+/_.~-]{12}")),
    # an element whose label or identifier names a credential, as a whole word, holding a
    # key-like value (letters and digits, 16+) on its line: "TextField, label: 'API token',
    # value: ...". 'tokenized search results' names none. A secure field shows dots.
    ("credential-field", re.compile(
        r"(?:identifier|label): '[^'\n]{0,200}?\b(?i:token|secret|passw(?:or)?d|api[ _-]?key|access[ _-]?key)\b[^'\n]{0,200}'"
        r"[^\n]{0,300}?\bvalue:[ \t]{0,4}[\"']?(?=[A-Za-z0-9+/_.~-]{0,200}\d)(?=[A-Za-z0-9+/_.~-]{0,200}[A-Za-z])[A-Za-z0-9+/_.~-]{16}")),
]

# Redacted in place, with a count per rule.
REDACT_RULES = [
    # NAME=value at a line's start; two-letter names too (CI=true, TZ=UTC). Only the start of
    # a line counts, so 'OK=1' inside an element's label is text, not an environment line.
    ("env-line", re.compile(r"(?m)^[ \t]{0,64}(?:export[ \t]{1,8})?[A-Z][A-Z0-9_]{1,64}=.*$"), "<environment line>"),
    ("home-path", re.compile(r"(/Users|/home)/[^/\s\"'<>]{1,%d}" % MAX_TOKEN), r"\1/<user>"),
    ("temp-path", re.compile(r"/(?:private/)?var/folders/[^\s\"'<>]{1,%d}" % MAX_TOKEN), "<temp path>"),
    # a device's or a runner's own paths: /private/var/mobile/Containers/..., /var/root/...
    ("var-path", re.compile(r"/(?<![\w.~-]/)(?:private/)?var/(?!folders/)[^\s\"'<>]{1,%d}" % MAX_TOKEN), "<system path>"),
    ("volume-path", re.compile(r"/Volumes/[^/\s\"'<>]{1,%d}" % MAX_TOKEN), "/Volumes/<volume>"),
    # Both start only where a run of their characters starts, never inside one (the
    # look-behind), so a long run is tried once, not once per character. A host is up to 20
    # labels of up to 63 characters each, as DNS allows; a longer run is not a host name.
    ("email", re.compile(
        r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,256}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,10}"), "<email>"),
    ("private-host", re.compile(
        r"(?<![A-Za-z0-9.-])(\.{0,8})(?:[A-Za-z0-9-]{1,63}\.){1,20}(?i:local|lan|internal|intranet|corp|localdomain)\b"), r"\1<host>"),
    # IPv6: the full eight groups, or a '::' form; never ::1, and never a clock (12:30:45
    # has no '::' and fewer than eight groups).
    ("ipv6-address", re.compile(
        r"(?<![\w:.])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}"
        r"|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?"
        r"|::(?!1(?![\w:.]))(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})(?![\w:.])"), "<ip>"),
    ("ip-address", re.compile(r"\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b"), "<ip>"),
]
# This many environment lines make a file an environment dump: dropped, not redacted.
ENV_DUMP_LINES = 5

PNG_SIG = b"\x89PNG\r\n\x1a\n"
# The chunks a PNG needs to draw; text, EXIF and time chunks are left out.
PNG_KEEP = {b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"iCCP", b"sBIT", b"pHYs"}


def image_kind(name, data):
    """'png' or 'jpeg' when both the name and the bytes say so, else None."""
    ext = os.path.splitext(name)[1].lower()
    if ext == ".png" and data.startswith(PNG_SIG):
        return "png"
    if ext in (".jpg", ".jpeg") and data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    return None


def is_plain_text(name, data):
    if os.path.splitext(name)[1].lower() != ".txt" or len(data) > MAX_TEXT_BYTES or b"\x00" in data:
        return False
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def strip_png(data):
    """The PNG with only the chunks it draws with; None when it does not parse."""
    out = [PNG_SIG]
    i = len(PNG_SIG)
    while i + 8 <= len(data):
        (length,) = struct.unpack(">I", data[i:i + 4])
        ctype = data[i + 4:i + 8]
        end = i + 12 + length
        if end > len(data):
            return None
        if ctype in PNG_KEEP:
            out.append(data[i:end])
        i = end
        if ctype == b"IEND":
            return b"".join(out)
    return None


def strip_jpeg(data):
    """The JPEG without its APP1..APP15 (EXIF, XMP) and comment segments; None when it does not parse."""
    if data[:2] != b"\xff\xd8":
        return None
    out = [data[:2]]
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xDA:  # start of scan: the rest is image data
            out.append(data[i:])
            return b"".join(out)
        (length,) = struct.unpack(">H", data[i + 2:i + 4])
        seg = data[i:i + 2 + length]
        if 0xE1 <= marker <= 0xEF or marker == 0xFE:
            pass
        else:
            out.append(seg)
        i += 2 + length
    return None


def screen_text(text):
    """(screened text or None when dropped, {rule: count}, drop reason or None)."""
    text, long_tokens = LONG_TOKEN.subn(lambda m: "<long token, %d chars>" % len(m.group()), text)
    for rule, pattern in SECRET_RULES:
        if pattern.search(text):
            return None, {}, "secret-shaped text (" + rule + ")"
    env_lines = len(REDACT_RULES[0][1].findall(text))
    if env_lines >= ENV_DUMP_LINES:
        return None, {}, "environment dump (%d environment lines)" % env_lines
    counts = {"long-token": long_tokens} if long_tokens else {}
    for rule, pattern, repl in REDACT_RULES:
        text, n = pattern.subn(repl, text)
        if n:
            counts[rule] = n
    return text, counts, None


def apply_cap(items, max_bytes):
    """Keep items (dicts with 'size' and 'failure') under max_bytes: drop the largest first,
    a failure's own attachment after any other. Returns (kept, dropped)."""
    order = sorted(items, key=lambda it: (it["failure"], -it["size"]))
    total = sum(it["size"] for it in items)
    dropped = []
    for it in order:
        if total <= max_bytes:
            break
        dropped.append(it)
        total -= it["size"]
    # by identity: two attachments with equal fields are two files, and only one may go
    gone = {id(it) for it in dropped}
    kept = [it for it in items if id(it) not in gone]
    return kept, dropped


XCTEST_SUFFIX = re.compile(r"_\d+_[0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27}(?=\.\w+$|$)")


def screen_name(name):
    """A file name for the notes, without XCTest's '_0_<UUID>' and with the redactions text gets."""
    name = XCTEST_SUFFIX.sub("", name)
    for _, pattern, repl in REDACT_RULES:
        name = pattern.sub(repl, name)
    return name if not any(p.search(name) for _, p in SECRET_RULES) else "<name withheld>"


def slug(text, limit=80):
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-.")
    return (s or "x")[:limit]


def file_slug(name, limit=80):
    """A short file name that keeps its extension, without the '_0_<UUID>' XCTest appends."""
    root, ext = os.path.splitext(XCTEST_SUFFIX.sub("", name))
    ext = ("." + slug(ext[1:], 7)) if ext else ""
    return slug(root, limit - len(ext)) + ext


def failed_tests(summary):
    names = []
    for f in summary.get("testFailures") or []:
        name = f.get("testIdentifierString") or ""
        if name and name not in names:
            names.append(name)
    return names


def run_tool(tool, args):
    return subprocess.run(tool + args, capture_output=True, timeout=TOOL_TIMEOUT)


def activity_lines(node, depth, t0, out):
    """A failed test's activities as indented lines: '+12.30s  Tap "Send" Button'."""
    for act in node or []:
        title = str(act.get("title") or "")
        start = act.get("startTime")
        mark = "  <- failure" if act.get("isAssociatedWithFailure") else ""
        stamp = ("+%.2fs" % (start - t0)) if isinstance(start, (int, float)) else "-"
        out.append("%s%s  %s%s" % ("  " * depth, stamp, title, mark))
        activity_lines(act.get("childActivities"), depth + 1, t0, out)


def activities_text(doc):
    """The step log of one test: every XCTest step (taps, queries, waits, failures) with its
    time since the test started."""
    out = []
    for run in doc.get("testRuns") or []:
        acts = run.get("activities") or []
        dev = run.get("device") or {}
        t0 = next((a["startTime"] for a in acts if isinstance(a.get("startTime"), (int, float))), 0)
        out.append("== run on %s, %s %s" % (dev.get("modelName") or "?", dev.get("platform") or "", dev.get("osVersion") or ""))
        activity_lines(acts, 0, t0, out)
    return "\n".join(out) + "\n"


class Collector:
    def __init__(self, out_dir, max_bytes):
        self.out = out_dir
        self.max_bytes = max_bytes
        self.items = []  # {'test','name','path','size','failure','data'}
        self.dropped = []  # (test, name, reason)
        self.redactions = {}
        self.notes = []
        # test -> its directory: an ordinal first, so two names a long slug cuts alike stay apart
        self.dirs = {}

    def add_text(self, test, name, text, failure, order=0):
        screened, counts, reason = screen_text(text)
        if reason:
            self.dropped.append((test, name, reason))
            return
        for k, v in counts.items():
            self.redactions[k] = self.redactions.get(k, 0) + v
        data = screened.encode("utf-8")
        self.items.append({"test": test, "name": name, "size": len(data), "failure": failure, "data": data, "order": order})

    def add_file(self, test, name, data, failure, order=0):
        kind = image_kind(name, data)
        if kind:
            clean = strip_png(data) if kind == "png" else strip_jpeg(data)
            if clean is None:
                self.dropped.append((test, name, "image does not parse"))
                return
            self.items.append({"test": test, "name": name, "size": len(clean), "failure": failure, "data": clean, "order": order})
        elif is_plain_text(name, data):
            self.add_text(test, name, data.decode("utf-8"), failure, order)
        elif name.lower().endswith(".txt") and len(data) > MAX_TEXT_BYTES:
            self.dropped.append((test, name, "text over %d bytes" % MAX_TEXT_BYTES))
        else:
            self.dropped.append((test, name, "not an image or plain text"))

    def write(self):
        kept, capped = apply_cap(self.items, self.max_bytes)
        for it in capped:
            self.dropped.append((it["test"], it["name"], "over the %d byte cap (largest first)" % self.max_bytes))
        manifest = []
        used = set()
        for it in kept:
            d = self.dirs.get(it["test"]) or slug(it["test"])
            # numbered in the order the test made them, so the folder reads as a timeline
            base = ("%02d-" % it["order"] if it["order"] else "") + file_slug(it["name"])
            rel = os.path.join(d, base)
            n = 1
            while rel in used:
                n += 1
                root, ext = os.path.splitext(base)
                rel = os.path.join(d, "%s-%d%s" % (root, n, ext))
            used.add(rel)
            os.makedirs(os.path.join(self.out, d), exist_ok=True)
            with open(os.path.join(self.out, rel), "wb") as f:
                f.write(it["data"])
            it["path"] = rel
            manifest.append({"test": it["test"], "file": rel, "bytes": it["size"], "failure": it["failure"]})
        if kept:
            with open(os.path.join(self.out, "manifest.json"), "w") as f:
                json.dump(manifest, f, indent=1)
            lines = list(self.notes)
            lines += ["dropped %s / %s: %s" % (t, screen_name(n), r) for t, n, r in self.dropped]
            if self.redactions:
                lines.append("redacted: " + ", ".join("%s %d" % kv for kv in sorted(self.redactions.items())))
            if lines:
                with open(os.path.join(self.out, "NOTES.txt"), "w") as f:
                    f.write("\n".join(lines) + "\n")
        return kept


def collect(bundle, out_dir, max_bytes, tool):
    """Fill out_dir; returns the Collector (its notes say what happened)."""
    c = Collector(out_dir, max_bytes)
    if not os.path.isdir(bundle):
        c.notes.append("no result bundle at the given path: nothing to keep")
        return c, []
    try:
        r = run_tool(tool, ["get", "test-results", "summary", "--path", bundle, "--compact"])
        summary = json.loads(r.stdout.decode("utf-8")) if r.returncode == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        summary = None
    if not isinstance(summary, dict):
        c.notes.append("the result bundle has no readable test summary: nothing to keep")
        return c, []
    tests = failed_tests(summary)
    if not tests:
        c.notes.append("no failed test in the result bundle: nothing to keep")
        return c, []
    if len(tests) > MAX_TESTS:
        c.notes.append("%d failed tests; evidence kept for the first %d" % (len(tests), MAX_TESTS))
        tests = tests[:MAX_TESTS]
    work = tempfile.mkdtemp(prefix="ui-evidence-")
    try:
        for i, test in enumerate(tests):
            c.dirs[test] = "%02d-%s" % (i + 1, slug(test, 77))
            d = os.path.join(work, str(i))
            os.makedirs(d)
            try:
                r = run_tool(tool, ["export", "attachments", "--path", bundle, "--output-path", d, "--test-id", test])
                ok = r.returncode == 0
            except (OSError, subprocess.SubprocessError):
                ok = False
            entries = []
            if ok:
                try:
                    with open(os.path.join(d, "manifest.json")) as f:
                        for t in json.load(f):
                            entries += t.get("attachments") or []
                except (OSError, ValueError, AttributeError):
                    ok = False
            if not ok:
                c.notes.append("could not export the attachments of %s" % test)
            entries.sort(key=lambda a: a.get("timestamp") or 0)
            for n, a in enumerate(entries, 1):
                name = os.path.basename(str(a.get("exportedFileName") or ""))
                path = os.path.join(d, name)
                if not name or not os.path.isfile(path):
                    continue
                human = str(a.get("suggestedHumanReadableName") or name)
                ext = os.path.splitext(name)[1]
                if not human.endswith(ext):
                    human += ext
                # The test's own capture at the failure (UITestLaunch.swift, FailureEvidence)
                # is added beside the issue, so XCTest does not mark it as the failure's.
                failure = bool(a.get("isAssociatedWithFailure")) or human.startswith("failure-")
                with open(path, "rb") as f:
                    c.add_file(test, human, f.read(), failure, n)
            try:
                r = run_tool(tool, ["get", "test-results", "activities", "--path", bundle, "--test-id", test, "--compact"])
                doc = json.loads(r.stdout.decode("utf-8")) if r.returncode == 0 else None
            except (OSError, ValueError, subprocess.SubprocessError):
                doc = None
            if isinstance(doc, dict):
                c.add_text(test, "steps.txt", activities_text(doc), True)
            else:
                c.notes.append("no readable step log for %s" % test)
        failures = [
            "%s: %s" % (f.get("testIdentifierString") or "?", f.get("failureText") or "")
            for f in summary.get("testFailures") or []
        ]
        c.add_text("summary", "failures.txt", "\n".join(failures) + "\n", True)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return c, tests


def report(c, kept, tests):
    lines = ["### iOS UI failure evidence", ""]
    if kept:
        total = sum(it["size"] for it in kept)
        lines.append("Kept %d files (%d bytes) for %d failed tests, uploaded as an artifact." % (len(kept), total, len(tests)))
        lines += ["", "| test | file | bytes |", "|---|---|---|"]
        lines += ["| %s | %s | %d |" % (it["test"], it["path"], it["size"]) for it in kept[:40]]
        if len(kept) > 40:
            lines.append("| ... | %d more in manifest.json | |" % (len(kept) - 40))
    lines += [""] + ["- " + n for n in c.notes]
    reasons = {}
    for _, _, r in c.dropped:
        reasons[r] = reasons.get(r, 0) + 1
    lines += ["- dropped %d: %s" % (n, r) for r, n in sorted(reasons.items())]
    if c.redactions:
        lines.append("- redacted: " + ", ".join("%s %d" % kv for kv in sorted(c.redactions.items())))
    text = "\n".join(lines) + "\n"
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write(text)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write("kept=%d\n" % len(kept))


def main(argv):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--bundle", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--max-bytes", type=int, default=MAX_BYTES)
    p.add_argument("--tool", default="xcrun xcresulttool", help="the xcresulttool command (tests pass a fake)")
    a = p.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    c, tests, kept = Collector(a.out, a.max_bytes), [], []
    try:
        c, tests = collect(a.bundle, a.out, a.max_bytes, shlex.split(a.tool))
        kept = c.write()
    except Exception as e:  # never a second failure on a failed job
        c.notes.append("evidence extraction stopped: %s" % type(e).__name__)
    report(c, kept, tests)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
