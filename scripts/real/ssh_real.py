#!/usr/bin/env python3
"""
A host-judged session over a REAL ssh link made by Walnut's own ssh code, on one computer, with the
compiled walnut file on both sides and the real Claude Code CLI. Nothing of the computer's own Walnut
is reachable (scripts/real/iso_machine.py: two throwaway "machines" in Linux namespaces).

  leader machine  ~ = <base>/leader/home. The compiled walnut file runs `web` there as a real (not
                  ephemeral) server with its own data (~/.open-walnut), config: host_runs_sessions and
                  service_launcher on, the host offered the one service, and one ssh host `isohost`
                  (127.0.0.1:2222). Its loopback 2222 is relayed to the host machine's sshd.
  host machine    ~ = <base>/host/home. OpenSSH's own sshd (the system binary, a config and host key of
                  its own, non-root) on its loopback 2222; the Claude Code CLI in ~/.local/bin, talking
                  to this computer's AI proxy through a relay (its loopback 18402). A stand-in `crontab`
                  (the table is a file in ~) and a process named crond: it is a box whose cron daemon runs.
                  Everything Walnut puts there (the daemon, its launcher, the host's one Walnut service)
                  the leader installs over ssh, as on a real dev box.
  links           only unix sockets in <base>/sock, relayed by the machines' holders: the leader's
                  2222 -> host's sshd, both machines' 18402 -> the AI proxy, <base>/sock/leader-api.sock
                  -> the leader's port (this script's reads and calls).

Usage: ssh_real.py <base> setup|up|run|down|all   (all = setup, up, run, down; down always runs)
  WALNUT_FILE   the compiled walnut file for linux-x64 (default: <repo>/dist-bin/walnut-linux-x64)
  CLAUDE_BIN    the Claude Code CLI to put on the host (default: ~/.local/bin/claude, resolved)
  AI_PROXY      host:port of the AI proxy (default: from ANTHROPIC_BEDROCK_BASE_URL, else 127.0.0.1:8402)
  MODEL         the session's model (default global.anthropic.claude-haiku-5-5)

Every process it starts is inside one of the two machines (ended with the machine) or the AI relay
(its pid in <base>/pids). Evidence: <base>/evidence/ (steps.json, the logs, the API answers).
"""
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
ISO = os.path.join(HERE, 'iso_machine.py')
PY = sys.executable
USER = os.environ.get('USER') or subprocess.check_output(['id', '-un'], text=True).strip()
REAL_HOME = os.path.realpath(os.path.expanduser('~'))
HOST_KEY = 'isohost'
LEADER_PORT = 39456
MODEL = os.environ.get('MODEL', 'global.anthropic.claude-haiku-5-5')
AI_ENV = 'CLAUDE_CODE_USE_BEDROCK=1 CLAUDE_CODE_SKIP_BEDROCK_AUTH=1 ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:18402 AWS_REGION=us-west-2 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1'


def ai_proxy():
    v = os.environ.get('AI_PROXY')
    if v:
        return v
    u = urllib.parse.urlparse(os.environ.get('ANTHROPIC_BEDROCK_BASE_URL', ''))
    return f'{u.hostname}:{u.port}' if u.hostname and u.port else '127.0.0.1:8402'


class Run:
    def __init__(self, base):
        self.base = os.path.realpath(base)
        self.ev = os.path.join(self.base, 'evidence')
        self.steps = []
        self.t0 = time.time()

    def p(self, *parts):
        return os.path.join(self.base, *parts)

    # ── recording ──
    def note(self, step, **kw):
        rec = {'step': step, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'sinceStartS': round(time.time() - self.t0, 1), **kw}
        self.steps.append(rec)
        print(json.dumps(rec)[:2000], flush=True)
        with open(os.path.join(self.ev, 'steps.jsonl'), 'a') as f:
            f.write(json.dumps(rec) + '\n')

    # ── inside the machines ──
    def inside(self, side, cmd, timeout=120, check=True):
        env = ['/usr/bin/env', '-i', f'HOME={REAL_HOME}', f'USER={USER}', f'LOGNAME={USER}', 'SHELL=/bin/sh', 'LANG=C.UTF-8', 'TERM=dumb',
               f'PATH={REAL_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin']
        r = subprocess.run([PY, ISO, 'exec', self.p(side), '--', *env, '/bin/sh', '-c', cmd], capture_output=True, text=True, timeout=timeout)
        if check and r.returncode != 0:
            raise RuntimeError(f'{side}: {cmd!r} exited {r.returncode}: {r.stderr[-2000:]}')
        return r.stdout

    # ── the leader's API, through its relayed socket ──
    def api(self, method, path, body=None, timeout=60):
        class Conn(http.client.HTTPConnection):
            def connect(c):
                c.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                c.sock.settimeout(timeout)
                d = os.open(self.p('sock'), os.O_PATH | os.O_DIRECTORY)
                try: c.sock.connect(f'/proc/self/fd/{d}/leader-api.sock')
                finally: os.close(d)
        c = Conn('localhost', timeout=timeout)
        data = json.dumps(body).encode() if body is not None else None
        c.request(method, path, body=data, headers={'content-type': 'application/json', 'host': f'127.0.0.1:{LEADER_PORT}'})
        r = c.getresponse()
        raw = r.read().decode('utf-8', 'replace')
        try: js = json.loads(raw)
        except Exception: js = raw
        return r.status, js

    def leader_log(self):
        try: return open(self.p('leader', 'home', 'leader.log'), encoding='utf-8', errors='replace').read()
        except FileNotFoundError: return ''

    def wait(self, what, fn, timeout, every=1.0):
        t = time.time()
        while time.time() - t < timeout:
            try:
                v = fn()
            except Exception as e:
                v = None
                last = e
            if v:
                return v, round(time.time() - t, 1)
            time.sleep(every)
        raise TimeoutError(f'{what}: not within {timeout}s')


def setup(r: Run):
    walnut = os.environ.get('WALNUT_FILE') or os.path.join(REPO, 'dist-bin', 'walnut-linux-x64')
    claude = os.path.realpath(os.environ.get('CLAUDE_BIN') or os.path.join(REAL_HOME, '.local', 'bin', 'claude'))
    for side in ('leader', 'host'):
        if os.path.exists(r.p(side)):
            raise SystemExit(f'{r.p(side)} exists: use a fresh base (down + remove it first)')
    for d in ('sock', 'pids', 'evidence', 'host/home/.sshd', 'host/home/.ssh', 'host/home/.local/bin', 'host/home/work',
              'leader/home/.ssh', 'leader/home/bin', 'leader/home/.local/bin', 'leader/home/.open-walnut'):
        os.makedirs(r.p(d), exist_ok=True)
    for d in ('', 'sock', 'host', 'leader', 'host/home', 'leader/home', 'host/home/.ssh', 'leader/home/.ssh', 'host/home/.sshd'):
        os.chmod(r.p(d), 0o700)
    sh = lambda *a: subprocess.run(a, check=True, capture_output=True)
    sh('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', r.p('host/home/.sshd/host_ed25519'))
    sh('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'iso-leader', '-f', r.p('leader/home/.ssh/id_ed25519'))
    shutil.copy(r.p('leader/home/.ssh/id_ed25519.pub'), r.p('host/home/.ssh/authorized_keys'))
    H = REAL_HOME  # the path each machine's home shows at inside it
    open(r.p('host/home/.sshd/sshd_config'), 'w').write('\n'.join([
        'Port 2222', 'ListenAddress 127.0.0.1', f'HostKey {H}/.sshd/host_ed25519', f'PidFile {H}/.sshd/sshd.pid',
        f'AuthorizedKeysFile {H}/.ssh/authorized_keys', 'UsePrivilegeSeparation no', 'UsePAM no', 'StrictModes no',
        'PasswordAuthentication no', 'ChallengeResponseAuthentication no', 'KerberosAuthentication no', 'GSSAPIAuthentication no',
        'PubkeyAuthentication yes', 'AllowTcpForwarding yes', 'AllowStreamLocalForwarding yes', 'X11Forwarding no',
        'MaxSessions 64', 'MaxStartups 64:30:200', 'Subsystem sftp /usr/libexec/openssh/sftp-server', 'LogLevel VERBOSE', '']))
    pub = open(r.p('host/home/.sshd/host_ed25519.pub')).read().split()[:2]
    open(r.p('leader/home/.ssh/known_hosts'), 'w').write(f'[127.0.0.1]:2222 {pub[0]} {pub[1]}\n')
    stand_in_crontab = '\n'.join([
        '#!/bin/sh',
        '# Stand-in crontab of the isolated machine: the table is a file in this home; no cron of the computer is touched.',
        'f="$HOME/.crontab"',
        'case "$1" in',
        '  -l) [ -f "$f" ] && { cat "$f"; exit 0; }; echo "no crontab for $(id -un)" >&2; exit 1 ;;',
        '  -r) rm -f "$f"; exit 0 ;;',
        "  -|'') cat > \"$f.new\" && mv \"$f.new\" \"$f\"; exit 0 ;;",
        '  -*) echo "crontab stand-in: $1 not supported" >&2; exit 1 ;;',
        '  *) cat "$1" > "$f.new" && mv "$f.new" "$f"; exit 0 ;;',
        'esac', ''])
    for side in ('host', 'leader'):
        open(r.p(side, 'home/.local/bin/crontab'), 'w').write(stand_in_crontab)
        os.chmod(r.p(side, 'home/.local/bin/crontab'), 0o755)
        shutil.copy('/bin/sleep', r.p(side, 'home/.local/bin/crond'))
        lines = ['export PATH="$HOME/.local/bin:$PATH"'] + ([f'export {AI_ENV}'] if side == 'host' else [])
        for f in ('.zshenv', '.profile', '.bashrc'):
            open(r.p(side, 'home', f), 'w').write('\n'.join(lines) + '\n')
        open(r.p(side, 'home/.bash_profile'), 'w').write('[ -f ~/.profile ] && . ~/.profile\n')
    # The CLI in its versions dir and `claude` a wrapper that carries the sign-in (the AI proxy's env): the
    # host's one service starts with a clean env from its launcher, so the CLI's env comes from here.
    os.makedirs(r.p('host/home/.local/share/claude/versions'), exist_ok=True)
    shutil.copy(claude, r.p('host/home/.local/share/claude/versions', os.path.basename(claude)))
    open(r.p('host/home/.local/bin/claude'), 'w').write('\n'.join([
        '#!/bin/sh', '# The isolated host\'s Claude Code, signed in to the AI proxy through its relay.',
        f'export {AI_ENV}', f'exec "$HOME/.local/share/claude/versions/{os.path.basename(claude)}" "$@"', '']))
    os.chmod(r.p('host/home/.local/bin/claude'), 0o755)
    # Named walnut-<target>: a compiled leader sends the host the file beside it (host-file.ts siblings).
    shutil.copy(walnut, r.p('leader/home/bin/walnut-linux-x64'))
    open(r.p('leader/home/.open-walnut/config.yaml'), 'w').write('\n'.join([
        'experimental:', '  host_runs_sessions: true', '  service_launcher: true',
        'host_service_offer:', f'  - {HOST_KEY}',
        'hosts:', f'  {HOST_KEY}:', '    hostname: 127.0.0.1', f'    user: {USER}', '    port: 2222', '    label: Isolated ssh host',
        '    enabled: true', f'    shell_setup: export {AI_ENV}', '']))
    ver = lambda f: subprocess.run([f, '--version'], capture_output=True, text=True, timeout=60).stdout.strip()
    sha = lambda f: subprocess.check_output(['sha256sum', f], text=True).split()[0]
    r.note('setup', walnut={'path': walnut, 'version': ver(walnut), 'sha256': sha(walnut)},
           claude={'path': claude, 'version': ver(claude)}, sshd=subprocess.run(['/usr/sbin/sshd', '-V'], capture_output=True, text=True).stderr.strip()[:200]
           or subprocess.run(['ssh', '-V'], capture_output=True, text=True).stderr.strip())


def up(r: Run):
    relay = subprocess.Popen([PY, ISO, 'relay', f'{r.p("sock/ai.sock")}={ai_proxy()}'], stdin=subprocess.DEVNULL,
                             stdout=open(r.p('relay-ai.log'), 'a'), stderr=subprocess.STDOUT, start_new_session=True)
    open(r.p('pids/relay-ai.pid'), 'w').write(str(relay.pid))
    # The checkout's own top dir (and ISO_HIDE, ':'-separated) is empty inside both machines: they run copies.
    top = '/' + REPO.strip('/').split('/')[0]
    hide = [d for d in ([top] if top not in ('/home', REAL_HOME.rsplit('/', 2)[0]) else []) + [x for x in os.environ.get('ISO_HIDE', '').split(':') if x] if os.path.isdir(d)]
    hide_args = [a for d in hide for a in ('--hide', d)]
    out = subprocess.check_output([PY, ISO, 'start', r.p('host'), *hide_args, '--out', f'{r.p("sock/host-ssh.sock")}=2222', '--into', f'18402={r.p("sock/ai.sock")}',
                                   '--', '/bin/sh', '-c', f'exec /usr/sbin/sshd -D -e -f {REAL_HOME}/.sshd/sshd_config >> {REAL_HOME}/sshd.log 2>&1'],
                                  stdin=subprocess.DEVNULL, text=True)
    host = json.loads(out.strip().splitlines()[-1])
    out = subprocess.check_output([PY, ISO, 'start', r.p('leader'), *hide_args, '--into', f'2222={r.p("sock/host-ssh.sock")}', '--into', f'18402={r.p("sock/ai.sock")}',
                                   '--out', f'{r.p("sock/leader-api.sock")}={LEADER_PORT}', '--', '/bin/sleep', 'infinity'], stdin=subprocess.DEVNULL, text=True)
    leader = json.loads(out.strip().splitlines()[-1])
    for side in ('host', 'leader'):
        r.inside(side, 'setsid nohup crond infinity >/dev/null 2>&1 </dev/null &')
    r.inside('leader', f'cd ~; WALNUT_DISABLE_BACKGROUND_AI=1 setsid nohup ~/bin/walnut-linux-x64 web --port {LEADER_PORT} > ~/leader.log 2>&1 </dev/null &')
    _, s = r.wait('the leader answering', lambda: r.api('GET', '/api/health', timeout=5)[0] == 200, 120)
    r.note('up', hidden=hide, relayPid=relay.pid, hostHolder=host['holder'], leaderHolder=leader['holder'], leaderAnsweredS=s,
           hostProcesses=r.inside('host', 'ps -eo pid,args').strip().splitlines())


def host_service(r: Run):
    """What the leader knows of the host's one Walnut service (GET /api/host-servers)."""
    st, js = r.api('GET', '/api/host-servers')
    h = next((h for h in (js.get('hosts') or []) if h.get('hostKey') == HOST_KEY), None) if st == 200 else None
    rep = (((h or {}).get('view') or {}).get('daemon') or {}).get('report') or {}
    return {'phase': ((h or {}).get('view') or {}).get('phase'), 'program': rep.get('program'), 'pid': rep.get('pid'), 'build': f"{rep.get('version')}-{rep.get('commit')}",
            'capabilities': rep.get('capabilities') or [], 'sessionSide': (rep.get('sessionSide') or {}).get('state'), 'at': ((h or {}).get('view') or {}).get('lastReportAt')}


def judged_link_up(r: Run):
    """The host runs the one Walnut service, it judges sessions, and the leader hears it."""
    v = host_service(r)
    return v if 'session-judge-v1' in v['capabilities'] and v['sessionSide'] == 'judging' and v['phase'] == 'running' else None


def results_with(r: Run, sid, marker):
    """The assistant turns of the session that carry `marker` (each answered turn once)."""
    st, js = r.api('GET', f'/api/v1/sessions/{sid}/history')
    if st != 200:
        return []
    msgs = js.get('messages', js) if isinstance(js, dict) else js
    out = []
    for m in msgs if isinstance(msgs, list) else []:
        if m.get('role') == 'assistant' and marker in json.dumps(m.get('content', m.get('text', ''))):
            out.append(m)
    return out


def row(r: Run, sid):
    st, js = r.api('GET', f'/api/v1/sessions/{sid}')
    rec = js.get('session', js) if isinstance(js, dict) else {}
    return {k: rec.get(k) for k in ('id', 'claudeSessionId', 'judge', 'host', 'process_status', 'work_status', 'cwd', 'model', 'taskId')}


def parses(r: Run, sid):
    st, js = r.api('GET', f'/api/diagnostics/line-parses?session={sid}')
    return js


def host_log_file(r: Run):
    """The host's one Walnut service's own log (it judged the turns: its `turn` lines name the CLI's pid)."""
    import glob
    files = sorted(glob.glob(r.p('host/home/.open-walnut-host/walnuts/*/run/open-walnut-*.log')))
    return files[-1] if files else None


def host_claude(r: Run):
    return [l for l in r.inside('host', 'ps -eo pid,args').splitlines() if re.search(r'/claude/versions/|(^|/)claude( |$)', l.split(None, 1)[-1] if l.strip() else '')]


def ask(marker):
    return f'Reply with exactly {marker} and nothing else.'


def run(r: Run):
    st = {}
    # 0. The host is reached over ssh and runs the one Walnut service, and the leader linked its channel.
    def connected():
        return re.search(r'DaemonConnection: connected \{"host":"isohost"', r.leader_log())
    _, s = r.wait('the ssh host connected', connected, 600, 2)
    r.note('host connected over ssh', waitedS=s, lines=[l[:300] for l in r.leader_log().splitlines() if 'isohost' in l and re.search(r'ControlMaster|daemon dir chosen|deployed|daemon started|SSH tunnel created|connected \{', l)][:12])
    svc, s = r.wait('the host to run the one Walnut service, judging sessions', lambda: judged_link_up(r), 900, 3)
    r.note('host service judges', waitedS=s, service=svc, crontab=open(r.p('host/home/.crontab')).read() if os.path.exists(r.p('host/home/.crontab')) else None,
           hostProcesses=r.inside('host', 'ps -eo pid,ppid,args').strip().splitlines(),
           lines=[l[:400] for l in r.leader_log().splitlines() if 'isohost' in l and re.search(r'reboot|another mode|swap done|daemon started|deployed|daemon dir chosen|ControlMaster started', l, re.I)][-15:])
    # 1. Start.
    code, t = r.api('POST', '/api/tasks', {'title': 'Real ssh host-judged session', 'project': 'SshReal'})
    task_id = t['task']['id']
    t1 = time.time()
    code, started = r.api('POST', f'/api/v1/tasks/{task_id}/start', {'host': HOST_KEY, 'cwd': f'{REAL_HOME}/work', 'mode': 'bypass', 'model': MODEL, 'message': ask('PONG-1')}, timeout=180)
    if code >= 300:
        raise RuntimeError(f'start refused: {code} {started}')
    sid = started['sessionId']
    _, s = r.wait('PONG-1 answered', lambda: results_with(r, sid, 'PONG-1'), 300, 2)
    rw, lp = row(r, sid), parses(r, sid)
    ok = rw.get('judge') == 'host' and rw.get('host') == HOST_KEY and not (lp.get('lines') or 0)
    r.note('1 start', verdict='PASS' if ok else 'FAIL', taskId=task_id, sid=sid, startStatus=code, answeredS=round(time.time() - t1, 1), row=rw, leaderLineParses=lp, hostClaude=host_claude(r))
    st['start'] = ok
    # 2. Send.
    t2 = time.time()
    code, js = r.api('POST', f'/api/v1/sessions/{sid}/messages', {'text': ask('PONG-2')})
    _, s = r.wait('PONG-2 answered', lambda: results_with(r, sid, 'PONG-2'), 300, 2)
    rw, lp = row(r, sid), parses(r, sid)
    ok = code < 300 and rw.get('judge') == 'host' and not (lp.get('lines') or 0) and len(results_with(r, sid, 'PONG-2')) == 1
    r.note('2 send', verdict='PASS' if ok else 'FAIL', sendStatus=code, answeredS=round(time.time() - t2, 1), row=rw, leaderLineParses=lp)
    st['send'] = ok
    # 3. The ssh link drops (every relayed TCP connection between the leader and the host's sshd is cut,
    #    and new ones refused for 20 s), then comes back by itself.
    CONN = re.compile(r'DaemonConnection: (re)?connected \{"host":"isohost"')
    before = len(CONN.findall(r.leader_log()))
    t3 = time.time()
    pre = len(r.leader_log())
    cli_before = host_claude(r)
    subprocess.run([PY, ISO, 'drop', r.p('leader'), '20'], check=True)
    _, down_s = r.wait('the leader to see the link down', lambda: re.search(r'connection lost, scheduling reconnect \{"host":"isohost"', r.leader_log()[pre:]), 120, 0.5)
    _, s = r.wait('the link back', lambda: len(CONN.findall(r.leader_log())) > before, 300, 1)
    back_s = round(time.time() - t3, 1)
    svc, _ = r.wait('the host service heard again', lambda: (lambda v: v if v and (v.get('at') or 0) / 1000 > t3 + 20 else None)(judged_link_up(r)), 300, 2)
    code, js = r.api('POST', f'/api/v1/sessions/{sid}/messages', {'text': ask('PONG-3')})
    _, s3 = r.wait('PONG-3 answered', lambda: results_with(r, sid, 'PONG-3'), 300, 2)
    time.sleep(5)  # a second answer of the same turn would show here (a resend after the drop)
    n3 = len(results_with(r, sid, 'PONG-3'))
    rw, lp = row(r, sid), parses(r, sid)
    cli_after = host_claude(r)
    ok = code < 300 and n3 == 1 and rw.get('judge') == 'host' and not (lp.get('lines') or 0) and cli_before == cli_after
    r.note('3 drop and reconnect', sameCliProcess=cli_before == cli_after, verdict='PASS' if ok else 'FAIL', downSeenS=down_s, linkBackS=back_s, servicePidSame=svc.get('pid'), sendStatus=code, pong3Answers=n3, row=rw, leaderLineParses=lp,
           lines=[l[:400] for l in r.leader_log()[pre:].splitlines() if 'isohost' in l and re.search(r'connection lost|tunnel died|attempting reconnect|reconnected|ControlMaster|session channel|its lines went', l, re.I)][:20])
    st['drop'] = ok
    # 4. Stop.
    before_claude = host_claude(r)
    t4 = time.time()
    code, js = r.api('POST', f'/api/v1/sessions/{sid}/terminate', {}, timeout=120)
    _, s = r.wait('the CLI gone on the host', lambda: not host_claude(r), 120, 1)
    host_turns = [l[:300] for l in open(host_log_file(r)).read().splitlines() if sid in l and ('"message":"turn"' in l or 'session result received' in l)] if host_log_file(r) else []
    time.sleep(3)
    rw = row(r, sid)
    ok = code < 300 and not host_claude(r)
    r.note('4 stop', verdict='PASS' if ok else 'FAIL', status=code, answer=js, stoppedS=round(time.time() - t4, 1), claudeBefore=before_claude, claudeAfter=host_claude(r), row=rw, hostServiceTurns=host_turns)
    st['stop'] = ok
    hist = r.api('GET', f'/api/v1/sessions/{sid}/history')[1]
    json.dump(hist, open(os.path.join(r.ev, 'history.json'), 'w'), indent=1)
    json.dump({'row': row(r, sid), 'parses': parses(r, sid)}, open(os.path.join(r.ev, 'final-row.json'), 'w'), indent=1)
    return st


def down(r: Run):
    for side in ('leader', 'host'):
        if os.path.exists(r.p(side, 'holder.pid')):
            # Copy the logs out while the machines still run (they are plain files under <base> anyway).
            subprocess.run([PY, ISO, 'stop', r.p(side)], capture_output=True)
    rp = r.p('pids/relay-ai.pid')
    if os.path.exists(rp):
        pid = int(open(rp).read())
        try:
            if 'iso_machine.py' in open(f'/proc/{pid}/cmdline').read():
                os.kill(pid, 15)
        except FileNotFoundError:
            pass
    left = {}
    deadline = time.time() + 30
    while time.time() < deadline:
        left = {side: int(open(r.p(side, 'holder.pid')).read()) for side in ('leader', 'host') if os.path.exists(r.p(side, 'holder.pid'))}
        left = {k: v for k, v in left.items() if os.path.exists(f'/proc/{v}')}
        if not left:
            break
        time.sleep(1)
    for f, dst in ((r.p('leader/home/leader.log'), 'leader.log'), (r.p('host/home/sshd.log'), 'host-sshd.log'), (r.p('host/holder.log'), 'host-holder.log'), (r.p('leader/holder.log'), 'leader-holder.log')):
        if os.path.exists(f):
            shutil.copy(f, os.path.join(r.ev, dst))
    r.note('down', holdersStillAlive=left)


def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(2)
    r = Run(sys.argv[1])
    os.makedirs(r.ev, exist_ok=True) if os.path.isdir(r.base) else None
    op = sys.argv[2]
    if op == 'setup':
        os.makedirs(r.ev, exist_ok=True); setup(r)
    elif op == 'up':
        up(r)
    elif op == 'run':
        print(json.dumps(run(r)))
    elif op == 'down':
        down(r)
    elif op == 'all':
        os.makedirs(r.ev, exist_ok=True)
        setup(r)
        try:
            up(r)
            res = run(r)
            r.note('verdicts', **res)
        finally:
            down(r)
    else:
        print(__doc__); sys.exit(2)


if __name__ == '__main__':
    main()
