"""
The C5e scenarios (design/C5e-plan.md), run by `c5e.py scenarios [s1 s2 ...]` once the host's
service and the leader are up and linked (c5e.py host-start, link-up, leader-start, host-switch,
link-follow, obs-up). Each writes evidence/real/<name>.json with its numbers and verdict; the
session id and task id carry over in evidence/real/state.json.

Prompts are short and ask the real CLI for one marker each (PONG-<n>), a long turn sleeping in a
shell command first so the leader can be stopped or restarted in the middle of it.
"""
import json
import os
import statistics
import time

import c5e as x

STATE = x.EVIDENCE / 'state.json'


def state() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def keep(**kv) -> None:
    s = state()
    s.update(kv)
    STATE.write_text(json.dumps(s, indent=2))


def mark(n: str) -> str:
    """A marker no earlier turn of this run used (PONG-<n>-<nonce>)."""
    return f'PONG-{n}-{os.urandom(2).hex()}'


def ask(m: str) -> str:
    return f'Reply with exactly {m} followed by the output of the shell command `date +%s`, nothing else.'


def ask_long(m: str, secs: int) -> str:
    return f'Run the shell command `sleep {secs}; date +%s` in the foreground (do not run it in the background) and then reply with exactly {m} followed by its output, nothing else.'


def settle(timeout=120) -> dict:
    """The host's log still for 3 s and the leader's cursor at its head."""
    last, since = -1, 0.0
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = x.host_probe('/facts?after=0&sid=none')['head']
        cur = (x.leader_probe(f'/cursor?host={x.HOST_KEY}', quiet=True) or {}).get('cursor') or {}
        if h != last:
            last, since = h, time.time()
        elif time.time() - since >= 3 and (cur.get('seq') or 0) >= h:
            return {'head': h, 'cursor': cur}
        time.sleep(0.5)
    raise RuntimeError('the host log did not settle with the leader at its head')


def channel_result(sid: str, marker: str):
    return x.result_with([e for e in x.leader_events(sid) if e.get('source') == 'host-channel'], marker)


def results_on_leader(sid: str, marker: str) -> list:
    return [e for e in x.leader_events(sid) if e['name'] == 'session:result' and marker in json.dumps(e.get('data', {}).get('result', ''))]


def host_has(sid: str, marker: str, names=('session:result',)):
    return next((e for e in x.host_events(sid) if e['name'] in names and marker in json.dumps(e.get('data', {}))), None)


def send(sid: str, text: str) -> dict:
    st, js = x.leader_api('POST', f'/api/v1/sessions/{sid}/messages', {'text': text})
    x.note('send', sid=sid, status=st, reply=js, text=text)
    if st >= 300:
        raise RuntimeError(f'send refused: {st} {js}')
    return js


def turn_started_on_host(sid: str, after_seq: int):
    """The long turn's shell command is running on the host (its tool-use fact is in the log)."""
    recs = [r for r in x.host_facts(sid) if r['seq'] > after_seq]
    return next((r for r in recs if r['name'] == 'session:tool-use'), None)


def head() -> int:
    return x.host_probe('/facts?after=0&sid=none')['head']


def verdict(ok: bool) -> str:
    return 'PASS' if ok else 'FAIL'


def s1() -> dict:
    m1 = mark('1')
    side = x.wait_for(lambda: (lambda s: s if s and s['active'] and s['linked'] and s['judges'] else None)(x.leader_probe(f'/side?host={x.HOST_KEY}', quiet=True)), 300, 'the leader to link the host\'s session channel')
    st, t = x.leader_api('POST', '/api/tasks', {'title': 'C5e real host-judged run', 'project': 'C5e'})
    assert st == 201, (st, t)
    task_id = t['task']['id']
    t0 = int(time.time() * 1000)
    st, started = x.leader_api('POST', f'/api/v1/tasks/{task_id}/start', {'host': x.HOST_KEY, 'cwd': f'{x.ROOT}/work', 'mode': 'bypass', 'message': ask(m1)}, timeout=120)
    x.note('s1: start', status=st, reply=started)
    assert st == 202, (st, started)
    sid = started['sessionId']
    keep(taskId=task_id, sid=sid)
    res = x.wait_for(lambda: channel_result(sid, m1), 300, 'PONG-1 on the leader')
    procs = x.host_ours()
    st, row = x.leader_api('GET', f'/api/sessions/{sid}')
    rec = (row or {}).get('session', row) or {}
    parses = x.leader_probe(f'/parses?sid={sid}')['parses']
    judge = x.leader_probe(f'/judge?sid={sid}')
    host_row = x.host_probe(f'/row?sid={sid}')['row'] or {}
    cmp_ = x.compare_facts(sid)
    out = {
        'side': side, 'taskId': task_id, 'sid': sid, 'startAskedAt': t0, 'resultSeenAt': res['seenAt'], 'result': res.get('data', {}).get('result'),
        'leaderRow': {k: rec.get(k) for k in ('claudeSessionId', 'judge', 'host', 'taskId', 'process_status', 'cwd')},
        'hostRow': {k: host_row.get(k) for k in ('claudeSessionId', 'judge', 'host', 'process_status', 'cwd')},
        'leaderParses': parses, 'judgeOf': judge, 'facts': cmp_, 'hostProcesses': procs,
    }
    ok = side['judges'] and side['kind'] == 'leader-dialed' and parses == 0 and rec.get('judge') == 'host' and rec.get('host') == x.HOST_KEY \
        and judge == {'judge': 'host', 'host': x.HOST_KEY} and cmp_['equalInOrder'] and len(cmp_['sessionStarted']) == 1 \
        and any(f'{x.ROOT}/work' in p for p in procs)
    out['verdict'] = verdict(ok)
    return out


def s2() -> dict:
    m2 = mark('2')
    sid = state()['sid']
    offset = x.clock_offset()
    before = x.host_probe(f'/facts?after=0&sid={sid}')['head']
    send(sid, ask(m2))
    x.wait_for(lambda: channel_result(sid, m2), 300, 'PONG-2 on the leader')
    settled = settle()
    cmp_ = x.compare_facts(sid)
    recs = [r for r in x.host_facts(sid) if x.is_fact(r['name'], r.get('cls'))]
    evs = [e for e in x.leader_events(sid) if e.get('source') == 'host-channel' and x.is_fact(e['name'], e.get('cls'))]
    pairs = []
    if cmp_['equalInOrder']:
        for r, e in zip(recs, evs):
            if r['seq'] > before:
                pairs.append({'seq': r['seq'], 'name': r['name'], 'hostAt': r['at'], 'leaderSeenAt': e['seenAt'],
                              'ms': round(e['seenAt'] - (r['at'] - offset['offsetMs']), 1)})
    ms = [p['ms'] for p in pairs]
    out = {'sid': sid, 'marker': m2, 'settled': settled, 'clock': offset, 'facts': cmp_, 'turnFacts': len(pairs), 'latency': pairs,
           'summary': {'n': len(ms), 'p50': statistics.median(ms) if ms else None, 'max': max(ms) if ms else None, 'min': min(ms) if ms else None},
           'leaderParses': x.leader_probe(f'/parses?sid={sid}')['parses']}
    ok = cmp_['equalInOrder'] and len(pairs) > 2 and max(ms) < 1000 and out['leaderParses'] == 0
    out['verdict'] = verdict(ok)
    return out


def s3(hold_s: int = 45) -> dict:
    m3 = mark('3')
    sid = state()['sid']
    before = x.host_probe(f'/facts?after=0&sid={sid}')['head']
    send(sid, ask_long(m3, 25))
    tool = x.wait_for(lambda: turn_started_on_host(sid, before), 180, 'the long turn to run on the host')
    cursor_before = x.leader_probe(f'/cursor?host={x.HOST_KEY}')
    stopped = x.leader_signal('STOP')
    t_stop = time.time()
    host_result = None
    while time.time() - t_stop < hold_s:
        host_result = host_result or host_has(sid, m3)
        time.sleep(2)
    host_result = host_result or host_has(sid, m3)
    held_ms = int((time.time() - t_stop) * 1000)
    resumed = x.leader_signal('CONT')
    seen = x.wait_for(lambda: channel_result(sid, m3), 180, 'PONG-3 on the leader after SIGCONT')
    settle()
    cmp_ = x.compare_facts(sid)
    once = results_on_leader(sid, m3)
    out = {'sid': sid, 'toolUseOnHostAt': tool['at'], 'stopped': stopped, 'heldMs': held_ms, 'resumed': resumed,
           'hostResultAt': host_result and host_result['at'], 'hostResultDuringStop': bool(host_result and host_result['at'] / 1000 < t_stop + held_ms / 1000),
           'leaderResultSeenAt': seen['seenAt'], 'leaderResultLate': seen.get('late'), 'msFromContToLeaderResult': seen['seenAt'] - resumed['server']['sentAt'],
           'cursorBefore': cursor_before, 'cursorAfter': x.leader_probe(f'/cursor?host={x.HOST_KEY}'),
           'resultsOnLeader': [{'source': e['source'], 'pid': e['pid'], 'seenAt': e['seenAt']} for e in once], 'facts': cmp_,
           'leaderParses': x.leader_probe(f'/parses?sid={sid}')['parses']}
    ok = 30_000 <= held_ms <= 60_000 + 5_000 and out['hostResultDuringStop'] and len(once) == 1 and cmp_['equalInOrder'] \
        and cmp_['doubled'] == 0 and out['leaderParses'] == 0
    out['verdict'] = verdict(ok)
    return out


def s4() -> dict:
    m4 = mark('4')
    sid = state()['sid']
    before = x.host_probe(f'/facts?after=0&sid={sid}')['head']
    old_pid = x.leader_probe('/pid')['pid']
    send(sid, ask_long(m4, 25))
    tool = x.wait_for(lambda: turn_started_on_host(sid, before), 180, 'the long turn to run on the host')
    cursor_before = x.leader_probe(f'/cursor?host={x.HOST_KEY}')
    (x.BASE / 'leader' / 'restart').write_text('restart\n')
    stopped = x.leader_signal('TERM', which=('server',))
    new = x.wait_for(lambda: (lambda p: p if p and p['pid'] != old_pid else None)(x.leader_probe('/pid', quiet=True)), 240, 'the restarted leader')
    x.note('s4: leader back', old=old_pid, new=new)
    cursor_boot = x.leader_probe(f'/cursor?host={x.HOST_KEY}')
    side = x.wait_for(lambda: (lambda s: s if s and s['linked'] and s['judges'] else None)(x.leader_probe(f'/side?host={x.HOST_KEY}', quiet=True)), 240, 'the restarted leader to link the host')
    seen = x.wait_for(lambda: channel_result(sid, m4), 240, 'PONG-4 on the restarted leader')
    host_result = host_has(sid, m4)
    settle()
    cmp_ = x.compare_facts(sid)
    once = results_on_leader(sid, m4)
    evs = [e for e in x.leader_events(sid) if e.get('source') == 'host-channel' and x.is_fact(e['name'], e.get('cls'))]
    by_pid = {}
    for e in evs:
        by_pid[e['pid']] = by_pid.get(e['pid'], 0) + 1
    out = {'sid': sid, 'oldLeaderPid': old_pid, 'newLeader': new, 'stopped': stopped, 'toolUseOnHostAt': tool['at'],
           'cursorBeforeStop': cursor_before, 'cursorAtBoot': cursor_boot, 'cursorAfter': x.leader_probe(f'/cursor?host={x.HOST_KEY}'),
           'sideAfter': side, 'hostResultAt': host_result and host_result['at'], 'leaderResultSeenAt': seen['seenAt'], 'leaderResultPid': seen['pid'],
           'resultsOnLeader': [{'source': e['source'], 'pid': e['pid']} for e in once], 'factsByLeaderPid': by_pid, 'facts': cmp_,
           'leaderParses': x.leader_probe(f'/parses?sid={sid}')['parses'],
           'runs': (x.BASE / 'leader' / 'runs.log').read_text().strip().split('\n')[-3:]}
    ok = new['pid'] != old_pid and len(once) == 1 and cmp_['equalInOrder'] and cmp_['doubled'] == 0 and out['leaderParses'] == 0
    out['verdict'] = verdict(ok)
    return out


def s5() -> dict:
    m5 = mark('5')
    sid = state()['sid']
    door = f'ws://127.0.0.1:{x.DOOR_PORT}/host-door'
    x.door_up()
    st, js = x.leader_api('PUT', '/api/config', {'session': {'host_door_urls': [door]}})
    x.note('s5: door urls', status=st)
    assert st == 200, (st, js)
    dialer = x.wait_for(lambda: (lambda d: d if d and d['holds'] and d['linked'] else None)(x.host_probe('/dialer', quiet=True)), 300, 'the host to hold its credential and dial the door')
    kind = x.wait_for(lambda: (lambda s: s if s and s['kind'] == 'host-dialed' else None)(x.leader_probe(f'/side?host={x.HOST_KEY}', quiet=True)), 120, 'the leader to take the dialed socket')
    cred = x.host(f'ls -la {x.ROOT}/home/.local/state/open-walnut/host-credentials/ 2>&1; stat -c "%a %n" {x.ROOT}/home/.local/state/open-walnut/host-credentials/*.json 2>&1').strip()
    x.link_down()
    link = x.wait_for(lambda: (lambda l: l if l and not l['connected'] else None)(x.leader_probe(f'/link?host={x.HOST_KEY}', quiet=True)), 120, 'the leader to lose its daemon link')
    before = x.host_probe(f'/facts?after=0&sid={sid}')['head']
    send(sid, ask(m5))
    seen = x.wait_for(lambda: channel_result(sid, m5), 300, 'PONG-5 on the leader over the dialed socket')
    on_host = host_has(sid, m5, names=('session:send',))
    side_after = x.leader_probe(f'/side?host={x.HOST_KEY}')
    link_after = x.leader_probe(f'/link?host={x.HOST_KEY}')
    settle()
    cmp_ = x.compare_facts(sid)
    out = {'sid': sid, 'door': door, 'dialer': dialer, 'sideDialed': kind, 'credentialFile': cred, 'linkAfterCut': link,
           'sendOnHost': on_host and {'at': on_host['at'], 'source': on_host['source']}, 'leaderResultSeenAt': seen['seenAt'],
           'sideAfter': side_after, 'linkAfter': link_after, 'facts': cmp_, 'factsSince': before,
           'leaderParses': x.leader_probe(f'/parses?sid={sid}')['parses']}
    ok = dialer['holds'] and kind['kind'] == 'host-dialed' and not link_after['connected'] and side_after['kind'] == 'host-dialed' \
        and bool(on_host) and cmp_['equalInOrder'] and out['leaderParses'] == 0 and '600' in cred
    out['verdict'] = verdict(ok)
    return out


def s6() -> dict:
    m6a = mark('6a')
    m6b = mark('6b')
    sid = state()['sid']
    # A legacy start needs the leader's daemon route: it comes back first.
    x.link_follow()
    x.wait_for(lambda: (lambda l: l if l and l['connected'] else None)(x.leader_probe(f'/link?host={x.HOST_KEY}', quiet=True)), 180, 'the leader\'s daemon link back')
    before = x.host_probe(f'/facts?after=0&sid={sid}')['head']
    send(sid, ask_long(m6a, 25))
    x.wait_for(lambda: turn_started_on_host(sid, before), 180, 'the long turn to run on the host')
    st, js = x.leader_api('PUT', '/api/config', {'experimental': {'host_runs_sessions': False}})
    off_at = int(time.time() * 1000)
    x.note('s6: switch off', status=st)
    assert st == 200, (st, js)
    side_off = x.wait_for(lambda: (lambda s: s if s and not s['judges'] else None)(x.leader_probe(f'/side?host={x.HOST_KEY}', quiet=True)), 60, 'the leader to stop handing starts to the host')
    running = x.wait_for(lambda: channel_result(sid, m6a), 300, 'PONG-6a (the running host-judged turn) on the leader')
    st, t = x.leader_api('POST', '/api/tasks', {'title': 'C5e legacy run after the switch', 'project': 'C5e'})
    assert st == 201, (st, t)
    st, started = x.leader_api('POST', f'/api/v1/tasks/{t["task"]["id"]}/start', {'host': x.HOST_KEY, 'cwd': f'{x.ROOT}/work', 'mode': 'bypass', 'message': ask(m6b)}, timeout=120)
    x.note('s6: legacy start', status=st, reply=started)
    assert st == 202, (st, started)
    lsid = started['sessionId']
    keep(legacySid=lsid)
    legacy = x.wait_for(lambda: x.result_with(x.leader_events(lsid), m6b), 300, 'PONG-6b (the legacy session) on the leader')
    st, row = x.leader_api('GET', f'/api/sessions/{lsid}')
    rec = (row or {}).get('session', row) or {}
    judge = x.leader_probe(f'/judge?sid={lsid}')
    parses = x.leader_probe(f'/parses?sid={lsid}')['parses']
    chan = [e for e in x.leader_events(lsid) if e.get('source') == 'host-channel']
    procs = x.host_ours()
    out = {'sid': sid, 'switchOffAt': off_at, 'sideOff': side_off, 'runningTurnResult': {'seenAt': running['seenAt'], 'source': running['source'], 'afterOff': running['seenAt'] > off_at},
           'factsOfRunningSession': x.compare_facts(sid), 'legacySid': lsid, 'legacyResultSource': legacy['source'],
           'legacyRow': {k: rec.get(k) for k in ('claudeSessionId', 'judge', 'host', 'process_status')}, 'legacyJudgeOf': judge,
           'legacyLeaderParses': parses, 'legacyChannelEvents': len(chan), 'hostProcesses': procs}
    ok = not side_off['judges'] and out['runningTurnResult']['afterOff'] and out['factsOfRunningSession']['equalInOrder'] \
        and rec.get('judge') in (None, '') and judge.get('judge') == 'legacy' and parses > 0 and len(chan) == 0
    out['verdict'] = verdict(ok)
    return out


ALL = {'s1': s1, 's2': s2, 's3': s3, 's4': s4, 's5': s5, 's6': s6}


def main(names) -> None:
    for n in names or list(ALL):
        x.note(f'{n}: begin')
        try:
            out = ALL[n]()
        except Exception as e:  # noqa: BLE001
            out = {'verdict': 'FAIL', 'error': repr(e)}
        out['endedAt'] = x.now_iso()
        x.save(f'{n}.json', out)
        x.note(f'{n}: {out["verdict"]}', **({'error': out['error']} if 'error' in out else {}))
