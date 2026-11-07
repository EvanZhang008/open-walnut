"""Print the failed tests of an xcresult summary (xcresulttool get test-results summary --compact
on stdin), each as a line and as a GitHub annotation, so CI shows them with no log access.
The one argument names the leg in the annotation title (default: unit)."""
import json
import sys


def escape(text):
    # GitHub's workflow command encoding for a message
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def escape_property(text):
    # a property value (title=) also may not hold a bare ":" or ","
    return escape(text).replace(":", "%3A").replace(",", "%2C")


def main():
    leg = sys.argv[1] if len(sys.argv) > 1 else "unit"
    try:
        d = json.load(sys.stdin)
    except ValueError:
        # no result bundle (the leg stopped before its tests): one line, not a traceback
        print(f"no readable {leg} result bundle")
        return
    print(d.get("result"), d.get("totalTestCount"), "tests,", d.get("failedTests"), "failed")
    for f in d.get("testFailures", []):
        name = f.get("testIdentifierString") or f.get("testName") or "unknown test"
        text = f.get("failureText") or ""
        print(name, ":", text)
        print(f"::error title={escape_property('iOS ' + leg + ' ' + name)}::{escape(text[:1000])}")


if __name__ == "__main__":
    main()
