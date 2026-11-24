#!/usr/bin/env python3
"""
A throwaway "machine" on this computer for real-ssh checks: unprivileged Linux namespaces (user,
mount, pid, net) around a directory <root>, so a Walnut started inside sees none of this account's
real Walnut and cannot reach it.

  network   its own: only a loopback. Nothing listens on it but what runs inside. Relays named on
            the command line are the only ways in or out, each one a unix socket file outside:
              --into PORT=SOCK   inside, 127.0.0.1:PORT reaches the outside socket SOCK
                                 (SOCK is served outside, e.g. by `relay` below)
              --out SOCK=PORT    outside, the unix socket SOCK reaches 127.0.0.1:PORT inside
  files     the account's home dir (the real path, /home/<user> and its target) shows <root>/home;
            /tmp shows <root>/tmp; /run, /dev/shm, /var/tmp and every --hide DIR are empty; the rest of the
            file system is the computer's (read as usual). So the account's real Walnut dirs
            (~/.open-walnut, ~/.local/share/open-walnut, /tmp/open-walnut, the systemd user bus
            under /run/user) are not there at all.
  processes its own pid namespace: it sees only its own; the holder (this script) is its pid 1,
            reaps orphans, and ends everything inside when it gets SIGTERM.
  set-id    an unmapped root: set-uid programs (crontab, sudo) run as the account and change
            nothing of the computer.

Usage:
  iso_machine.py start <root> [--into P=SOCK]... [--out SOCK=P]... [--hide DIR]... -- <command> [args]
        Starts the holder in the background (its pid in <root>/holder.pid, log <root>/holder.log)
        and runs <command> inside as its first child. Returns once the namespaces are up.
  iso_machine.py exec <root> -- <command> [args]
        Runs a command inside the machine (setns into the holder's namespaces), waits, exits with its code.
  iso_machine.py relay SOCK=HOST:PORT
        Outside: serves the unix socket SOCK, each connection relayed to HOST:PORT (foreground).
  iso_machine.py drop <root> [seconds]
        Cuts every relayed connection of the machine now (a network drop), and refuses new ones
        for <seconds> (default 0).
  iso_machine.py stop <root>
        SIGTERM to the holder: everything inside ends, the holder exits.

Linux only, no root: needs unprivileged user namespaces (/proc/sys/user/max_user_namespaces > 0).
"""
import ctypes
import json
import os
import select
import signal
import socket
import sys
import threading
import time

CLONE_NEWNS = 0x00020000
CLONE_NEWUSER = 0x10000000
CLONE_NEWPID = 0x20000000
CLONE_NEWNET = 0x40000000
MS_RDONLY = 1
MS_NOSUID = 2
MS_NODEV = 4
MS_NOEXEC = 8
MS_BIND = 4096
MS_REC = 16384
MS_PRIVATE = 1 << 18

libc = ctypes.CDLL(None, use_errno=True)
libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]


def mount(src, target, fstype, flags, data=None):
    enc = lambda s: s.encode() if isinstance(s, str) else s
    if libc.mount(enc(src), enc(target), enc(fstype), flags, enc(data)) != 0:
        e = ctypes.get_errno()
        raise OSError(e, f'mount {src} -> {target} ({fstype}): {os.strerror(e)}')


_logs = {}


def log(root, msg):
    # The holder keeps its log open: inside the machine the root's own path is hidden.
    f = _logs.get(root)
    if f is None:
        f = _logs[root] = open(os.path.join(root, 'holder.log'), 'a', buffering=1)
    f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())}Z {msg}\n')


def loopback_up():
    import fcntl
    import struct
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    SIOCGIFFLAGS, SIOCSIFFLAGS = 0x8913, 0x8914
    ifr = struct.pack('16sH14s', b'lo', 0, b'\0' * 14)
    flags = struct.unpack('16sH14s', fcntl.ioctl(s, SIOCGIFFLAGS, ifr))[1]
    fcntl.ioctl(s, SIOCSIFFLAGS, struct.pack('16sH14s', b'lo', flags | 0x1 | 0x40, b'\0' * 14))
    s.close()


class Relays:
    """Every relayed connection of the machine, so a drop can cut them all."""

    def __init__(self, root):
        self.root = root
        self.lock = threading.Lock()
        self.conns = set()
        self.refuse_until = 0.0

    def pipe(self, a, b, label):
        with self.lock:
            if time.time() < self.refuse_until:
                a.close(); b.close()
                return
            self.conns.add(a); self.conns.add(b)

        def run():
            try:
                while True:
                    r, _, _ = select.select([a, b], [], [], 60)
                    if not r:
                        continue
                    for s in r:
                        data = s.recv(65536)
                        if not data:
                            raise EOFError
                        (b if s is a else a).sendall(data)
            except Exception:
                pass
            finally:
                for s in (a, b):
                    try: s.shutdown(socket.SHUT_RDWR)
                    except Exception: pass
                    try: s.close()
                    except Exception: pass
                with self.lock:
                    self.conns.discard(a); self.conns.discard(b)
        threading.Thread(target=run, daemon=True, name=label).start()

    def drop(self, seconds):
        with self.lock:
            self.refuse_until = time.time() + seconds
            conns = list(self.conns)
        for s in conns:
            try: s.shutdown(socket.SHUT_RDWR)
            except Exception: pass
        log(self.root, f'drop: cut {len(conns) // 2} relayed connection(s), refusing new ones for {seconds}s')


def serve(listener, connect, relays, label):
    def run():
        while True:
            try:
                c, _ = listener.accept()
            except Exception:
                return
            try:
                o = connect()
            except Exception as e:
                log(relays.root, f'{label}: connect failed: {e}')
                c.close()
                continue
            relays.pipe(c, o, label)
    threading.Thread(target=run, daemon=True, name=label).start()


def unix_listener(path):
    try: os.unlink(path)
    except FileNotFoundError: pass
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # Through a dir fd: a socket path holds at most 107 bytes, and task dirs are deep.
    d = os.open(os.path.dirname(path), os.O_PATH | os.O_DIRECTORY)
    s.bind(f'/proc/self/fd/{d}/{os.path.basename(path)}')
    os.close(d)
    os.chmod(path, 0o600)
    s.listen(64)
    return s


def parse_pairs(args):
    into, out, cmd, hide = [], [], [], []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--':
            cmd = args[i + 1:]
            break
        if a == '--hide':
            hide.append(os.path.realpath(args[i + 1]))
            i += 2
            continue
        if a in ('--into', '--out'):
            k, v = args[i + 1].split('=', 1)
            (into if a == '--into' else out).append((k, v))
            i += 2
            continue
        raise SystemExit(f'iso_machine: unknown argument {a}')
    if not cmd:
        raise SystemExit('iso_machine: no command after --')
    return into, out, cmd, hide


def start(root, args):
    root = os.path.realpath(root)
    into, out, cmd, hide = parse_pairs(args)
    for d in ('home', 'tmp', 'ctl'):
        os.makedirs(os.path.join(root, d), mode=0o700, exist_ok=True)
    os.chmod(os.path.join(root, 'tmp'), 0o1777)
    user_home = os.path.realpath(os.path.expanduser('~'))
    uid, gid = os.getuid(), os.getgid()
    # Outside sockets: the --out listeners are made now, the --into targets are reached through a dir fd
    # opened now (the path is hidden once the home is replaced).
    out_listeners = [(unix_listener(os.path.realpath(s)), int(p)) for s, p in out]
    into_targets = []
    for p, s in into:
        s = os.path.realpath(s)
        dfd = os.open(os.path.dirname(s), os.O_PATH | os.O_DIRECTORY)
        into_targets.append((int(p), dfd, os.path.basename(s)))
    ready_r, ready_w = os.pipe()
    pid = os.fork()
    if pid > 0:
        os.close(ready_w)
        msg = os.read(ready_r, 4096).decode()
        if not msg.startswith('ok'):
            sys.exit(f'iso_machine: the machine did not start: {msg or "holder exited"} (see {root}/holder.log)')
        print(json.dumps({'holder': int(msg.split()[1]), 'root': root}))
        return
    os.close(ready_r)
    os.setsid()
    # The holder and everything inside never keep the caller's stdio (a caller reading our stdout waits for EOF).
    devnull = os.open('/dev/null', os.O_RDWR)
    out = os.open(os.path.join(root, 'holder.log'), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    os.dup2(devnull, 0); os.dup2(out, 1); os.dup2(out, 2)
    os.close(devnull); os.close(out)
    try:
        log(root, 'holder: starting')
        ctl_fd = os.open(os.path.join(root, 'ctl'), os.O_PATH | os.O_DIRECTORY)
        os.unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWPID)
        with open('/proc/self/setgroups', 'w') as f: f.write('deny')
        with open('/proc/self/uid_map', 'w') as f: f.write(f'{uid} {uid} 1')
        with open('/proc/self/gid_map', 'w') as f: f.write(f'{gid} {gid} 1')
    except Exception as e:
        os.write(ready_w, f'setup failed: {e}'.encode()); os._exit(1)
    holder = os.fork()  # the first child is pid 1 of the new pid namespace
    if holder > 0:
        os._exit(0)
    try:
        # This holder's pid outside, read before /proc is the new namespace's.
        outer = [l.split()[1] for l in open('/proc/self/status') if l.startswith('NSpid:')][0]
        with open(os.path.join(root, 'holder.pid'), 'w') as f: f.write(outer)
        mount(None, '/', None, MS_REC | MS_PRIVATE)
        # By path (a mount of an fd from the old namespace is refused), the home last: it hides the root.
        mount(os.path.join(root, 'tmp'), '/tmp', None, MS_BIND)
        homes = {user_home, '/home/' + os.environ.get('USER', '')}
        for h in sorted(x for x in homes if os.path.isdir(x) and not os.path.islink(x)):
            mount(os.path.join(root, 'home'), h, None, MS_BIND)
        for d in ('/run', '/dev/shm', '/var/tmp', *hide):
            if os.path.isdir(d):
                mount('tmpfs', d, 'tmpfs', MS_NOSUID | MS_NODEV, 'mode=755')
        mount('proc', '/proc', 'proc', MS_NOSUID | MS_NODEV | MS_NOEXEC)
        loopback_up()
        # The first child before any relay thread (a fork of a threaded process may deadlock).
        first = os.fork()
        if first == 0:
            os.chdir(user_home)
            os.execvp(cmd[0], cmd)
        relays = Relays(root)
        for lst, port in out_listeners:
            serve(lst, lambda port=port: socket.create_connection(('127.0.0.1', port), timeout=10), relays, f'out:{port}')
        for port, dfd, name in into_targets:
            l = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            l.bind(('127.0.0.1', port)); l.listen(64)

            def conn(dfd=dfd, name=name):
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(f'/proc/self/fd/{dfd}/{name}')
                return s
            serve(l, conn, relays, f'into:{port}')
    except Exception as e:
        os.write(ready_w, f'setup failed: {e}'.encode()); os._exit(1)

    stopping = {'v': False}

    def on_term(*_):
        stopping['v'] = True
    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    def on_drop(*_):
        try: secs = float(open(f'/proc/self/fd/{ctl_fd}/drop-seconds').read().strip() or 0)
        except Exception: secs = 0.0
        relays.drop(secs)
    signal.signal(signal.SIGUSR1, on_drop)
    log(root, f'holder up: outside pid {outer}, first child {first} runs {cmd}')
    os.write(ready_w, f'ok {outer}'.encode())
    os.close(ready_w)
    # pid 1: reap everything; on SIGTERM end everything inside (kill -1 from pid 1 reaches all but itself).
    deadline = None
    while True:
        if stopping['v'] and deadline is None:
            log(root, 'holder: SIGTERM, ending every process inside')
            try: os.kill(-1, signal.SIGTERM)
            except ProcessLookupError: pass
            deadline = time.time() + 15
        if deadline is not None and time.time() > deadline:
            try: os.kill(-1, signal.SIGKILL)
            except ProcessLookupError: pass
        try:
            p, st = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            if stopping['v']:
                log(root, 'holder: nothing left inside, exiting')
                os._exit(0)
            p = 0
        if p == first:
            log(root, f'holder: first child exited status {st}')
        if p == 0:
            time.sleep(0.2)


def holder_pid(root):
    return int(open(os.path.join(os.path.realpath(root), 'holder.pid')).read().strip())


def exec_in(root, cmd):
    pid = holder_pid(root)
    fds = {t: os.open(f'/proc/{pid}/ns/{t}', os.O_RDONLY) for t in ('user', 'mnt', 'net', 'pid')}
    os.setns(fds['user'], CLONE_NEWUSER)
    os.setns(fds['mnt'], CLONE_NEWNS)
    os.setns(fds['net'], CLONE_NEWNET)
    os.setns(fds['pid'], CLONE_NEWPID)
    child = os.fork()
    if child == 0:
        try: os.chdir(os.path.realpath(os.path.expanduser('~')))
        except Exception: pass
        os.execvp(cmd[0], cmd)
    _, st = os.waitpid(child, 0)
    sys.exit(os.waitstatus_to_exitcode(st))


def relay(spec):
    sock, target = spec.split('=', 1)
    host, port = target.rsplit(':', 1)
    lst = unix_listener(os.path.realpath(sock))
    relays = Relays(os.path.dirname(os.path.realpath(sock)))
    serve(lst, lambda: socket.create_connection((host, int(port)), timeout=10), relays, f'relay:{port}')
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    # Short sleeps: a process signal may land on a relay thread, and only the main thread runs the handler.
    while True:
        time.sleep(1)


def main(argv):
    if len(argv) < 2:
        print(__doc__); sys.exit(2)
    op = argv[1]
    if op == 'start':
        start(argv[2], argv[3:])
    elif op == 'exec':
        if argv[3] != '--': raise SystemExit('iso_machine exec <root> -- <cmd>')
        exec_in(argv[2], argv[4:])
    elif op == 'relay':
        relay(argv[2])
    elif op == 'drop':
        root = os.path.realpath(argv[2])
        with open(os.path.join(root, 'ctl', 'drop-seconds'), 'w') as f: f.write(argv[3] if len(argv) > 3 else '0')
        os.kill(holder_pid(root), signal.SIGUSR1)
    elif op == 'stop':
        os.kill(holder_pid(argv[2]), signal.SIGTERM)
    else:
        print(__doc__); sys.exit(2)


if __name__ == '__main__':
    main(sys.argv)
