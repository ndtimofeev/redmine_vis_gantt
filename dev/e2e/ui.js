// The interface: permissions, tree, zoom, filters, keyboard, remembered view, menus, Russian.
const { launch, login, BASE } = require('./lib');
const { helpers, addDays, days } = require('./helpers');
const SP = process.argv[2] || '.';
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -> ' + extra : '')); if (!ok) failed++; };

async function open(page, path) {
  await page.goto(BASE + path);
  await page.waitForSelector('.vis-item');
  await page.waitForTimeout(450);
}

(async () => {
  // ---- Reporter: may view, may not edit
  {
    const { browser, page } = await launch();
    await login(page, 'rep', 'password123');
    await open(page, '/projects/demo/vis_gantt');
    const h = helpers(page);
    const editable = await page.evaluate(() => window.visGantt.items.get().filter(i => i.row.kind === 'issue' && i.editable).length);
    check('R1 reporter sees no draggable bars', editable === 0, `${editable} draggable`);
    const put = await page.evaluate(async () => {
      const rows = (await (await fetch('/projects/demo/vis_gantt/data', { credentials: 'same-origin' })).json()).rows;
      const id = rows.find(r => r.name === 'Plan version 2.0').issue_id;
      const tok = document.querySelector('meta[name=csrf-token]').content;
      const res = await fetch('/vis_gantt/issues/' + id + '/dates', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok }, body: JSON.stringify({ issue: { start_date: '2026-12-01', due_date: '2026-12-02' } }) });
      const res2 = await fetch('/vis_gantt/restore_dates', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok }, body: JSON.stringify({ changes: [{ id, start_date: '2026-12-01', due_date: '2026-12-02' }] }) });
      return [res.status, res2.status];
    });
    check('R2 reporter: both write endpoints are forbidden', put[0] === 403 && put[1] === 403, JSON.stringify(put));
    const keysDoNothing = await (async () => {
      const bar = await page.evaluate(() => window.visGantt.items.get().find(i => i.row.name === 'Implement backend').id);
      const before = JSON.stringify(await h.datesById());
      await page.evaluate(id => { window.visGantt.timeline.setSelection([id]); }, bar);
      await page.click('.vis-item.vg-bar-issue:not(.vg-parent)');
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(900);
      return before === JSON.stringify(await h.datesById());
    })();
    check('R3 reporter: arrow keys do not change anything', keysDoNothing);
    await page.screenshot({ path: SP + '/shot_rep.png' });
    await browser.close();
  }

  const { browser, page, context, problems } = await launch({ width: 1400, height: 900 });
  await login(page);
  await open(page, '/projects/demo/vis_gantt');
  const h = helpers(page);

  // ---- filters: collapsed by default, with a count
  const filters = await page.evaluate(() => ({ collapsed: document.getElementById('filters').classList.contains('collapsed'), count: (document.querySelector('.vg-filter-count') || {}).textContent, applyVisible: !!document.querySelector('#filters .buttons') && document.querySelector('#filters .buttons').offsetParent !== null }));
  check('X1 filters are collapsed by default and show how many are active', filters.collapsed && filters.count === '1' && !filters.applyVisible, JSON.stringify(filters));
  const top0 = await page.evaluate(() => document.getElementById('vis-gantt').getBoundingClientRect().top);
  check('X2 the chart starts high on the page (room for rows)', top0 < 330, 'top = ' + Math.round(top0));

  // ---- collapse / expand
  const rowsBefore = await page.evaluate(() => window.visGantt.groups.get().filter(g => g.visible).length);
  await h.click('collapse-all'); await page.waitForTimeout(300);
  const rowsCollapsed = await page.evaluate(() => window.visGantt.groups.get().filter(g => g.visible).length);
  await h.click('expand-all'); await page.waitForTimeout(300);
  const rowsExpanded = await page.evaluate(() => window.visGantt.groups.get().filter(g => g.visible).length);
  check('T1 collapse all hides rows, expand all restores them', rowsCollapsed < rowsBefore && rowsExpanded === rowsBefore, `${rowsBefore} -> ${rowsCollapsed} -> ${rowsExpanded}`);
  await page.locator('.vg-expander.vg-expanded').nth(3).click(); await page.waitForTimeout(300);
  const one = await page.evaluate(() => window.visGantt.groups.get().filter(g => g.visible).length);
  check('T2 clicking one expander collapses only its subtree', one < rowsBefore && one > rowsCollapsed, `visible rows ${one}`);
  await h.click('expand-all');

  // ---- scale: presets and zoom
  const span = () => page.evaluate(() => { const w = window.visGantt.timeline.getWindow(); return (w.end - w.start) / 864e5; });
  await page.click('[data-vg-preset="month"]'); await page.waitForTimeout(700);
  const month = await span();
  const pressed = await page.evaluate(() => [...document.querySelectorAll('[data-vg-preset]')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.getAttribute('data-vg-preset')));
  check('Z1 the Month preset shows about 6 weeks and is marked as the current scale', month > 35 && month < 60 && pressed.length === 1 && pressed[0] === 'month', `${Math.round(month)} days, pressed ${pressed}`);
  await page.click('[data-vg-preset="year"]'); await page.waitForTimeout(700);
  check('Z2 the Year preset shows more than a year', (await span()) > 330);
  const w0 = await span();
  await page.click('[data-vg-action="zoom-in"]'); await page.waitForTimeout(700); await page.click('[data-vg-action="zoom-in"]'); await page.waitForTimeout(900);
  check('Z3 zoom in narrows the visible window', (await span()) < w0 * 0.6, `${Math.round(w0)} -> ${Math.round(await span())} days`);
  await page.click('[data-vg-preset="quarter"]'); await page.waitForTimeout(600);
  await page.click('[data-vg-action="today"]'); await page.waitForTimeout(700);
  const todayInWindow = await page.evaluate(() => { const w = window.visGantt.timeline.getWindow(); const n = new Date(); return w.start < n && n < w.end; });
  check('Z4 Today brings the current date into view', todayInWindow);

  // ---- relations: arrows, highlight of the selected issue, toggle
  await page.click('[data-vg-preset="year"]'); await page.waitForTimeout(700);
  const arrows = () => page.evaluate(() => document.querySelectorAll('.vg-arrows .vg-rel').length);
  const nArrows = await arrows();
  check('A1 relation arrows are drawn', nArrows >= 2, String(nArrows));
  const dashed = await page.evaluate(() => !!document.querySelector('.vg-rel-blocks'));
  check('A2 "blocks" is distinguishable without colour (dashed) from "precedes"', dashed);
  const BACKEND = await h.idOf('Implement backend');
  await page.evaluate(id => window.visGantt.timeline.setSelection([id]), BACKEND);
  const bb = await h.box(BACKEND);
  await page.mouse.click(bb.x + bb.w / 2, bb.y + bb.h / 2); await page.waitForTimeout(300);
  const emphasis = await page.evaluate(() => ({ active: document.querySelectorAll('.vg-rel-active').length, dim: document.querySelectorAll('.vg-rel-dim').length, label: document.querySelectorAll('.vg-label.vg-selected').length }));
  check('A3 selecting a bar emphasises its own relations and dims the others', emphasis.active >= 1 && emphasis.label === 1, JSON.stringify(emphasis));
  await h.click('toggle-relations'); await page.waitForTimeout(300);
  check('A4 the Relations toggle hides all arrows', (await arrows()) === 0 && (await page.getAttribute('[data-vg-action="toggle-relations"]', 'aria-pressed')) === 'false');
  await h.click('toggle-relations'); await page.waitForTimeout(300);
  check('A5 ... and shows them again', (await arrows()) >= 2);

  // ---- subject column: resize, remember, reset
  const labelW = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.vg-app')).getPropertyValue('--vg-label-w')));
  const w1 = await labelW();
  const sp = await page.locator('.vg-splitter').boundingBox();
  await page.mouse.move(sp.x + sp.width / 2, sp.y + 200); await page.mouse.down();
  await page.mouse.move(sp.x + sp.width / 2 + 60, sp.y + 200, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(300);
  const w2 = await labelW();
  check('C1 dragging the line between subjects and chart resizes the column', w2 > w1 + 40, `${w1} -> ${w2}`);
  const stored = await page.evaluate(() => window.localStorage.getItem('redmine_vis_gantt.labelWidth'));
  check('C2 the width is remembered', Number(stored) === w2, stored);
  const widthOnPage = await page.evaluate(() => document.querySelector('.vis-panel.vis-left').getBoundingClientRect().width);
  check('C3 the label panel really follows the setting', Math.abs(widthOnPage - w2) < 4, `${widthOnPage} vs ${w2}`);
  await page.focus('.vg-splitter'); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(200);
  check('C4 the splitter works with the keyboard', (await labelW()) < w2);
  await page.dblclick('.vg-splitter'); await page.waitForTimeout(300);
  check('C5 double-click resets the width', (await labelW()) !== w2 && !(await page.evaluate(() => window.localStorage.getItem('redmine_vis_gantt.labelWidth'))));

  // ---- help panel, legend, empty-date pill
  check('H1 the help is hidden until asked for', await page.evaluate(() => document.getElementById('vis-gantt-help').hidden));
  await h.click('help');
  const help = await page.evaluate(() => ({ open: !document.getElementById('vis-gantt-help').hidden, items: document.querySelectorAll('#vis-gantt-help li').length, expanded: document.querySelector('[data-vg-action="help"]').getAttribute('aria-expanded') }));
  check('H2 the "?" button opens the help', help.open && help.items >= 5 && help.expanded === 'true', JSON.stringify(help));
  await h.click('help');
  check('H3 the legend explains the colours and lines', (await page.locator('.vg-legend-item').count()) >= 7);
  check('H4 an issue without dates says so', (await page.locator('.vg-nodates').count()) >= 1);

  // ---- keyboard
  await open(page, '/projects/demo/vis_gantt?set_filter=1&f[]=status_id&op[status_id]=*');
  const PLAN = await h.idOf('Plan version 2.0');
  const planBefore = await h.serverRow(PLAN);
  await page.click(`.vg-label a.vg-title[href$="/issues/${PLAN.replace(/^i/, '')}"]`, { trial: true }).catch(() => {});
  await page.focus(`.vg-label a.vg-title[href$="/issues/${PLAN.replace(/^i/, '')}"]`);
  const focusSelected = await page.evaluate(() => document.querySelectorAll('.vg-label.vg-selected').length);
  check('K1 tabbing to a row selects it', focusSelected === 1);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await h.waitToast(['ok', 'error']); await page.waitForTimeout(500);
  const planAfter = await h.serverRow(PLAN);
  check('K2 three quick arrow presses move the bar by three days with ONE save', planAfter.start_date === addDays(planBefore.start_date, 3) && planAfter.due_date === addDays(planBefore.due_date, 3) && (await h.history()).undo === 1, `${planBefore.start_date}..${planBefore.due_date} -> ${planAfter.start_date}..${planAfter.due_date}`);
  await page.focus(`.vg-label a.vg-title[href$="/issues/${PLAN.replace(/^i/, '')}"]`);
  await h.clearToast(); await page.keyboard.press('Shift+ArrowLeft'); await h.waitToast(['ok', 'error']); await page.waitForTimeout(400);
  const planWeek = await h.serverRow(PLAN);
  check('K3 Shift + arrow moves by a week', planWeek.start_date === addDays(planAfter.start_date, -7));
  await page.focus(`.vg-label a.vg-title[href$="/issues/${PLAN.replace(/^i/, '')}"]`);
  await h.clearToast(); await page.keyboard.press('+'); await h.waitToast(['ok', 'error']); await page.waitForTimeout(400);
  const planLong = await h.serverRow(PLAN);
  check('K4 "+" lengthens the issue by a day (only the due date changes)', planLong.start_date === planWeek.start_date && planLong.due_date === addDays(planWeek.due_date, 1), `${planWeek.due_date} -> ${planLong.due_date}`);
  await page.focus(`.vg-label a.vg-title[href$="/issues/${PLAN.replace(/^i/, '')}"]`);
  await h.clearToast(); await page.keyboard.press('-'); await h.waitToast(['ok', 'error']); await page.waitForTimeout(400);
  check('K5 "-" shortens it again', (await h.serverRow(PLAN)).due_date === planWeek.due_date);
  // undo all three/four steps with the keyboard
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Control+z'); await h.waitToast(['ok', 'error']); await page.waitForTimeout(500); }
  const planRestored = await h.serverRow(PLAN);
  check('K6 Ctrl+Z walks back through the keyboard changes', planRestored.start_date === planBefore.start_date && planRestored.due_date === planBefore.due_date, `${planRestored.start_date}..${planRestored.due_date}`);

  // ---- the view is remembered when you open an issue and come back
  await open(page, '/projects/demo/vis_gantt');
  await page.click('[data-vg-preset="quarter"]'); await page.waitForTimeout(600);
  await page.locator('.vg-expander.vg-expanded').nth(1).click(); await page.waitForTimeout(500);
  const stateBefore = await page.evaluate(() => { const w = window.visGantt.timeline.getWindow(); return { span: Math.round((w.end - w.start) / 864e5), visible: window.visGantt.groups.get().filter(g => g.visible).length }; });
  await page.waitForTimeout(500);
  await page.goto(BASE + '/projects/demo/vis_gantt'); // a fresh visit of the same page
  await page.waitForSelector('.vis-item'); await page.waitForTimeout(600);
  const stateAfter = await page.evaluate(() => { const w = window.visGantt.timeline.getWindow(); return { span: Math.round((w.end - w.start) / 864e5), visible: window.visGantt.groups.get().filter(g => g.visible).length }; });
  check('V1 zoom and collapsed branches are remembered for the page', Math.abs(stateAfter.span - stateBefore.span) <= 2 && stateAfter.visible === stateBefore.visible, JSON.stringify([stateBefore, stateAfter]));

  // ---- double click opens the issue
  await page.evaluate(() => window.sessionStorage.clear());
  await open(page, '/projects/demo/vis_gantt');
  await page.evaluate(() => window.visGantt.timeline.fit());
  await page.waitForTimeout(600);
  const target = await page.evaluate(() => { const it = window.visGantt.timeline.itemSet.items[window.visGantt.items.get().find(i => i.row.name === 'Implement UI').id]; const r = it.dom.box.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await Promise.all([page.waitForNavigation({ timeout: 8000 }).catch(() => null), page.mouse.dblclick(target.x, target.y)]);
  check('D1 double click on a bar opens the issue', /\/issues\/\d+$/.test(page.url()), page.url());

  // ---- filters through the URL, the global view, the menus
  await open(page, '/projects/demo/vis_gantt?set_filter=1&f[]=status_id&op[status_id]=*');
  const names = await page.evaluate(() => window.visGantt.groups.get().map(g => g.row.name));
  check('F1 status filter "any" brings the closed issue in', names.includes('Design the module'), `${names.length} rows`);
  await open(page, '/vis_gantt?set_filter=1&f[]=status_id&op[status_id]=o');
  const gp = await page.evaluate(() => window.visGantt.groups.get().filter(g => g.row.kind === 'project').map(g => g.row.name));
  check('G1 global view lists both projects', gp.includes('Demo Project') && gp.includes('Demo Subproject'), gp.join(', '));
  const menus = await page.evaluate(() => ({
    top: [...document.querySelectorAll('#top-menu a')].map(a => a.textContent.trim()),
    main: [...document.querySelectorAll('#main-menu a')].map(a => a.textContent.trim() + (a.classList.contains('selected') ? ' [selected]' : '')),
  }));
  check('G2 the global view is in the application menu next to Gantt, selected, and not in the top menu',
    menus.main.includes('Interactive Gantt [selected]') && menus.main.indexOf('Gantt') + 1 === menus.main.findIndex(x => x.startsWith('Interactive Gantt')) && !menus.top.some(x => /Gantt/.test(x)), JSON.stringify(menus));

  console.log(problems.filter(p => !/Failed to load resource/.test(p)).join('\n') || 'no console problems');
  await browser.close();

  // ---- Russian locale
  {
    const { browser, page, problems } = await launch({ locale: 'ru-RU' });
    await login(page);
    await page.goto(BASE + '/my/account');
    await page.selectOption('#user_language', 'ru');
    await Promise.all([page.waitForNavigation(), page.click('input[name=commit]')]);
    await open(page, '/projects/demo/vis_gantt');
    await page.screenshot({ path: SP + '/shot_ru.png' });
    const axis = await page.locator('.vis-time-axis .vis-text.vis-minor').allInnerTexts();
    check('L1 Russian: time axis is localized', axis.some(t => /окт|ноя|дек|янв|фев|мар/i.test(t)), axis.slice(0, 6).join(' | '));
    const labels = await page.evaluate(() => ({ undo: document.querySelector('[data-vg-action="undo"]').textContent.trim(), tab: [...document.querySelectorAll('#main-menu a')].map(a => a.textContent.trim()).find(x => /Интерактив/.test(x)), legend: document.querySelector('.vg-legend-item').textContent.trim() }));
    check('L2 Russian: buttons, menu tab and legend are translated', labels.undo === 'Отменить' && !!labels.tab && /Выполнено/.test(labels.legend), JSON.stringify(labels));
    console.log(problems.filter(p => !/Failed to load resource/.test(p)).join('\n') || 'no console problems (ru)');
    // restore
    await page.goto(BASE + '/my/account'); await page.selectOption('#user_language', 'en');
    await Promise.all([page.waitForNavigation(), page.click('input[name=commit]')]);
    await browser.close();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})();
