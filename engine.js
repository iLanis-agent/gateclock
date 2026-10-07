/* GateClock engine: work backwards from the boarding door to your front door.
   Pure functions, no DOM. Used by app.html (browser) and tests/run_tests.js (node).
   All times are minutes from midnight (0-1439). The chain may wrap past midnight;
   fmtHM wraps and the UI flags "the evening before" when that happens. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GateClock = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function parseHM(s) {
    if (s === null || s === undefined || String(s).trim() === '') return null;
    var m = /^(\d{1,2}):([0-5]\d)$/.exec(String(s).trim());
    if (!m) throw new Error('Bad time "' + s + '". Use 24-hour HH:MM.');
    var h = +m[1];
    if (h > 23) throw new Error('Bad time "' + s + '". Hours run 00-23.');
    return h * 60 + (+m[2]);
  }

  function fmtHM(mins) {
    var m = ((Math.round(mins) % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }

  function num(v, label, min, max) {
    if (v === '' || v === null || v === undefined) throw new Error(label + ' is required.');
    var n = Number(v);
    if (!isFinite(n)) throw new Error(label + ' must be a number.');
    if (n < min || n > max) throw new Error(label + ' must be between ' + min + ' and ' + max + '.');
    return n;
  }

  /* Defaults are labelled typical values, editable in the UI. */
  var DEFAULTS = {
    domestic:   { checkinCutoff: 30, bagCutoff: 45, doorClose: 15 },
    international: { checkinCutoff: 60, bagCutoff: 60, doorClose: 20 }
  };

  /* normalize(raw) -> validated input.
     raw fields:
       flight (HH:MM, required), tripType 'domestic'|'international',
       bags bool,
       doorClose (min before departure the door closes),
       checkinCutoff (min before departure online/check-in counter closes; 0 = already checked in),
       bagCutoff (min before departure bag drop closes; used only when bags),
       bagQueue (min spent at the bag-drop counter),
       securityMedian, securityBad (min, bad-day queue),
       walk (min security exit -> gate),
       shuttle (min parking -> terminal; 0 for drop-off),
       drive (min home -> airport),
       bufferPct (0-1, extra drive allowance)                                        */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Missing input.');
    var flight = parseHM(raw.flight);
    if (flight === null) throw new Error('Set the flight departure time (HH:MM).');
    var tripType = raw.tripType === 'international' ? 'international' : 'domestic';
    var d = DEFAULTS[tripType];
    var bags = !!raw.bags;
    function pick(v, dflt) { return (v === undefined || v === null || v === '') ? dflt : v; }
    var inp = {
      flight: flight, tripType: tripType, bags: bags,
      doorClose: num(pick(raw.doorClose, d.doorClose), 'Door-close minutes', 0, 120),
      checkinCutoff: num(pick(raw.checkinCutoff, d.checkinCutoff), 'Check-in cutoff', 0, 240),
      bagCutoff: num(pick(raw.bagCutoff, d.bagCutoff), 'Bag-drop cutoff', 0, 240),
      bagQueue: num(pick(raw.bagQueue, 10), 'Bag-drop counter minutes', 0, 120),
      securityMedian: num(pick(raw.securityMedian, 15), 'Median security wait', 0, 240),
      securityBad: num(pick(raw.securityBad, 45), 'Bad-day security wait', 0, 360),
      walk: num(pick(raw.walk, 10), 'Walk to gate', 0, 120),
      shuttle: num(pick(raw.shuttle, 0), 'Parking shuttle', 0, 120),
      drive: num(pick(raw.drive, 30), 'Drive to airport', 0, 600),
      bufferPct: num(pick(raw.bufferPct, 0.25), 'Drive buffer %', 0, 3)
    };
    if (inp.securityBad < inp.securityMedian)
      throw new Error('Bad-day security wait should be at least the median wait.');
    return inp;
  }

  /* plan(inp, securityWait) -> backward chain for one security scenario.
     Deadlines are minutes relative to flight time (negative = before). */
  function plan(inp, securityWait) {
    // Gate arrival deadline (absolute minutes-of-day)
    var atGateBy = inp.flight - inp.doorClose;
    // Must clear security this early (security exit -> gate walk)
    var securityOutBy = atGateBy - inp.walk;
    // Join the security line this early
    var securityJoinBy = securityOutBy - securityWait;
    // Online check-in is a hard wall only if you have not checked in:
    // be at the terminal early enough that the cutoff has not passed.
    var checkinBy = inp.checkinCutoff > 0 ? inp.flight - inp.checkinCutoff : Infinity;
    // Bag drop: processed at the counter before the cutoff; counter time first.
    // Bag drop happens before security, so when bags are checked the terminal
    // arrival must be earlier by the counter time for the security chain too.
    var secCandidate = securityJoinBy - (inp.bags ? inp.bagQueue : 0);
    var bagCandidate = inp.bags ? inp.flight - inp.bagCutoff - inp.bagQueue : Infinity;
    var terminalBy = secCandidate, binding = 'security';
    if (bagCandidate < terminalBy) { terminalBy = bagCandidate; binding = 'bag-drop cutoff'; }
    if (checkinBy < terminalBy) { terminalBy = checkinBy; binding = 'check-in cutoff'; }
    // Parking shuttle then the buffered drive
    var leaveParking = terminalBy - inp.shuttle;
    var driveMin = Math.round(inp.drive * (1 + inp.bufferPct));
    var leaveHome = leaveParking - driveMin;

    // Forward pass: stages with slack against their deadlines
    var t = leaveHome;
    var stages = [];
    stages.push({ key: 'leave', label: 'Leave home', at: t });
    t += driveMin;
    stages.push({ key: 'drive', label: 'Arrive at airport area', at: t, slack: leaveParking - t });
    if (inp.shuttle > 0) {
      t += inp.shuttle;
      stages.push({ key: 'shuttle', label: 'Enter terminal (shuttle)', at: t, slack: terminalBy - t });
    } else {
      stages.push({ key: 'terminal', label: 'Enter terminal', at: t, slack: terminalBy - t });
    }
    if (inp.bags) {
      t += inp.bagQueue;
      stages.push({ key: 'bags', label: 'Bags dropped', at: t, slack: (inp.flight - inp.bagCutoff) - t });
    }
    t += securityWait;
    stages.push({ key: 'security', label: 'Through security', at: t, slack: securityOutBy - t });
    t += inp.walk;
    stages.push({ key: 'gate', label: 'At the gate', at: t, slack: atGateBy - t });
    stages.push({ key: 'door', label: 'Door closes', at: inp.flight - inp.doorClose });
    stages.push({ key: 'depart', label: 'Flight departs', at: inp.flight });

    return { leaveHome: leaveHome, terminalBy: terminalBy, binding: binding,
             driveMin: driveMin, securityWait: securityWait, stages: stages };
  }

  function solve(raw) {
    var inp = normalize(raw);
    var comfortable = plan(inp, inp.securityBad);
    var risky = plan(inp, inp.securityMedian);
    // previousDay flag when the leave time wrapped before midnight
    function wrap(p) {
      var leave = p.leaveHome, prev = false;
      while (leave < 0) { leave += 1440; prev = true; }
      return { leave: leave, previousDay: prev };
    }
    return {
      input: inp,
      comfortable: comfortable,
      risky: risky,
      comfortableLeave: wrap(comfortable),
      riskyLeave: wrap(risky),
      savedByRisk: Math.round(risky.leaveHome - comfortable.leaveHome) // >= 0, minutes later you can leave
    };
  }

  return { solve: solve, plan: plan, normalize: normalize, DEFAULTS: DEFAULTS,
           parseHM: parseHM, fmtHM: fmtHM, esc: esc };
});
