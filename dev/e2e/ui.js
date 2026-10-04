const { launch, login, BASE } = require('./lib');
const SP = process.argv[2] || '.'; // where screenshots go
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -> ' + extra : '')); if (!ok) failed++; };
(async () => {
  // ---- Reporter: may view, may not edit
  {
    const { browser, page, problems } = await launch();
    await login(page, 'rep', 'password123');
    await page.goto(BASE + '/projects/demo/vis_gantt'); await page.waitForSelector('.vis-item'); await page.waitForTimeout(400);
    const editable = await page.evaluate(() => window.visGantt.items.get().filter(i => i.row.kind === 'issue' && i.editable).length);
    check('R1 reporter sees no draggable bars', editable === 0, `${editable} draggable`);
    const put = await page.evaluate(async () => {
      const rows = (await (await fetch('/projects/demo/vis_gantt/data', { credentials: 'same-origin' })).json()).rows;
      const id = rows.find(r => r.name === 'Plan version 2.0').issue_id;
      const tok = document.querySelector('meta[name=csrf-token]').content;
      const res = await fetch('/vis_gantt/issues/' + id + '/dates', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok }, body: JSON.stringify({ issue: { start_date: '2026-12-01', due_date: '2026-12-02' } }) });
      return res.status;
    });
    check('R2 reporter PUT is forbidden', put === 403, 'status ' + put);
    await page.screenshot({ path: SP + '/shot_rep.png' });
    await browser.close();
  }
  // ---- Admin: UI behaviours
  const { browser, page, problems } = await launch({ width: 1400, height: 900 });
  await login(page);
  await page.goto(BASE + '/projects/demo/vis_gantt'); await page.waitForSelector('.vis-item'); await page.waitForTimeout(400);

  // collapse / expand
  const rowsBefore = await page.evaluate(() => window.visGantt.groups.get().filter(g => g.visible).length);
  await page.click('text=Collapse all'); await page.waitForTimeout(300);
  const rowsCollapsed = await page.evaluate(() => window.visGantt.groups.get().filter(g => g.visible).length);
  await page.click('text=Expand all'); await page.waitForTimeout(300);
  const rowsExpanded = await page.evaluate(() => window.visGantt.groups.get().filter(g => g.visible).length);
  check('U1 collapse all hides rows, expand all restores them', rowsCollapsed < rowsBefore && rowsExpanded === rowsBefore, `${rowsBefore} -> ${rowsCollapsed} -> ${rowsExpanded}`);

  // single expander
  await page.locator('.vg-expander.vg-expanded').nth(3).click(); await page.waitForTimeout(300);
  const one = await page.evaluate(() => window.visGantt.groups.get().filter(g => g.visible).length);
  check('U2 clicking one expander collapses only its subtree', one < rowsBefore && one > rowsCollapsed, `visible rows ${one}`);
  await page.click('text=Expand all');

  // zoom in to days
  const w0 = await page.evaluate(() => { const x = window.visGantt.timeline.getWindow(); return (x.end - x.start) / 86400000; });
  await page.click('text=Zoom in'); await page.waitForTimeout(700); await page.click('text=Zoom in'); await page.waitForTimeout(900);
  await page.screenshot({ path: SP + '/shot_zoom.png' });
  const w = await page.evaluate(() => { const x = window.visGantt.timeline.getWindow(); return (x.end - x.start) / 86400000; });
  check('U3 zoom in narrows the visible window', w < w0 * 0.6, `${Math.round(w0)} -> ${Math.round(w)} days visible`);

  // double click opens the issue
  await page.click('text=Today'); await page.waitForTimeout(500);
  await page.evaluate(() => window.visGantt.timeline.fit()); await page.waitForTimeout(500);
  const target = await page.evaluate(() => { const it = window.visGantt.timeline.itemSet.items[window.visGantt.items.get().find(i => i.row.name === 'Implement UI').id]; const r = it.dom.box.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await Promise.all([page.waitForNavigation({ timeout: 8000 }).catch(() => null), page.mouse.dblclick(target.x, target.y)]);
  check('U4 double click on a bar opens the issue', /\/issues\/\d+$/.test(page.url()), page.url());

  // filters: show closed issues too
  await page.goto(BASE + '/projects/demo/vis_gantt?set_filter=1&f[]=status_id&op[status_id]=*');
  await page.waitForSelector('.vis-item'); await page.waitForTimeout(500);
  const names = await page.evaluate(() => window.visGantt.groups.get().map(g => g.row.name));
  check('F1 status filter "any" brings the closed issue in', names.includes('Design the module'), `${names.length} rows`);
  await page.evaluate(() => window.visGantt.timeline.fit()); await page.waitForTimeout(600);
  await page.screenshot({ path: SP + '/shot_all.png' });

  // global (all projects) view
  await page.goto(BASE + '/vis_gantt?set_filter=1&f[]=status_id&op[status_id]=o');
  await page.waitForSelector('.vis-item'); await page.waitForTimeout(400);
  const gp = await page.evaluate(() => window.visGantt.groups.get().filter(g => g.row.kind === 'project').map(g => g.row.name));
  check('G1 global view lists both projects', gp.includes('Demo Project') && gp.includes('Demo Subproject'), gp.join(', '));

  console.log(problems.join('\n') || 'no console problems');
  await browser.close();

  // ---- Russian locale
  {
    const { browser, page, problems } = await launch({ locale: 'ru-RU' });
    await login(page);
    await page.goto(BASE + '/my/account');
    await page.selectOption('#user_language', 'ru');
    await Promise.all([page.waitForNavigation(), page.click('input[name=commit]')]);
    await page.goto(BASE + '/projects/demo/vis_gantt'); await page.waitForSelector('.vis-item'); await page.waitForTimeout(500);
    await page.screenshot({ path: SP + '/shot_ru.png' });
    const axis = await page.locator('.vis-time-axis .vis-text.vis-minor').allInnerTexts();
    check('L1 Russian: time axis is localized', axis.some(t => /окт|ноя|дек|янв|фев|мар/i.test(t)), axis.slice(0, 6).join(' | '));
    console.log(problems.join('\n') || 'no console problems (ru)');
    // restore
    await page.goto(BASE + '/my/account'); await page.selectOption('#user_language', 'en');
    await Promise.all([page.waitForNavigation(), page.click('input[name=commit]')]);
    await browser.close();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})();
