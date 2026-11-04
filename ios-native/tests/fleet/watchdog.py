"""The fleet run's watchdog: remote-run.sh starts it in its own session, so it outlives the
run's process group (a stop from host_exec sends that group SIGTERM, then SIGKILL 3 s later,
which can end the run before its own trap cleans up).

    watchdog.py <run pid> <lock dir> [max seconds, default 3 hours]

Once the run's pid is gone it gives back a simulator lease the owner's queue lent the run
(<lock dir>/lease: "<pid>\\n<queue script>\\n<lane>"), shuts down the simulator the run started
(<lock dir>/started: "<pid> <udid>") and frees the lock if it is still the run's. Each file
counts only when it names the run's pid: a run that took the lock since wrote its own. When
the max time passes with the run still alive, it touches nothing: the run's own trap does it.
"""
import os
import subprocess
import sys
import time


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def gone(pid):
    """The run has ended: no such process, or one that died and waits to be reaped (a zombie
    still answers kill 0)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    st = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return st.stdout.strip().startswith("Z")


def main():
    pid, lock = int(sys.argv[1]), sys.argv[2]
    end = time.monotonic() + (float(sys.argv[3]) if len(sys.argv) > 3 else 3 * 3600)
    while not gone(pid):
        if time.monotonic() >= end:
            return
        time.sleep(2)
    lowner, lqueue, llane = (read(os.path.join(lock, "lease")).split("\n") + ["", "", ""])[:3]
    if lqueue and lowner == str(pid):
        subprocess.run(["/bin/bash", lqueue, "release", "--pid", str(pid)],
                       env=dict(os.environ, SIM_LANE=llane), capture_output=True, timeout=120)
    owner, udid = (read(os.path.join(lock, "started")).split() + ["", ""])[:2]
    if udid and owner == str(pid):
        subprocess.run(["/usr/bin/xcrun", "simctl", "shutdown", udid], capture_output=True, timeout=120)
    if read(os.path.join(lock, "pid")).strip() == str(pid):
        subprocess.run(["/bin/rm", "-rf", lock])


if __name__ == "__main__":
    try:
        os.setsid()
    except OSError:
        pass  # already a session leader
    main()
