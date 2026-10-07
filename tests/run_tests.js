/* GateClock tests: oracle cases (independent python chain), semantics,
   validation, escaping. Run: node tests/run_tests.js */
'use strict';
const G = require('../engine.js');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('FAIL:', msg); } }
function throwsWith(fn, needle, msg) {
  try { fn(); failed++; console.error('FAIL (no throw):', msg); }
  catch (e) { ok(e.message.includes(needle), msg + ` (threw "${e.message}")`); }
}

// ---------- 1. Oracle cases ----------
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected.json'), 'utf8'));
for (const c of cases) {
  const r = G.solve(c.raw), e = c.expected;
  ok(r.comfortableLeave.leave === e.comfortableLeave, `${c.id}: comfortable leave ${r.comfortableLeave.leave} == ${e.comfortableLeave}`);
  ok(r.comfortableLeave.previousDay === e.comfortablePrev, `${c.id}: comfortable prevDay`);
  ok(r.comfortable.binding === e.comfortableBinding, `${c.id}: comfortable binding ${r.comfortable.binding} == ${e.comfortableBinding}`);
  ok(r.riskyLeave.leave === e.riskyLeave, `${c.id}: risky leave`);
  ok(r.riskyLeave.previousDay === e.riskyPrev, `${c.id}: risky prevDay`);
  ok(r.risky.binding === e.riskyBinding, `${c.id}: risky binding`);
  ok(r.savedByRisk === e.savedByRisk, `${c.id}: savedByRisk ${r.savedByRisk} == ${e.savedByRisk}`);
  // forward-pass consistency: every slack >= 0, and the binding chain ends at slack 0 at the gate
  for (const s of r.comfortable.stages) {
    if (s.slack !== undefined) ok(s.slack >= 0, `${c.id}: ${s.key} slack >= 0 (got ${s.slack})`);
  }
  // The binding stage lands exactly on its deadline; stages after an earlier
  // binding constraint finish with spare slack by construction.
  const gate = r.comfortable.stages.find(s => s.key === 'gate');
  if (r.comfortable.binding === 'security') {
    ok(gate.slack === 0, `${c.id}: security-bound -> gate slack 0 (got ${gate.slack})`);
  } else if (r.comfortable.binding === 'bag-drop cutoff') {
    const bags = r.comfortable.stages.find(s => s.key === 'bags');
    ok(bags.slack === 0, `${c.id}: bag-bound -> bags slack 0 (got ${bags.slack})`);
  } else {
    ok(r.comfortable.terminalBy === r.input.flight - r.input.checkinCutoff,
       `${c.id}: check-in bound -> terminal arrival on the cutoff`);
  }
  // risky never requires leaving earlier than comfortable
  ok(r.risky.leaveHome >= r.comfortable.leaveHome, `${c.id}: risky leaves not earlier`);
}

// ---------- 2. Semantics ----------
{
  // Known chain by hand: flight 12:00 (720), domestic, no bags, checkin 0,
  // doorClose 15 -> gate 705; walk 10 -> sec out 695; bad 45 -> join 650;
  // shuttle 0; drive 20 buffer 0.5 -> 30; leave 620 = 10:20
  const r = G.solve({ flight: '12:00', bags: false, checkinCutoff: 0, doorClose: 15,
    walk: 10, securityBad: 45, securityMedian: 15, shuttle: 0, drive: 20, bufferPct: 0.5 });
  ok(r.comfortableLeave.leave === 620, `hand chain leave 620 (got ${r.comfortableLeave.leave})`);
  ok(r.comfortable.driveMin === 30, `buffered drive 30 (got ${r.comfortable.driveMin})`);
  ok(r.riskyLeave.leave === 650, `risky leave 650 (got ${r.riskyLeave.leave})`);
  ok(r.savedByRisk === 30, 'saved 30 min');
}
{
  // Bag drop before security: terminal arrival must cover counter time in the security chain
  const r = G.solve({ flight: '14:00', bags: true, drive: 40 });
  const bags = r.comfortable.stages.find(s => s.key === 'bags');
  const gate = r.comfortable.stages.find(s => s.key === 'gate');
  ok(gate.slack === 0 && bags.slack >= 0, 'bag drop fits inside the security-bound chain');
}
{
  // Buffer percentage applies to the drive only, and rounds half-up
  const a = G.solve({ flight: '12:00', bags: false, checkinCutoff: 0, drive: 21, bufferPct: 0 });
  const b = G.solve({ flight: '12:00', bags: false, checkinCutoff: 0, drive: 21, bufferPct: 0.5 });
  ok(b.comfortable.driveMin === Math.floor(21 * 1.5 + 0.5), `buffer half-up 32 (got ${b.comfortable.driveMin})`);
  ok(a.comfortableLeave.leave - b.comfortableLeave.leave === 32 - 21, 'buffer shifts leave by buffered delta');
}
{
  // International defaults differ from domestic
  const d = G.normalize({ flight: '10:00' });
  const i = G.normalize({ flight: '10:00', tripType: 'international' });
  ok(d.doorClose === 15 && i.doorClose === 20 && d.bagCutoff === 45 && i.bagCutoff === 60, 'per-type defaults');
}

// ---------- 3. Validation ----------
throwsWith(() => G.solve(null), 'Missing input', 'null input');
throwsWith(() => G.solve({}), 'flight departure time', 'missing flight');
throwsWith(() => G.solve({ flight: '9:99' }), 'Bad time', 'bad minutes');
throwsWith(() => G.solve({ flight: '24:00' }), 'Hours run 00-23', 'hour 24');
throwsWith(() => G.solve({ flight: 'noon' }), 'Bad time', 'junk time');
throwsWith(() => G.solve({ flight: '10:00', drive: -5 }), 'between 0 and 600', 'negative drive');
throwsWith(() => G.solve({ flight: '10:00', drive: 'fast' }), 'must be a number', 'non-numeric drive');
throwsWith(() => G.solve({ flight: '10:00', bufferPct: 4 }), 'between 0 and 3', 'buffer too big');
throwsWith(() => G.solve({ flight: '10:00', securityMedian: 60, securityBad: 30 }), 'at least the median', 'bad < median');
throwsWith(() => G.solve({ flight: '10:00', doorClose: 500 }), 'between 0 and 120', 'doorClose range');
ok(G.normalize({ flight: '10:00', walk: '' }).walk === 10, 'empty optional field falls back to default');

// ---------- 4. fmtHM / parseHM / esc ----------
ok(G.parseHM('') === null && G.parseHM(null) === null, 'parseHM empty -> null');
ok(G.parseHM('00:00') === 0 && G.parseHM('23:59') === 1439, 'parseHM values');
ok(G.fmtHM(0) === '00:00' && G.fmtHM(620) === '10:20' && G.fmtHM(-45) === '23:15' && G.fmtHM(1475) === '00:35', 'fmtHM wrap');
ok(G.esc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', 'esc injection');
ok(G.esc("a & \"b\" 'c'") === 'a &amp; &quot;b&quot; &#39;c&#39;', 'esc all five');
ok(G.DEFAULTS.domestic.doorClose === 15 && G.DEFAULTS.international.doorClose === 20, 'DEFAULTS exposed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
