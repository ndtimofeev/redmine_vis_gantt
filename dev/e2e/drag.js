const { launch, login, BASE } = require('./lib');
const SP = process.argv[2] || '.'; // where screenshots go
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -> ' + extra : '')); if (!ok) failed++; };

const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + n)); return dt.toISOString().slice(0, 10); };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

(async () => {
  const { browser, page, problems } = await launch();
  await login(page);
  await page.goto(BASE + '/projects/demo/vis_gantt');
  await page.waitForSelector('.vis-item');
  await page.waitForTimeout(500);

  const allRows = () => page.evaluate(async () => (await (await fetch('/projects/demo/vis_gantt/data', { credentials: 'same-origin' })).json()).rows);
  const idOf = async name => (await allRows()).find(r => r.name === name).id;
  const num = id => id.replace(/^i/, '');
  const serverRow = id => page.evaluate(async id => {
    const r = await fetch('/projects/demo/vis_gantt/data', { credentials: 'same-origin' });
    return (await r.json()).rows.find(x => x.id === id);
  }, id);
  const box = id => page.evaluate(id => {
    const it = window.visGantt.timeline.itemSet.items[id];
    if (!it || !it.dom || !it.dom.box) return null;
    const r = it.dom.box.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, id);
  const localDay = id => page.evaluate(id => { const d = window.visGantt.items.get(id).start; return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }, id);
  const status = () => page.locator('#vis-gantt-status').innerText();

  // Drags a bar. mode: 'move' | 'left' | 'right'; dxDays: horizontal distance in days.
  async function drag(id, mode, dxDays) {
    const row = await serverRow(id);
    const b = await box(id);
    const pxPerDay = b.w / (days(row.start, row.due) + 1);
    const y = b.y + b.h / 2;
    const x0 = mode === 'move' ? b.x + b.w / 2 : mode === 'left' ? b.x + 2 : b.x + b.w - 2;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    // vis-timeline (Hammer.js) ignores the first ~10px of a drag so that clicks do not turn into drags.
    const dx = dxDays * pxPerDay + Math.sign(dxDays) * 10;
    for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + dx * i / 8, y);
    await page.mouse.up();
    await page.waitForFunction(() => /vg-status-(ok|error)/.test(document.getElementById('vis-gantt-status').className), null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    return { row, msg: await status(), cls: await page.locator('#vis-gantt-status').getAttribute('class') };
  }
  const clearStatus = () => page.evaluate(() => { document.getElementById('vis-gantt-status').className = 'vg-status'; });

  const PLAN = await idOf('Plan version 2.0'), BACKEND = await idOf('Implement backend'), UI = await idOf('Implement UI'),
        TEST = await idOf('Acceptance testing'), DOCS = await idOf('Documentation'), SUB = await idOf('Subproject task');

  // S1 move a free issue
  let before = await serverRow(PLAN);
  let r = await drag(PLAN, 'move', 7);
  let after = await serverRow(PLAN);
  check('S1 move +7 days saves both dates', after.start === addDays(before.start, 7) && after.due === addDays(before.due, 7), `${before.start}..${before.due} -> ${after.start}..${after.due}; "${r.msg}"`);

  // S2 resize right edge
  await clearStatus();
  before = after; r = await drag(PLAN, 'right', 3); after = await serverRow(PLAN);
  const dd = (a, b) => days(a, b);
  check('S2 right edge +3 days changes only due (±1 day)', after.start === before.start && Math.abs(dd(before.due, after.due) - 3) <= 1, `${before.start}..${before.due} -> ${after.start}..${after.due}`);

  // S3 resize left edge
  await clearStatus();
  before = after; r = await drag(PLAN, 'left', 2); after = await serverRow(PLAN);
  check('S3 left edge +2 days changes only start (±1 day)', after.due === before.due && Math.abs(dd(before.start, after.start) - 2) <= 1, `${before.start}..${before.due} -> ${after.start}..${after.due}`);

  // S4 move a predecessor: followers must be rescheduled by Redmine
  await clearStatus();
  const f1 = await serverRow(UI), f2 = await serverRow(TEST);
  before = await serverRow(BACKEND); r = await drag(BACKEND, 'move', 20); after = await serverRow(BACKEND);
  const g1 = await serverRow(UI), g2 = await serverRow(TEST);
  check('S4a predecessor moved +20 days', after.start === addDays(before.start, 20), `${before.start}..${before.due} -> ${after.start}..${after.due}`);
  check('S4b followers were rescheduled and the chart reloaded', g1.start > f1.start && g2.start > f2.start && g1.start > after.due, `#30 ${f1.start} -> ${g1.start}, #31 ${f2.start} -> ${g2.start}`);
  const dom30 = await localDay(UI);
  check('S4c chart shows the new position of the follower', dom30 === g1.start, `item start ${dom30} vs server ${g1.start}`);

  // S5 move a follower before its predecessor ends: rejected, bar snaps back
  await clearStatus();
  before = await serverRow(TEST); r = await drag(TEST, 'move', -60); after = await serverRow(TEST);
  check('S5 invalid move is rejected with a message', after.start === before.start && /error/.test(r.cls) && r.msg.length > 5, `message: "${r.msg}"`);
  const itemAfter = await localDay(TEST);
  check('S5b bar went back to the saved position', itemAfter === before.start, itemAfter);

  // S6 parent with derived dates cannot be dragged
  await clearStatus();
  before = await serverRow(DOCS); r = await drag(DOCS, 'move', 5); after = await serverRow(DOCS);
  check('S6 derived parent does not move', after.start === before.start && after.due === before.due && before.derived === true);

  // S7 history entry
  await page.goto(BASE + '/issues/' + num(PLAN));
  const hist = await page.locator('#history').innerText();
  check('S7 issue history records the date changes by the user', /Start date changed|Due date changed/.test(hist), hist.replace(/\s+/g, ' ').slice(0, 160));

  // S8 stale lock_version
  await page.goto(BASE + '/projects/demo/vis_gantt'); await page.waitForSelector('.vis-item');
  const SUBNUM = num(SUB);
  const stale = await page.evaluate(async (SUBNUM) => {
    const tok = document.querySelector('meta[name=csrf-token]').content;
    const res = await fetch('/vis_gantt/issues/' + SUBNUM + '/dates', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok }, body: JSON.stringify({ issue: { start_date: '2026-10-02', due_date: '2026-10-20', lock_version: 999 } }) });
    return { status: res.status, body: await res.json() };
  }, SUBNUM);
  check('S8 stale lock_version -> 409', stale.status === 409, JSON.stringify(stale.body));

  // S9 bad input
  const bad = await page.evaluate(async (SUBNUM) => {
    const tok = document.querySelector('meta[name=csrf-token]').content;
    const res = await fetch('/vis_gantt/issues/' + SUBNUM + '/dates', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok }, body: JSON.stringify({ issue: { start_date: 'nope', due_date: '2026-10-20' } }) });
    const res2 = await fetch('/vis_gantt/issues/' + SUBNUM + '/dates', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok }, body: JSON.stringify({ issue: { start_date: '2026-10-20', due_date: '2026-10-01' } }) });
    return [res.status, res2.status, (await res2.json()).errors];
  }, SUBNUM);
  check('S9 malformed date -> 422, due before start -> 422', bad[0] === 422 && bad[1] === 422, JSON.stringify(bad));

  // S10 without a CSRF token
  const nocsrf = await page.evaluate(async (SUBNUM) => (await fetch('/vis_gantt/issues/' + SUBNUM + '/dates', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issue: { start_date: '2026-10-02', due_date: '2026-10-20' } }) })).status, SUBNUM);
  check('S10 request without CSRF token is refused', nocsrf >= 400, 'status ' + nocsrf);

  console.log(problems.join('\n') || 'no console problems');
  await page.goto(BASE + '/projects/demo/vis_gantt'); await page.waitForSelector('.vis-item'); await page.waitForTimeout(600);
  await page.screenshot({ path: SP + '/shot2.png' });
  await browser.close();
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})();
