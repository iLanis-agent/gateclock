#!/usr/bin/env python3
"""Independent oracle for GateClock. Re-derives the backward chain from scratch
(no shared code with engine.js). All integer minutes, so results are exact.
Writes tests/expected.json: raw inputs + expected leave times and bindings."""
import json, random

DEF = {'domestic': {'checkinCutoff': 30, 'bagCutoff': 45, 'doorClose': 15},
       'international': {'checkinCutoff': 60, 'bagCutoff': 60, 'doorClose': 20}}

def hm(s):
    h, m = str(s).split(':')
    return int(h) * 60 + int(m)

def norm(raw):
    t = 'international' if raw.get('tripType') == 'international' else 'domestic'
    d = DEF[t]
    pick = lambda k, dv: raw[k] if k in raw and raw[k] not in (None, '') else dv
    return {
        'flight': hm(raw['flight']), 'tripType': t, 'bags': bool(raw.get('bags')),
        'doorClose': int(pick('doorClose', d['doorClose'])),
        'checkinCutoff': int(pick('checkinCutoff', d['checkinCutoff'])),
        'bagCutoff': int(pick('bagCutoff', d['bagCutoff'])),
        'bagQueue': int(pick('bagQueue', 10)),
        'securityMedian': int(pick('securityMedian', 15)),
        'securityBad': int(pick('securityBad', 45)),
        'walk': int(pick('walk', 10)), 'shuttle': int(pick('shuttle', 0)),
        'drive': int(pick('drive', 30)), 'bufferPct': float(pick('bufferPct', 0.25)),
    }

def plan(inp, sec_wait):
    at_gate = inp['flight'] - inp['doorClose']
    sec_out = at_gate - inp['walk']
    sec_join = sec_out - sec_wait
    checkin_by = inp['flight'] - inp['checkinCutoff'] if inp['checkinCutoff'] > 0 else float('inf')
    sec_cand = sec_join - (inp['bagQueue'] if inp['bags'] else 0)
    bag_cand = inp['flight'] - inp['bagCutoff'] - inp['bagQueue'] if inp['bags'] else float('inf')
    terminal_by, binding = sec_cand, 'security'
    if bag_cand < terminal_by: terminal_by, binding = bag_cand, 'bag-drop cutoff'
    if checkin_by < terminal_by: terminal_by, binding = checkin_by, 'check-in cutoff'
    drive_min = round(inp['drive'] * (1 + inp['bufferPct']))  # python round = banker's
    # JS Math.round is half-up; replicate
    import math
    drive_min = math.floor(inp['drive'] * (1 + inp['bufferPct']) + 0.5)
    leave = terminal_by - inp['shuttle'] - drive_min
    return leave, binding

def wrap(leave):
    prev = False
    while leave < 0:
        leave += 1440
        prev = True
    return leave, prev

cases = []
# Hand cases: each binding type + wrap + zero-drive edge
cases.append({'id': 'hand-security-binds', 'raw': {'flight': '14:00', 'bags': True, 'drive': 40}})
cases.append({'id': 'hand-bagdrop-binds', 'raw': {'flight': '10:00', 'bags': True, 'bagCutoff': 60, 'bagQueue': 20,
    'securityMedian': 5, 'securityBad': 8, 'walk': 5, 'doorClose': 10, 'checkinCutoff': 0, 'drive': 25, 'bufferPct': 0.2}})
cases.append({'id': 'hand-checkin-binds', 'raw': {'flight': '09:00', 'bags': False, 'checkinCutoff': 90,
    'securityMedian': 5, 'securityBad': 10, 'walk': 5, 'doorClose': 10, 'drive': 15, 'bufferPct': 0}})
cases.append({'id': 'hand-wrap-evening-before', 'raw': {'flight': '00:30', 'bags': False, 'checkinCutoff': 0, 'drive': 20}})
cases.append({'id': 'hand-zero-drive', 'raw': {'flight': '18:45', 'bags': False, 'drive': 0, 'shuttle': 0, 'checkinCutoff': 0,
    'securityMedian': 10, 'securityBad': 30, 'walk': 15}})
cases.append({'id': 'hand-intl-bags', 'raw': {'flight': '23:15', 'tripType': 'international', 'bags': True,
    'drive': 75, 'bufferPct': 0.4, 'shuttle': 20, 'securityMedian': 25, 'securityBad': 70}})

rng = random.Random(20261007)
for i in range(24):
    raw = {
        'flight': f"{rng.randint(0,23):02d}:{rng.choice([0,5,10,15,20,25,30,35,40,45,50,55]):02d}",
        'tripType': rng.choice(['domestic', 'international']),
        'bags': rng.random() < 0.5,
        'doorClose': rng.randint(10, 30),
        'checkinCutoff': rng.choice([0, 30, 45, 60, 90]),
        'bagCutoff': rng.randint(30, 75),
        'bagQueue': rng.randint(5, 25),
        'securityMedian': rng.randint(5, 30),
        'walk': rng.randint(3, 25),
        'shuttle': rng.choice([0, 0, 10, 15, 25]),
        'drive': rng.randint(5, 120),
        'bufferPct': rng.choice([0, 0.1, 0.25, 0.5]),
    }
    raw['securityBad'] = raw['securityMedian'] + rng.randint(0, 60)
    cases.append({'id': f'rand-{i:02d}', 'raw': raw})

out = []
for c in cases:
    inp = norm(c['raw'])
    cl, cb = plan(inp, inp['securityBad'])
    rl, rb = plan(inp, inp['securityMedian'])
    cw, cp = wrap(cl)
    rw, rp = wrap(rl)
    out.append({'id': c['id'], 'raw': c['raw'], 'expected': {
        'comfortableLeave': cw, 'comfortablePrev': cp, 'comfortableBinding': cb,
        'riskyLeave': rw, 'riskyPrev': rp, 'riskyBinding': rb,
        'savedByRisk': rl - cl}})
with open('tests/expected.json', 'w') as f:
    json.dump(out, f, indent=1)
print(f'wrote {len(out)} cases')
for o in out[:8]:
    e = o['expected']
    print(o['id'], 'comf', e['comfortableLeave'], e['comfortableBinding'], 'prev', e['comfortablePrev'],
          '| risky', e['riskyLeave'], '| saved', e['savedByRisk'])
