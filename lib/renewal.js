// Next renewal date for monthly subscriptions (tracker.html).
//
// nextMonthly('2026-06-12', '2026-10-31') -> '2026-11-12'
// Moves a past due date forward by whole months to the first date on or
// after today. The day of the month is kept where it exists; otherwise it is
// clamped to the month's last day (Jan 31 -> Feb 28 -> Mar 31). Pass `anchorDay`
// to keep, say, the 31st after a clamp has already been stored.
'use strict';

function parse(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}

const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function addMonths(p, n, anchorDay) {
  const idx = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  const d = Math.min(anchorDay, daysIn(y, m));
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Today's date in US Eastern time, as YYYY-MM-DD.
function todayEastern(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

// Returns the advanced date, or the same date if it is not in the past.
function nextMonthly(renewal, today, anchorDay) {
  const p = parse(renewal);
  if (!p || !parse(today) || renewal >= today) return renewal;
  const day = anchorDay || p.d;
  // Jump close, then step: avoids a long loop for very old dates.
  const t = parse(today);
  let n = Math.max(0, (t.y - p.y) * 12 + (t.m - p.m) - 1);
  let next = addMonths(p, n, day);
  while (next < today) next = addMonths(p, ++n, day);
  return next;
}

// True for rows the tracker should roll forward.
function shouldAdvance(row, today) {
  return !!row && row.is_active !== false && row.auto_renews !== false &&
    row.billing_cycle === 'monthly' && !!parse(row.renewal_date) && row.renewal_date < today;
}

module.exports = { nextMonthly, shouldAdvance, todayEastern };
