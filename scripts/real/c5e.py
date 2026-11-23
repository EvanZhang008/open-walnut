#!/usr/bin/env python3
"""
Real-machine acceptance of host-judged sessions (C5e), driven from the dev box that runs the leader.

  leader  this box, inside the dev container (scripts/real/leader-run.sh + leader-boot.mts),
          started with `walnut-dev run --bg`, its data under <base>/leader
  host    a real remote dev box (C5E_HOST), its own isolated one Walnut service from the same
          commit under <root> there (scripts/real/host-launcher.sh), the real `claude` CLI
  links   every one an ssh tunnel a person with an ssh route would open:
            link   ssh -L <docker bridge>:<fwd> -> host 127.0.0.1:<daemon door>   (the leader's daemon route)
            obs    ssh -L 127.0.0.1:<obs> -> host 127.0.0.1:<probe>                 (this script's reads only)
            door   ssh -R host 127.0.0.1:<door> -> the leader's exposed port        (the host dials /host-door)

Usage: c5e.py <command> [args]   (see COMMANDS at the end). The order of a run:
  snapshot before; stage; host-start; link-up; leader-start; obs-up; host-switch; link-follow;
  scenarios s1 s2 s3 s4 s5 s6; then terminate the sessions (POST /api/v1/sessions/<id>/terminate),
  stop the leader, host-stop, close the tunnels, remove <root> on the host, snapshot after.
Every process this script starts is
recorded (pid, start time, command line) under <base>/pids, and only those are ever signalled; on
the host, only processes whose environment carries this run's marker and whose cwd or command line
is under <root>.
"""
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def need(k: str) -> str:
    v = os.environ.get(k, '')
    if not v:
        sys.exit(f'c5e.py: set {k} (see the header of scripts/real/c5e.py)')
    return v


# The run's places (env): C5E_HOST the real host (an ssh destination this box reaches with a key),
# C5E_ROOT the isolated root there (an absolute real path, e.g. <its home>/c5e-real), C5E_TASK_DIR
# (default WALNUT_TASK_DIR) a directory of this box the dev container also mounts, for the leader's
# data and the evidence; for `stage`, C5E_CLI the host's Claude Code binary itself and, optionally,
# C5E_CLI_ENV_FROM the host account's CLI settings file whose `env` the sessions take (read only).
# Python 3.7 or newer (the host's system python3 is enough).
HOST = need('C5E_HOST')
HOST_KEY = os.environ.get('C5E_HOST_KEY', 'devbox')
ROOT = need('C5E_ROOT')                                                           # on the host
TASK_DIR = os.environ.get('C5E_TASK_DIR') or need('WALNUT_TASK_DIR')
BASE = Path(os.environ.get('C5E_BASE', f'{TASK_DIR}/c5e'))                       # on this box
EVIDENCE = Path(os.environ.get('C5E_EVIDENCE', f'{TASK_DIR}/evidence/real'))
WORKTREE = Path(os.environ.get('C5E_WORKTREE', str(Path(__file__).resolve().parents[2])))
PRODUCT_COMMIT = os.environ.get('C5E_COMMIT', 'HEAD')
WALNUT_DEV = os.environ.get('C5E_WALNUT_DEV', os.path.expanduser('~/walnut-dev/bin/walnut-dev'))
REMOTE_RSYNC = os.environ.get('C5E_REMOTE_RSYNC', 'rsync')                        # rsync's path on the host


def _bridge_ip() -> str:
    """docker0's address on this box: the leader's container reaches the link tunnel there."""
    try:
        return subprocess.run(['ip', '-4', '-o', 'addr', 'show', 'docker0'], capture_output=True, text=True).stdout.split()[3].split('/')[0]
    except Exception:  # noqa: BLE001
        return '172.17.0.1'


BRIDGE_IP = os.environ.get('C5E_BRIDGE_IP') or _bridge_ip()
FWD_PORT = 47913          # this box, docker bridge: the leader's link
OBS_PORT = 47914          # this box, loopback: the host probe
HOST_PROBE_PORT = 47911   # host loopback
DOOR_PORT = 47912         # host loopback: the leader's door through ssh -R
LEADER_PORT = 39456       # in the container
LEADER_PROBE_PORT = 39457
LEADER_NAME = 'c5e-leader'
SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
            '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3']
MASTER = ['-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/c5e-ssh-%C', '-o', 'ControlPersist=60m']


def now_iso() -> str:
    t = time.time()
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(t)) + f'.{int(t * 1000) % 1000:03d}Z'


def note(what: str, **data) -> None:
    """The run's timeline (evidence)."""
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    rec = {'at': now_iso(), 'ms': int(time.time() * 1000), 'what': what, **data}
    with open(EVIDENCE / 'timeline.jsonl', 'a') as f:
        f.write(json.dumps(rec) + '\n')
    print(f'[{rec["at"]}] {what} {json.dumps(data) if data else ""}', flush=True)


def run(cmd, check=True, timeout=600, cwd=None, input=None) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd, input=input)
    if check and p.returncode != 0:
        raise RuntimeError(f'{cmd[:6]} failed ({p.returncode}): {p.stderr.strip()[-2000:]} {p.stdout.strip()[-1000:]}')
    return p.stdout


def host(script: str, check=True, timeout=600) -> str:
    """A bash script on the host (over the shared master connection; never the Walnut link)."""
    return run(['ssh', *SSH_OPTS, *MASTER, HOST, 'bash -c ' + shlex.quote(script)], check=check, timeout=timeout)


def wd(*args, check=True, timeout=600) -> str:
    return run([WALNUT_DEV, *args], check=check, timeout=timeout, cwd=str(WORKTREE))


# ── processes this script starts on this box (pid files with start time and command line) ──

def pid_dir() -> Path:
    d = BASE / 'pids'
    d.mkdir(parents=True, exist_ok=True)
    return d


def proc_identity(pid: int):
    try:
        stat = Path(f'/proc/{pid}/stat').read_text()
        start = stat[stat.rindex(')') + 2:].split(' ')[19]
        cmd = Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\0', b' ').decode().strip()
        return {'start': start, 'cmd': cmd}
    except Exception:
        return None


def spawn_kept(name: str, cmd: list) -> int:
    log = open(BASE / 'pids' / f'{name}.log', 'a')
    p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    time.sleep(0.2)
    ident = proc_identity(p.pid)
    (pid_dir() / f'{name}.json').write_text(json.dumps({'pid': p.pid, **(ident or {}), 'argv': cmd, 'at': now_iso()}))
    return p.pid


def kept_alive(name: str):
    f = pid_dir() / f'{name}.json'
    if not f.exists():
        return None
    rec = json.loads(f.read_text())
    ident = proc_identity(rec['pid'])
    return rec if ident and ident['start'] == rec.get('start') and ident['cmd'] == rec.get('cmd') else None


def stop_kept(name: str) -> bool:
    rec = kept_alive(name)
    if rec:
        os.kill(rec['pid'], 15)
        for _ in range(50):
            if not kept_alive(name):
                break
            time.sleep(0.1)
    try:
        (pid_dir() / f'{name}.json').unlink()
    except FileNotFoundError:
        pass
    return bool(rec)


# ── stage: the product commit's tree and this run's scripts, here and on the host ──

def stage() -> None:
    commit = run(['git', '-C', str(WORKTREE), 'rev-parse', PRODUCT_COMMIT]).strip()
    code = BASE / 'code'
    run(['rm', '-rf', str(code)])
    code.mkdir(parents=True)
    arch = subprocess.Popen(['git', '-C', str(WORKTREE), 'archive', commit], stdout=subprocess.PIPE)
    subprocess.run(['tar', '-x', '-C', str(code)], stdin=arch.stdout, check=True)
    arch.wait()
    # This run's scripts as they are in the worktree (their own commit is recorded beside).
    run(['rm', '-rf', str(code / 'scripts' / 'real')])
    run(['cp', '-r', str(WORKTREE / 'scripts' / 'real'), str(code / 'scripts' / 'real')])
    os.symlink(str(WORKTREE / 'node_modules'), str(code / 'node_modules'))
    scripts_commit = run(['git', '-C', str(WORKTREE), 'log', '-1', '--format=%H', '--', 'scripts/real'], check=False).strip()
    dirty = run(['git', '-C', str(WORKTREE), 'status', '--porcelain', '--', 'scripts/real'], check=False).strip()
    (BASE / 'COMMIT.json').write_text(json.dumps({'product': commit, 'scripts': scripts_commit, 'scriptsDirty': bool(dirty), 'at': now_iso()}))
    note('stage: snapshot', product=commit, scripts=scripts_commit, scriptsDirty=bool(dirty))
    host(f'mkdir -p {ROOT}/code {ROOT}/bin {ROOT}/app/dist {ROOT}/logs && chmod 700 {ROOT}')
    rs = ['rsync', '-a', '--delete', '-e', ' '.join(['ssh', *SSH_OPTS, *MASTER]), '--rsync-path', REMOTE_RSYNC]
    run([*rs, '--exclude', '/node_modules', f'{code}/', f'{HOST}:{ROOT}/code/'], timeout=1800)
    run([*rs, '--exclude', '.cache', '--exclude', '/onnxruntime-node', '--exclude', '/@huggingface', '--exclude', '/playwright-core/.local-browsers',
         f'{WORKTREE}/node_modules/', f'{HOST}:{ROOT}/code/node_modules/'], timeout=3600)
    run([*rs, os.path.expanduser('~/.bun/bin/bun'), f'{HOST}:{ROOT}/bin/bun'])
    # The CLI binary itself (a launcher in front of it may look for it under the account's real HOME).
    cli = need('C5E_CLI')
    cli_env = os.environ.get('C5E_CLI_ENV_FROM') or host('printf %s "$HOME/.claude/settings.json"').strip()
    stubs = {
        'claude': f"#!/bin/sh\nC5E_CLI={shlex.quote(cli)} C5E_CLI_ENV_FROM={shlex.quote(cli_env)} exec /bin/bash {ROOT}/code/scripts/real/host-claude.sh \"$@\"\n",
        'crontab': '#!/bin/sh\necho "crontab is disabled for this isolated host" >&2\nexit 1\n',
        'systemctl': '#!/bin/sh\necho "systemctl is disabled for this isolated host" >&2\nexit 1\n',
        'ssh': '#!/bin/sh\necho "ssh is disabled for this isolated host" >&2\nexit 255\n',
    }
    for name, text in stubs.items():
        run(['ssh', *SSH_OPTS, *MASTER, HOST, f'cat > {ROOT}/bin/{name} && chmod 755 {ROOT}/bin/{name}'], input=text)
    app_cli = f"await import({json.dumps('file://' + ROOT + '/code/src/cli.ts')})\n"
    run(['ssh', *SSH_OPTS, *MASTER, HOST, f'cat > {ROOT}/app/dist/cli.js'], input=app_cli)
    run(['ssh', *SSH_OPTS, *MASTER, HOST, f'cat > {ROOT}/app/package.json'], input=json.dumps({'name': 'c5e-app', 'type': 'module', 'private': True}))
    host(f'ln -sf "$(command -v jq)" {ROOT}/bin/jq; chmod 755 {ROOT}/bin/bun; {ROOT}/bin/bun --version; {shlex.quote(cli)} --version')
    note('stage: host ready', root=ROOT, cli=cli)


# ── the host service ──

def host_start() -> None:
    # Its own connection, nothing of it left holding the session's pipes (setsid + every fd redirected).
    run(['ssh', *SSH_OPTS, '-n', HOST, f'rm -f {ROOT}/stop; mkdir -p {ROOT}/logs; setsid nohup bash {ROOT}/code/scripts/real/host-launcher.sh {ROOT} </dev/null >/dev/null 2>&1 &'], timeout=60)
    for _ in range(120):
        out = host(f'cat {ROOT}/daemon/daemon.port 2>/dev/null; true').strip()
        if out:
            break
        time.sleep(1)
    note('host: launcher started', launcher=host(f'cat {ROOT}/launcher.pid').strip(), daemonPort=out,
         entries=host(f'tail -3 {ROOT}/logs/entries.log').strip().split('\n'))


def host_entry_pid() -> int:
    """The entry the launcher runs now: the child of the launcher whose command line runs this root's code."""
    out = host(f'''L=$(cat {ROOT}/launcher.pid); for p in $(pgrep -P "$L"); do c=$(tr '\\0' ' ' < /proc/$p/cmdline); case "$c" in "{ROOT}/bin/bun tests/providers/fixtures/one-service-runner.ts --service"*) echo $p;; esac; done''').strip()
    return int(out.split()[0]) if out else 0


def host_switch() -> None:
    """As `walnut daemon update --serve <home>` switches a host: the mode file names the follower spec's home, the daemon ends, the launcher starts the service."""
    spec = None
    for _ in range(300):
        out = host(f'''for f in {ROOT}/state/host-server/server-*.json; do [ -f "$f" ] && cat "$f"; echo; done 2>/dev/null; true''')
        for line in out.splitlines():
            try:
                saved = json.loads(line)
            except Exception:
                continue
            if saved.get('spec', {}).get('home') and isinstance(saved.get('token'), str):
                spec = saved['spec']
        if spec:
            break
        time.sleep(2)
    if not spec:
        raise RuntimeError('no follower spec on the host')
    mode = json.dumps({'v': 1, 'home': spec['home'], 'exe': f'{ROOT}/bin/bun'})
    run(['ssh', *SSH_OPTS, *MASTER, HOST, f'umask 077; cat > {ROOT}/state/service-mode.json.tmp && mv {ROOT}/state/service-mode.json.tmp {ROOT}/state/service-mode.json'], input=mode)
    old = host_entry_pid()
    note('host: switching to the one service', home=spec['home'], daemonEntry=old)
    host(f'kill -TERM {old}')
    for _ in range(180):
        r = host_probe('/pid', quiet=True)
        if r and r.get('pid') and r['pid'] != old:
            note('host: service up', service=r)
            return
        time.sleep(2)
    raise RuntimeError('the host service did not come up')


def host_stop() -> None:
    host(f'touch {ROOT}/stop; L=$(cat {ROOT}/launcher.pid 2>/dev/null); [ -n "$L" ] && tr "\\0" " " < /proc/$L/cmdline 2>/dev/null | grep -q "{ROOT}/code/scripts/real/host-launcher.sh" && kill -TERM $L; true')
    for _ in range(60):
        left = host_ours()
        if not left:
            break
        time.sleep(1)
    left = host_ours()
    note('host: stopped', left=left)


def host_ours() -> list:
    """This run's processes on the host: the launcher and its entry by command line, every CLI by its marker and cwd."""
    out = host(f'''for p in $(ls /proc | grep -E '^[0-9]+$'); do
  [ -r /proc/$p/environ ] || continue
  [ "$p" = "$$" ] && continue
  if tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -q -E '^(C5E_REAL={ROOT}|C5E_REAL_SESSION=1)$' \\
     || tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q -F 'bash {ROOT}/code/scripts/real/host-launcher.sh'; then
    echo "$p $(LC_ALL=C ps -o lstart= -p $p) $(readlink /proc/$p/cwd) :: $(tr '\\0' ' ' < /proc/$p/cmdline | cut -c1-200)"
  fi
done; true''')
    return [l for l in out.strip().split('\n') if l.strip()]


# ── tunnels ──

def tunnel_up(name: str, spec: list) -> int:
    stop_kept(name)
    pid = spawn_kept(name, ['ssh', *SSH_OPTS, '-o', 'ExitOnForwardFailure=yes', '-N', *spec, HOST])
    time.sleep(1.5)
    if not kept_alive(name):
        raise RuntimeError(f'tunnel {name} did not stay up: {(BASE / "pids" / f"{name}.log").read_text()[-500:]}')
    note(f'tunnel {name} up', pid=pid, spec=spec)
    return pid


def link_up() -> None:
    port = host(f'cat {ROOT}/daemon/daemon.port').strip()
    tunnel_up('link', ['-L', f'{BRIDGE_IP}:{FWD_PORT}:127.0.0.1:{port}'])
    (BASE / 'link.port').write_text(port)


def link_follow(timeout=240) -> None:
    """The daemon door moves at each entry start: the link follows it (as an ssh dial asks where it is)."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        port = host(f'cat {ROOT}/daemon/daemon.port 2>/dev/null; true').strip()
        kept = (BASE / 'link.port').read_text().strip() if (BASE / 'link.port').exists() else ''
        if port and (port != kept or not kept_alive('link')):
            link_up()
            return
        if port and port == kept and kept_alive('link'):
            return
        time.sleep(1)
    raise RuntimeError('no daemon door to follow')


def link_down() -> None:
    was = stop_kept('link')
    note('tunnel link down (the leader\'s ssh/daemon route cut)', wasUp=was)


def obs_up() -> None:
    tunnel_up('obs', ['-L', f'127.0.0.1:{OBS_PORT}:127.0.0.1:{HOST_PROBE_PORT}'])


def door_up() -> None:
    url = leader_url(LEADER_PORT)
    hostport = url.split('//')[1].rstrip('/')
    tunnel_up('door', ['-R', f'127.0.0.1:{DOOR_PORT}:{hostport}'])


# ── the leader ──

def leader_config() -> str:
    """The leader's config.yaml on its first boot: the host (a name no resolver knows: the link is the
    tunnel, never ssh), its follower (server_program: replica), and the switch on (host-judge-cluster.ts)."""
    return '\n'.join([
        'version: 1', 'user:', '  name: Tester', 'defaults:', '  priority: none', '  platform: local', 'provider:', '  type: claude-code',
        'hosts:', f'  {HOST_KEY}:', f'    hostname: {HOST_KEY}.invalid', f'    label: {HOST_KEY}', '    server_program: replica', '    server:', '      enabled: true',
        'experimental:', '  host_runs_sessions: true', '',
    ])


def leader_start() -> None:
    (BASE / 'leader' / 'data').mkdir(parents=True, exist_ok=True)
    cfg = BASE / 'leader' / 'data' / 'config.yaml'
    if not cfg.exists():
        cfg.write_text(leader_config())
    envs = {
        'C5E_HOST_KEY': HOST_KEY, 'C5E_LINK_URL': f'ws://{BRIDGE_IP}:{FWD_PORT}', 'C5E_HOST_BUN': f'{ROOT}/bin/bun',
        'C5E_HOST_ROOT': f'{ROOT}/hr', 'C5E_HOST_APP': f'{ROOT}/app', 'C5E_LEADER_PORT': str(LEADER_PORT), 'C5E_LEADER_PROBE_PORT': str(LEADER_PROBE_PORT),
    }
    args = ['run', '--bg', LEADER_NAME, '-e', 'CI=']
    for k, v in envs.items():
        args += ['-e', f'{k}={v}']
    args += ['bash', str(BASE / 'code' / 'scripts' / 'real' / 'leader-run.sh'), str(BASE / 'leader')]
    note('leader: starting', out=wd(*args).strip()[-500:])
    for _ in range(240):
        if leader_probe('/pid', quiet=True):
            break
        time.sleep(1)
    note('leader: up', probe=leader_probe('/pid'), runs=(BASE / 'leader' / 'runs.log').read_text().strip().split('\n')[-2:])


def leader_url(port: int) -> str:
    f = BASE / f'expose-{port}.txt'
    if f.exists():
        return f.read_text().strip()
    out = wd('expose', LEADER_NAME, str(port)).strip()
    url = [w for w in out.split() if w.startswith('http://')][-1]
    f.write_text(url)
    return url


def http_json(url: str, method='GET', body=None, timeout=60, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={'content-type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'null')
        except Exception:
            return e.code, None


def leader_probe(p: str, quiet=False):
    try:
        st, js = http_json(leader_url(LEADER_PROBE_PORT) + p, timeout=20)
        if st != 200:
            raise RuntimeError(f'leader probe {p}: {st} {js}')
        return js
    except Exception:
        if quiet:
            return None
        raise


def leader_api(method: str, p: str, body=None, timeout=60):
    """The leader's API as the person at it: from inside its container, on its loopback."""
    args = ['exec', LEADER_NAME, 'curl', '-sS', '-m', str(timeout), '-X', method, '-H', 'content-type: application/json',
            '-w', '\\n%{http_code}', f'http://127.0.0.1:{LEADER_PORT}{p}']
    if body is not None:
        args[-1:-1] = ['--data-binary', json.dumps(body)]
    out = wd(*args, timeout=timeout + 30).rstrip('\n')
    text, _, code = out.rpartition('\n')
    try:
        js = json.loads(text) if text else None
    except Exception:
        js = {'text': text[-500:]}
    return int(code), js


def leader_pids() -> dict:
    """The leader server (its loop's pid file) and its own local daemon, in the container's pid space."""
    server = int((BASE / 'leader' / 'leader.pid').read_text().strip())
    daemon = wd('exec', LEADER_NAME, 'cat', '/tmp/c5e-leader/md/daemon.pid', check=False).strip().split()
    return {'server': server, 'daemon': int(daemon[0]) if daemon else 0}


def leader_signal(sig: str, which=('server', 'daemon')) -> dict:
    pids = leader_pids()
    out = {}
    for k in which:
        pid = pids.get(k)
        if not pid:
            continue
        cmd = wd('exec', LEADER_NAME, 'cat', f'/proc/{pid}/cmdline', check=False).replace('\0', ' ')
        ok = ('leader-boot.mts' in cmd) if k == 'server' else ('--start' in cmd or 'daemon' in cmd)
        if not ok:
            raise RuntimeError(f'refusing {sig}: {k} pid {pid} runs {cmd[:200]!r}')
        t0 = int(time.time() * 1000)
        wd('exec', LEADER_NAME, 'kill', f'-{sig}', str(pid))
        out[k] = {'pid': pid, 'cmd': cmd[:160], 'sentAt': t0}
    note(f'leader: {sig}', **out)
    return out


def host_probe(p: str, quiet=False):
    try:
        st, js = http_json(f'http://127.0.0.1:{OBS_PORT}{p}', timeout=30)
        if st != 200:
            raise RuntimeError(f'host probe {p}: {st} {js}')
        return js
    except Exception:
        if quiet:
            return None
        raise


# ── reads for the scenarios ──

def wait_for(fn, timeout: float, what: str, every=1.0):
    t0 = time.time()
    last = None
    while True:
        try:
            v = fn()
            if v:
                return v
        except Exception as e:  # noqa: BLE001
            last = e
        if time.time() - t0 > timeout:
            raise RuntimeError(f'timed out after {timeout}s waiting for {what}' + (f' ({last})' if last else ''))
        time.sleep(every)


def leader_events(sid: str) -> list:
    """Every bus event of `sid` the leader recorded, across its restarts (events.jsonl)."""
    out = []
    f = BASE / 'leader' / 'events.jsonl'
    if not f.exists():
        return out
    with open(f) as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get('sid') == sid:
                out.append(r)
    return out


def host_facts(sid: str) -> list:
    return host_probe(f'/facts?after=0&sid={sid}')['recs']


def is_fact(name: str, cls) -> bool:
    return cls == 'fact' and name != 'session:started'


def compare_facts(sid: str) -> dict:
    """The host's facts of `sid` (log order) against the leader's host-channel facts of it (emit order): each once and in order."""
    recs = [r for r in host_facts(sid) if is_fact(r['name'], r.get('cls'))]
    evs = [e for e in leader_events(sid) if e.get('source') == 'host-channel' and is_fact(e['name'], e.get('cls'))]
    hid = [f"{r['name']}:{'cut' if r.get('refs') else r['h'][:12]}" for r in recs]
    lid = [f"{e['name']}:{'cut' if (i < len(recs) and recs[i].get('refs')) else e['hash'][:12]}" for i, e in enumerate(evs)]
    started = [e for e in leader_events(sid) if e['name'] == 'session:started']
    # Two facts with the same name and data (two equal usage updates) are not a doubling: count both ends.
    same = {'host': len(hid) - len(set(hid)), 'leader': len(lid) - len(set(lid))}
    missing = [x for x in hid if x not in set(lid)]
    extra = [x for x in lid if x not in set(hid)]
    return {'hostFacts': len(hid), 'leaderFacts': len(lid), 'equalInOrder': hid == lid, 'missing': missing, 'extra': extra,
            'identicalPairs': same, 'doubled': max(0, len(lid) - len(hid)), 'sessionStarted': [{'source': e['source'], 'pid': e.get('pid')} for e in started],
            'results': {'host': sum(1 for r in recs if r['name'] == 'session:result'), 'leader': sum(1 for e in evs if e['name'] == 'session:result')}}


def result_with(events: list, text: str):
    for e in events:
        if e['name'] == 'session:result' and text in json.dumps(e.get('data', {}).get('result', '')):
            return e
    return None


def host_events(sid: str) -> list:
    return host_probe(f'/events?sid={sid}')


def clock_offset(samples=40) -> dict:
    """The host's clock minus this box's, NTP style, over one held ssh session (a remote loop that
    answers each line with its clock at once, so a shell's start-up is not inside the round trip):
    the sample with the smallest round trip wins, its error at most half that round trip."""
    p = subprocess.Popen(['ssh', *SSH_OPTS, HOST, 'python3 -u -c ' + shlex.quote('import sys,time\nfor _ in sys.stdin: print(time.time_ns(), flush=True)')],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    best = None
    try:
        for _ in range(samples):
            t0 = time.time_ns()
            p.stdin.write('\n')
            p.stdin.flush()
            remote = int(p.stdout.readline().strip())
            t1 = time.time_ns()
            rtt = (t1 - t0) / 1e6
            off = (remote - (t0 + t1) / 2) / 1e6
            if best is None or rtt < best['rttMs']:
                best = {'offsetMs': round(off, 3), 'rttMs': round(rtt, 3)}
            time.sleep(0.05)
    finally:
        p.stdin.close()
        p.wait(timeout=10)
    return best


def save(name: str, data) -> None:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / name).write_text(json.dumps(data, indent=2, default=str))


def snapshot(label: str) -> None:
    here = Path(__file__).resolve().parent
    out = run(['bash', str(here / 'snapshot-host.sh'), str(EVIDENCE / f'host-procs-{label}.txt')])
    (EVIDENCE / f'host-procs-{label}.time').write_text(now_iso() + '\n')
    print(out.strip())


COMMANDS = {
    'stage': stage, 'host-start': host_start, 'host-switch': host_switch, 'host-stop': host_stop,
    'link-up': link_up, 'link-follow': link_follow, 'link-down': link_down, 'obs-up': obs_up, 'door-up': door_up,
    'door-down': lambda: stop_kept('door'), 'obs-down': lambda: stop_kept('obs'),
    'leader-start': leader_start, 'leader-stop': lambda: wd('stop', LEADER_NAME, check=False),
    'host-ours': lambda: print('\n'.join(host_ours())), 'clock': lambda: print(clock_offset()),
}

if __name__ == '__main__':
    BASE.mkdir(parents=True, exist_ok=True)
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'snapshot':
        snapshot(sys.argv[2])
    elif cmd in COMMANDS:
        r = COMMANDS[cmd]()
        if r is not None:
            print(r)
    elif cmd == 'scenarios':
        import c5e_scenarios  # noqa: F401  (scripts/real/c5e_scenarios.py)
        c5e_scenarios.main(sys.argv[2:])
    else:
        print(__doc__)
        print('commands:', ' '.join([*COMMANDS, 'snapshot <label>', 'scenarios [names]']))
        sys.exit(2)
