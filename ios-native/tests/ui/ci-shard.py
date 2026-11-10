"""Deal the WalnutUITests classes out to the CI's UI shards (.github/workflows/ci.yml, job ios).

One leg ran the whole UI layer until run 42735468568, where it reached 38 of its tests in its
50 minute step. Each shard is now its own macOS runner, and this script decides which classes
it runs, so a new test class lands on some shard with no list to edit:

  - every XCTestCase subclass in ios-native/WalnutUITests/*.swift that holds a test method,
    its own or inherited from a base class in the same directory (tests in an extension of
    the class count too), except the classes IOS_CI_SKIP_UI leaves out whole;
  - weighed by the seconds its tests took on CI (ci-shard-times.tsv: seconds per test of the
    class there, times its tests now), else DEFAULT_SECONDS_PER_TEST per test;
  - dealt heaviest first to the lightest shard (ties: by name, then the lowest shard), so the
    split is the same on every machine.

Usage (python3, stdlib only, the runner's or any Mac's):
  ci-shard.py <shard> <shards> [-skip-testing:WalnutUITests/<Class> ...]
      prints the shard's -only-testing:WalnutUITests/<Class> arguments, one per line, and exits
      1 (printing nothing) when the shard has no class, since no -only-testing would run all.
  ci-shard.py plan <shards> [-skip-testing:...]
      prints the whole split as JSON: each shard's classes and estimated seconds.
  ci-shard.py record <job log> [<job log> ...]
      updates ci-shard-times.tsv from the "Test Case ... (N seconds)" lines of CI job logs
      (gh api repos/<owner>/<repo>/actions/jobs/<id>/logs); classes not in a log keep theirs.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# The two overrides are for its own tests (tests/scripts/ci-ios.test.ts), never for CI.
UI_DIR = os.environ.get("CI_SHARD_UI_DIR") or os.path.normpath(os.path.join(HERE, "..", "..", "WalnutUITests"))
TIMES = os.environ.get("CI_SHARD_TIMES") or os.path.join(HERE, "ci-shard-times.tsv")
TARGET = "WalnutUITests"
# A class CI has not timed yet: about the mean of a test that runs on the offline pairing
# (36 such tests took 2,400 s in run 42735468568; one that skips takes about a second).
DEFAULT_SECONDS_PER_TEST = 60.0

# A declaration at the top level of a file (column 0): where one type's source ends and the
# next one's begins. Attributes may lead it on the same line.
TOP_DECL = re.compile(
    r"^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|internal|open|final|private|fileprivate)\s+)*"
    r"(class|extension|struct|enum|actor|protocol)\s+(\w+)(?:\s*:\s*([\w.]+))?",
    re.M,
)
# An XCTest test: an instance method named test..., taking nothing, not private (XCTest finds
# tests through the Objective-C runtime, which never sees a private Swift method).
TEST_METHOD = re.compile(
    r"^[ \t]+(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:override|internal|public|open|final|nonisolated)\s+)*"
    r"func\s+(test\w*)\s*\(\s*\)",
    re.M,
)


def strip_comments(text):
    """The source with its block comments blanked (line comments never match TEST_METHOD's ^)."""
    return re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)


def read_classes(ui_dir=UI_DIR):
    """{class: {"parent": str, "tests": set of its own test methods}} for every class in the dir."""
    classes = {}
    extra = {}
    for name in sorted(os.listdir(ui_dir)):
        if not name.endswith(".swift"):
            continue
        with open(os.path.join(ui_dir, name), encoding="utf-8") as f:
            text = strip_comments(f.read())
        decls = list(TOP_DECL.finditer(text))
        for i, d in enumerate(decls):
            body = text[d.end(): decls[i + 1].start() if i + 1 < len(decls) else len(text)]
            tests = set(TEST_METHOD.findall(body))
            kind, type_name, parent = d.group(1), d.group(2), d.group(3)
            if kind == "class":
                entry = classes.setdefault(type_name, {"parent": parent, "tests": set()})
                entry["tests"] |= tests
            elif kind == "extension":
                extra.setdefault(type_name, set()).update(tests)
    for type_name, tests in extra.items():
        if type_name in classes:
            classes[type_name]["tests"] |= tests
    return classes


def test_classes(ui_dir=UI_DIR):
    """{class: sorted test methods, inherited ones included} for every XCTestCase subclass with tests."""
    classes = read_classes(ui_dir)

    def chain(name):
        seen = []
        while name in classes and name not in seen:
            seen.append(name)
            name = classes[name]["parent"]
        return seen, name

    out = {}
    for name in classes:
        names, root = chain(name)
        if root != "XCTestCase":
            continue
        tests = set()
        for n in names:
            tests |= classes[n]["tests"]
        if tests:
            out[name] = sorted(tests)
    return out


def skipped_classes(args):
    """The classes a skip list leaves out whole; a method skip leaves its class on a shard."""
    out = set()
    for arg in args:
        m = re.match(r"^-skip-testing:%s/(\w+)(/\w+)?$" % TARGET, arg)
        if not m:
            raise SystemExit("not a %s skip: %s" % (TARGET, arg))
        if not m.group(2):
            out.add(m.group(1))
    return out


def read_times(path=TIMES):
    """{class: (seconds, tests timed)} from the times file."""
    times = {}
    if not os.path.exists(path):
        return times
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            cls, seconds, count = line.split("\t")
            times[cls] = (float(seconds), int(count))
    return times


def weight(cls, tests, times):
    if cls in times and times[cls][1] > 0:
        seconds, count = times[cls]
        return seconds / count * len(tests)
    return DEFAULT_SECONDS_PER_TEST * len(tests)


def plan(shards, skip_args, ui_dir=UI_DIR, times_path=TIMES):
    if shards < 1:
        raise SystemExit("shards must be 1 or more")
    skip = skipped_classes(skip_args)
    times = read_times(times_path)
    classes = {c: t for c, t in test_classes(ui_dir).items() if c not in skip}
    weighed = sorted(((weight(c, t, times), c) for c, t in classes.items()), key=lambda x: (-x[0], x[1]))
    legs = [{"shard": i + 1, "seconds": 0.0, "classes": []} for i in range(shards)]
    for w, c in weighed:
        leg = min(legs, key=lambda l: (l["seconds"], l["shard"]))
        leg["seconds"] += w
        leg["classes"].append(c)
    for leg in legs:
        leg["classes"].sort()
        leg["seconds"] = round(leg["seconds"], 1)
    return {"shards": shards, "skipped": sorted(skip), "legs": legs}


CASE = re.compile(r"Test Case '-\[%s\.(\w+) (\w+)\]' (?:passed|failed|skipped) \(([\d.]+) seconds\)" % TARGET)


def record(logs, times_path=TIMES):
    times = read_times(times_path)
    seen = {}
    for log in logs:
        with open(log, encoding="utf-8", errors="replace") as f:
            for line in f:
                m = CASE.search(line)
                if m:
                    seen[(m.group(1), m.group(2))] = float(m.group(3))
    fresh = {}
    for (cls, _), seconds in seen.items():
        total, count = fresh.get(cls, (0.0, 0))
        fresh[cls] = (total + seconds, count + 1)
    times.update(fresh)
    with open(times_path, "w", encoding="utf-8") as f:
        f.write("# Seconds the WalnutUITests classes took on CI, read by ci-shard.py to balance the UI shards.\n")
        f.write("# class<TAB>seconds of its timed tests<TAB>tests timed. Refresh: ci-shard.py record <job log>.\n")
        for cls in sorted(times):
            f.write("%s\t%.1f\t%d\n" % (cls, times[cls][0], times[cls][1]))
    print("recorded %d classes (%d tests) into %s" % (len(fresh), len(seen), times_path))


def main(argv):
    if len(argv) >= 2 and argv[0] == "record":
        record(argv[1:])
        return 0
    if len(argv) >= 2 and argv[0] == "plan":
        print(json.dumps(plan(int(argv[1]), argv[2:]), indent=2))
        return 0
    if len(argv) >= 2 and argv[0].isdigit() and argv[1].isdigit():
        shard, shards = int(argv[0]), int(argv[1])
        if not 1 <= shard <= shards:
            raise SystemExit("shard %d is not one of 1..%d" % (shard, shards))
        leg = plan(shards, argv[2:])["legs"][shard - 1]
        if not leg["classes"]:
            sys.stderr.write("shard %d of %d has no class\n" % (shard, shards))
            return 1
        for cls in leg["classes"]:
            print("-only-testing:%s/%s" % (TARGET, cls))
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
