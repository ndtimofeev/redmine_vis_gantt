// Moving and resizing bars with a real mouse; what is saved, what Redmine reschedules, what is refused.
const { launch, login, BASE } = require('./lib');
const { helpers, addDays, days } = require('./helpers');
const SP = process.argv[2] || '.';
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -> ' + extra : '')); if (!ok) failed++; };

(async () => {
  const { browser, page, problems } = await launch();
  await login(page);
  await page.goto(BASE + '/projects/demo/vis_gantt');
  await page.waitForSelector('.vis-item');
  await page.waitForTimeout(500);
  const h = helpers(page);
  const localDay = id => page.evaluate(id => { const d = window.visGantt.items.get(id).start; return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }, id);

  const PLAN = await h.idOf('Plan version 2.0'), BACKEND = await h.idOf('Implement backend'), UI = await h.idOf('Implement UI'),
        TEST = await h.idOf('Acceptance testing'), DOCS = await h.idOf('Documentation'), SUB = await h.idOf('Subproject task');
  const num = id => id.replace(/^i/, '');

  // S1 move a free issue
  let before = await h.serverRow(PLAN);
  let r = await h.drag(PLAN, 'move', 7);
  let after = await h.serverRow(PLAN);
  check('S1 move +7 days saves both dates', after.start === addDays(before.start, 7) && after.due === addDays(before.due, 7), `${before.start}..${before.due} -> ${after.start}..${after.due}; "${r.toast && r.toast.text}"`);

  // S2 resize right edge
  before = after; r = await h.drag(PLAN, 'right', 3); after = await h.serverRow(PLAN);
  check('S2 right edge +3 days changes only due (±1 day)', after.start === before.start && Math.abs(days(before.due, after.due) - 3) <= 1, `${before.start}..${before.due} -> ${after.start}..${after.due}`);

  // S3 resize left edge
  before = after; r = await h.drag(PLAN, 'left', 2); after = await h.serverRow(PLAN);
  check('S3 left edge +2 days changes only start (±1 day)', after.due === before.due && Math.abs(days(before.start, after.start) - 2) <= 1, `${before.start}..${before.due} -> ${after.start}..${after.due}`);

  // S4 move a predecessor: followers must be rescheduled by Redmine
  const f1 = await h.serverRow(UI), f2 = await h.serverRow(TEST);
  before = await h.serverRow(BACKEND); r = await h.drag(BACKEND, 'move', 20); after = await h.serverRow(BACKEND);
  const g1 = await h.serverRow(UI), g2 = await h.serverRow(TEST);
  check('S4a predecessor moved +20 days', after.start === addDays(before.start, 20), `${before.start}..${before.due} -> ${after.start}..${after.due}`);
  check('S4b followers were rescheduled and the chart reloaded', g1.start > f1.start && g2.start > f2.start && g1.start > after.due, `#UI ${f1.start} -> ${g1.start}, #TEST ${f2.start} -> ${g2.start}`);
  const dom = await localDay(UI);
  check('S4c chart shows the new position of the follower', dom === g1.start, `item start ${dom} vs server ${g1.start}`);

  // S5 move a follower before its predecessor ends: rejected, bar snaps back
  before = await h.serverRow(TEST); r = await h.drag(TEST, 'move', -60); after = await h.serverRow(TEST);
  check('S5 invalid move is rejected with a message', after.start === before.start && r.toast && r.toast.kind === 'error' && r.toast.text.length > 5, `message: "${r.toast && r.toast.text}"`);
  check('S5b bar went back to the saved position', (await localDay(TEST)) === before.start);

  // S6 parent with derived dates cannot be dragged
  before = await h.serverRow(DOCS); r = await h.drag(DOCS, 'move', 5); after = await h.serverRow(DOCS);
  check('S6 derived parent does not move', after.start === before.start && after.due === before.due && before.derived === true);

  // S6b live feedback while dragging
  const b = await h.box(PLAN);
  await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(b.x + b.w / 2 + i * 12, b.y + b.h / 2);
  const chip = await page.evaluate(() => { const c = document.querySelector('.vg-chip'); return c && !c.hidden ? c.textContent : null; });
  await page.mouse.up(); await h.waitToast(['ok', 'error']); await page.waitForTimeout(500);
  check('S6b a chip with the new dates and duration follows the mouse while dragging', !!chip && /→/.test(chip) && /\d/.test(chip), chip);
  check('S6c the chip is gone after the drop', await page.evaluate(() => document.querySelector('.vg-chip').hidden));

  // S6d the same issue dragged again and again: every save must see the lock_version of the previous one
  const results = [];
  for (let i = 0; i < 4; i++) { const rr = await h.drag(PLAN, 'right', 2); results.push(rr.toast && rr.toast.kind); }
  check('S6d four consecutive drags of one issue all succeed (no stale lock_version)', results.every(k => k === 'ok'), results.join(','));

  // S7 history entry
  await page.goto(BASE + '/issues/' + num(PLAN));
  const hist = await page.locator('#history').innerText();
  check('S7 issue history records the date changes by the user', /Start date changed|Due date changed/.test(hist), hist.replace(/\s+/g, ' ').slice(0, 160));

  // S8 stale lock_version
  await page.goto(BASE + '/projects/demo/vis_gantt'); await page.waitForSelector('.vis-item');
  const SUBNUM = num(SUB);
  const put = body => page.evaluate(async ([url, body, token]) => {
    const tok = token ? document.querySelector('meta[name=csrf-token]').content : null;
    const headers = { 'Content-Type': 'application/json' }; if (tok) headers['X-CSRF-Token'] = tok;
    const res = await fetch(url, { method: 'PUT', credentials: 'same-origin', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, body);
  const stale = await put([`/vis_gantt/issues/${SUBNUM}/dates`, { issue: { start_date: '2026-10-02', due_date: '2026-10-20', lock_version: 999 } }, true]);
  check('S8 stale lock_version -> 409', stale.status === 409, JSON.stringify(stale.body));

  // S9 bad input
  const bad1 = await put([`/vis_gantt/issues/${SUBNUM}/dates`, { issue: { start_date: 'nope', due_date: '2026-10-20' } }, true]);
  const bad2 = await put([`/vis_gantt/issues/${SUBNUM}/dates`, { issue: { start_date: '2026-10-20', due_date: '2026-10-01' } }, true]);
  check('S9 malformed date -> 422, due before start -> 422', bad1.status === 422 && bad2.status === 422, JSON.stringify([bad1.status, bad2.status, bad2.body && bad2.body.errors]));

  // S9b the restore endpoint refuses garbage too
  const bad3 = await put(['/vis_gantt/restore_dates', { changes: [{ id: 'x' }] }, true]);
  check('S9b restore_dates with a malformed payload -> 422', bad3.status === 422, JSON.stringify(bad3.body));

  // S10 without a CSRF token (this ends the session, keep it last)
  const nocsrf = await put([`/vis_gantt/issues/${SUBNUM}/dates`, { issue: { start_date: '2026-10-02', due_date: '2026-10-20' } }, false]);
  check('S10 request without CSRF token is refused', nocsrf.status >= 400, 'status ' + nocsrf.status);

  console.log(problems.filter(p => !/Failed to load resource/.test(p)).join('\n') || 'no console problems');
  await browser.close();
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})();
