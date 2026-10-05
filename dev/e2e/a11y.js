// The strip with the selected row's dates, the keyboard model of the row list, announcements and the
// small design contracts (theming tokens, print, disabled buttons).
const { launch, login, BASE } = require('./lib');
const { helpers, addDays } = require('./helpers');
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -> ' + extra : '')); if (!ok) failed++; };

async function open(page, path) {
  await page.goto(BASE + path);
  await page.waitForSelector('.vis-item');
  await page.waitForTimeout(450);
}

const ANY = '?set_filter=1&f[]=status_id&op[status_id]=*';

(async () => {
  const { browser, page, problems } = await launch();
  await login(page);
  await open(page, '/projects/demo/vis_gantt' + ANY);
  const h = helpers(page);
  const strip = () => page.evaluate(() => {
    const d = document.getElementById('vis-gantt-details');
    return {
      text: d.innerText.trim(),
      inputs: [...d.querySelectorAll('input[type=date]')].map(i => ({ name: i.name, value: i.value, disabled: i.disabled })),
      apply: !!d.querySelector('button[type=submit]'),
      region: d.getAttribute('role') + ':' + d.getAttribute('aria-label'),
    };
  });

  // ---- details strip
  let d = await strip();
  check('D1 nothing selected: the strip says what it is for', /Select a row or a bar/.test(d.text) && d.inputs.length === 0, d.text);
  check('D2 the strip is a labelled region', d.region === 'region:Selected row', d.region);

  const id = await h.idOf('Implement backend');
  const before = await h.serverRow(id);
  const b = await h.box(id);
  await page.mouse.click(b.x + b.w * 0.6, b.y + b.h / 2);
  await page.waitForTimeout(300);
  d = await strip();
  check('D3 selecting a bar shows the issue with its start and due date', d.text.includes('Implement backend') &&
    d.inputs.length === 2 && d.inputs[0].value === before.start_date && d.inputs[1].value === before.due_date && d.apply, JSON.stringify(d.inputs));

  // typing the dates saves them exactly like a drag, with the same history entry and the same undo
  const newStart = addDays(before.start_date, 2), newDue = addDays(before.due_date, 2);
  await page.fill('#vis-gantt-details input[name=start_date]', newStart);
  await page.fill('#vis-gantt-details input[name=due_date]', newDue);
  await h.clearToast();
  await page.click('#vis-gantt-details button[type=submit]');
  await h.waitToast(['ok', 'error']);
  const after = await h.serverRow(id);
  check('D4 Apply saves the typed dates', after.start_date === newStart && after.due_date === newDue, `${after.start_date}..${after.due_date}`);
  d = await strip();
  check('D5 the strip shows the saved dates and the bar moved', d.inputs[0].value === newStart &&
    (await page.evaluate(i => window.visGantt.items.get(i).start.getDate(), id)) === +newStart.slice(8), JSON.stringify(d.inputs));
  check('D6 the change is on the undo stack', (await h.history()).undo === 1);
  await page.click('[data-vg-action="undo"]');
  await h.waitToast(['ok', 'error']);
  await page.waitForTimeout(400);
  const undone = await h.serverRow(id);
  check('D7 undo puts the old dates back, the strip follows', undone.start_date === before.start_date && undone.due_date === before.due_date &&
    (await strip()).inputs[0].value === before.start_date);

  // an invalid range is reported by the server and nothing changes
  await page.fill('#vis-gantt-details input[name=start_date]', addDays(before.due_date, 5));
  await h.clearToast();
  await page.click('#vis-gantt-details button[type=submit]');
  await h.waitToast(['error']);
  const t = await h.toast();
  check('D8 start after due: an error, nothing saved', t.kind === 'error' && (await h.serverRow(id)).start_date === before.start_date, t.text);

  // a parent with derived dates and a project have no date fields
  const parentId = await h.idOf('Documentation');
  const pb = await h.box(parentId);
  await page.mouse.click(pb.x + pb.w * 0.5, pb.y + pb.h / 2);
  await page.waitForTimeout(300);
  d = await strip();
  check('D9 a parent with derived dates shows them read-only', d.inputs.length === 0 && /Dates are derived/.test(d.text) && /→/.test(d.text), d.text);

  // ---- the row list is a tree with one tab stop
  const tree = await page.evaluate(() => ({
    role: document.querySelector('#vis-gantt .vis-labelset').getAttribute('role'),
    items: document.querySelectorAll('#vis-gantt [role=treeitem]').length,
    stops: [...document.querySelectorAll('#vis-gantt .vg-title')].filter(a => a.tabIndex === 0).length,
    levels: [...new Set([...document.querySelectorAll('#vis-gantt [role=treeitem]')].map(e => e.getAttribute('aria-level')))].sort().join(','),
    expanded: [...document.querySelectorAll('#vis-gantt [role=treeitem][aria-expanded]')].length,
  }));
  check('K1 rows are tree items with levels and ONE tab stop', tree.role === 'tree' && tree.items >= 10 && tree.stops === 1 && /1,2,3/.test(tree.levels) && tree.expanded >= 3, JSON.stringify(tree));

  await page.focus('#vis-gantt .vg-title[tabindex="0"]');
  const sel = () => page.evaluate(() => { const s = document.querySelector('#vis-gantt .vg-label.vg-selected'); return s ? s.querySelector('.vg-subject').textContent : null; });
  await page.keyboard.press('Home');
  const first = await sel();
  await page.keyboard.press('ArrowDown');
  const second = await sel();
  await page.keyboard.press('End');
  const last = await sel();
  await page.keyboard.press('ArrowUp');
  const beforeLast = await sel();
  check('K2 Home / Down / End / Up move the selection through the rows', first === 'Demo Project' && second && second !== first && last && beforeLast && last !== beforeLast, [first, second, last, beforeLast].join(' | '));
  check('K3 the focus follows the selection (and is the only tab stop)', await page.evaluate(() => {
    const a = document.activeElement; const s = document.querySelector('#vis-gantt .vg-label.vg-selected .vg-title');
    return a === s && s.tabIndex === 0 && document.querySelectorAll('#vis-gantt .vg-title[tabindex="0"]').length === 1;
  }));
  check('K4 aria-selected follows too', await page.evaluate(() => document.querySelectorAll('#vis-gantt [role=treeitem][aria-selected=true]').length) === 1);

  // Space folds a parent
  const visibleRows = () => page.evaluate(() => window.visGantt.groups.get().filter(g => g.visible).length);
  const rowsBefore = await visibleRows();
  await page.focus('#vis-gantt .vg-title[tabindex="0"]');
  while ((await sel()) !== 'Documentation') await page.keyboard.press('ArrowUp');
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);
  const rowsFolded = await visibleRows();
  const expandedAttr = await page.evaluate(() => document.querySelector('#vis-gantt .vg-label.vg-selected').getAttribute('aria-expanded'));
  check('K5 Space folds the selected parent', rowsFolded === rowsBefore - 2 && expandedAttr === 'false', `${rowsBefore} -> ${rowsFolded}, aria-expanded=${expandedAttr}`);
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);
  check('K6 Space unfolds it again', (await visibleRows()) === rowsBefore);

  // ---- messages are announced, and Escape closes the toast
  await page.evaluate(i => window.visGantt.timeline.setSelection([i]), id);
  const live = await page.evaluate(() => { const l = document.querySelector('.vg-stage > [aria-live]'); return l ? l.getAttribute('role') + '/' + l.getAttribute('aria-live') : null; });
  check('M1 there is a polite live region', live === 'status/polite', live);
  await h.drag(id, 'move', 1);
  await page.waitForTimeout(250);
  const said = await page.evaluate(() => document.querySelector('.vg-stage > [aria-live]').textContent);
  check('M2 a saved change is announced', said === 'Dates saved', said);
  await page.mouse.move(5, 5);
  await page.keyboard.press('Escape');
  check('M3 Escape closes the toast', (await h.toast()).visible === false);
  await page.click('[data-vg-action="undo"]');
  await h.waitToast(['ok']);

  // ---- buttons that cannot act are aria-disabled, not removed from the tab order
  const undo = await page.evaluate(() => { const b = document.querySelector('[data-vg-action="undo"]'); return { aria: b.getAttribute('aria-disabled'), disabled: b.disabled, tab: b.tabIndex }; });
  check('B1 Undo is aria-disabled (focusable) when there is nothing to undo', undo.aria === 'true' && !undo.disabled && undo.tab === 0, JSON.stringify(undo));
  await page.click('[data-vg-action="undo"]', { force: true }); // Playwright treats aria-disabled as "not enabled"
  check('B2 clicking a disabled Undo does nothing', (await h.toast()).visible === false || (await h.toast()).kind !== 'progress');

  // ---- hover highlights the row in both panels
  const row = await page.evaluate(i => { const r = window.visGantt.timeline.itemSet.items[i].dom.box.getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2 }; }, id);
  await page.mouse.move(row.x + 30, row.y);
  await page.waitForTimeout(200);
  const hover = await page.evaluate(() => document.querySelectorAll('#vis-gantt .vg-hover').length);
  check('H1 the row under the pointer is highlighted in the labels and in the chart', hover === 2, String(hover));

  // ---- the design tokens can be overridden by a theme
  await page.addStyleTag({ content: '.vg-app { --vg-accent: rgb(1, 2, 3); --vg-done-bg: rgb(4, 5, 6); }' });
  const tokens = await page.evaluate(() => {
    const app = document.querySelector('.vg-app');
    return [getComputedStyle(app).getPropertyValue('--vg-accent').trim(), getComputedStyle(app).getPropertyValue('--vg-done-bg').trim()];
  });
  check('T1 a theme overrides the tokens with a zero-specificity rule beaten by any later rule', tokens[0] === 'rgb(1, 2, 3)' && tokens[1] === 'rgb(4, 5, 6)', tokens.join(' / '));

  // ---- print: only the chart and the legend
  await page.emulateMedia({ media: 'print' });
  const print = await page.evaluate(() => ['vis-gantt-toolbar', 'vis-gantt-details', 'vis-gantt-help', 'vis-gantt-toast'].map(i => { const e = document.getElementById(i); return e ? getComputedStyle(e).display : 'missing'; }).concat(getComputedStyle(document.getElementById('vis-gantt-legend')).display));
  check('P1 printing hides the toolbar, the strip and the help, keeps the legend', print.slice(0, 3).every(v => v === 'none') && print[4] === 'flex', print.join(','));
  await page.emulateMedia({ media: 'screen' });

  // (the 422 is the deliberate invalid range of D8)
  const unexpected = problems.filter(p => !/status of 422/.test(p));
  check('N1 no console problems', unexpected.length === 0, unexpected.join(' | '));

  // ---- a reporter gets the strip without date fields
  await browser.close();
  const rep = await launch();
  await login(rep.page, 'rep', 'password123');
  await open(rep.page, '/projects/demo/vis_gantt' + ANY);
  const rb = await helpers(rep.page).box(await helpers(rep.page).idOf('Implement backend'));
  await rep.page.mouse.click(rb.x + rb.w * 0.6, rb.y + rb.h / 2);
  await rep.page.waitForTimeout(300);
  const rd = await rep.page.evaluate(() => { const d = document.getElementById('vis-gantt-details'); return { inputs: d.querySelectorAll('input').length, text: d.innerText.trim() }; });
  check('D10 a user who may not edit sees the dates read-only', rd.inputs === 0 && /You cannot change the dates/.test(rd.text) && /→/.test(rd.text), rd.text);
  await rep.browser.close();

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})();
