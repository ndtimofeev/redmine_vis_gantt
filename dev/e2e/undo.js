// Undo / redo of date changes: the moved issue and everything Redmine rescheduled because of it.
const { launch, login, BASE } = require('./lib');
const { helpers } = require('./helpers');
const SP = process.argv[2] || '.';
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -> ' + extra : '')); if (!ok) failed++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const { browser, page, context, problems } = await launch({ width: 1400, height: 900 });
  await login(page);
  await page.goto(BASE + '/projects/demo/vis_gantt?set_filter=1&f[]=status_id&op[status_id]=*');
  await page.waitForSelector('.vis-item'); await page.waitForTimeout(500);
  const h = helpers(page);
  const BACKEND = await h.idOf('Implement backend'), UI = await h.idOf('Implement UI'), TEST = await h.idOf('Acceptance testing'), PLAN = await h.idOf('Plan version 2.0');
  const DUE_ONLY = await h.idOf('Issue with only a due date');

  // ---- initial state
  let undo = await h.buttonState('undo'), redo = await h.buttonState('redo');
  check('U1 undo and redo are disabled before anything was changed', undo && redo && undo.disabled && redo.disabled);

  // ---- a move that pushes followers; undo restores all of them
  const before = await h.datesById();
  const r1 = await h.drag(BACKEND, 'move', 12);
  const moved = await h.datesById();
  check('U2 the drag changed the issue and Redmine rescheduled its followers', !same(moved[BACKEND], before[BACKEND]) && !same(moved[UI], before[UI]) && !same(moved[TEST], before[TEST]), r1.toast && r1.toast.text);
  undo = await h.buttonState('undo'); redo = await h.buttonState('redo');
  check('U3 undo is enabled after a change, redo is not', undo && !undo.disabled && redo && redo.disabled, undo && undo.title);
  const hist = await h.history();
  check('U4 the history entry covers the moved issue and its followers', hist.undo === 1 && hist.redo === 0 && hist.lastChanges >= 3, JSON.stringify(hist));

  await h.clearToast(); await h.click('undo'); await h.waitToast(['ok', 'error']); await page.waitForTimeout(400);
  const undone = await h.datesById();
  check('U5 undo puts back the dates of the moved issue AND of its followers', same(undone[BACKEND], before[BACKEND]) && same(undone[UI], before[UI]) && same(undone[TEST], before[TEST]), JSON.stringify([before[UI], undone[UI]]));
  undo = await h.buttonState('undo'); redo = await h.buttonState('redo');
  check('U6 after undo: undo disabled again, redo enabled', undo.disabled && !redo.disabled);
  const shown = await page.evaluate(id => { const d = window.visGantt.items.get(id).start; return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }, BACKEND);
  check('U7 the chart shows the restored position', shown === before[BACKEND][0], shown);

  await h.clearToast(); await h.click('redo'); await h.waitToast(['ok', 'error']); await page.waitForTimeout(400);
  const redone = await h.datesById();
  check('U8 redo applies the change again, followers included', same(redone[BACKEND], moved[BACKEND]) && same(redone[UI], moved[UI]) && same(redone[TEST], moved[TEST]));

  // ---- keyboard
  await page.keyboard.press('Control+z'); await h.waitToast(['ok', 'error']); await page.waitForTimeout(400);
  check('U9 Ctrl+Z undoes', same((await h.datesById())[UI], before[UI]));
  await page.keyboard.press('Control+Shift+z'); await h.waitToast(['ok', 'error']); await page.waitForTimeout(400);
  check('U10 Ctrl+Shift+Z redoes', same((await h.datesById())[UI], moved[UI]));
  await h.click('undo'); await page.waitForTimeout(800);

  // ---- the toast offers "Undo"
  const planBefore = (await h.serverRow(PLAN)).start_date;
  await h.drag(PLAN, 'move', 6);
  const planMoved = await h.serverRow(PLAN);
  const t = await h.toast();
  const toastUndo = await page.$('#vis-gantt-toast [data-vg-action="toast-undo"]');
  check('U11 the "saved" toast has an Undo action', !!toastUndo && t && t.kind === 'ok' && planMoved.start_date !== planBefore, t && t.text);
  if (toastUndo) { await toastUndo.click(); await h.waitToast(['ok', 'error']); await page.waitForTimeout(400); }
  const planBack = await h.serverRow(PLAN);
  check('U12 the toast action undoes the change', planBack.start_date === planBefore, `${planBefore} -> ${planMoved.start_date} -> ${planBack.start_date}`);

  // ---- several steps, undone in reverse order
  const base = (await h.serverRow(PLAN)).start_date;
  await h.drag(PLAN, 'move', 5); await h.drag(PLAN, 'move', 5);
  const twice = (await h.serverRow(PLAN)).start_date;
  await h.click('undo'); await page.waitForTimeout(900);
  const once = (await h.serverRow(PLAN)).start_date;
  await h.click('undo'); await page.waitForTimeout(900);
  const none = (await h.serverRow(PLAN)).start_date;
  check('U13 two changes are undone one at a time, newest first', once !== twice && once !== base && none === base, `${base} -> ${twice} -> ${once} -> ${none}`);

  // ---- a new change after an undo discards the redo stack
  const hs = await h.history();
  await h.drag(PLAN, 'move', 3);
  check('U14 a new change clears redo', (await h.history()).redo === 0 && hs.redo >= 1);
  await h.click('undo'); await page.waitForTimeout(800);

  // ---- an issue with a single date: undo clears the date that the drag created
  const dueBefore = await h.serverRow(DUE_ONLY);
  await h.drag(DUE_ONLY, 'move', 4);
  const dueMoved = await h.serverRow(DUE_ONLY);
  await h.click('undo'); await page.waitForTimeout(900);
  const dueBack = await h.serverRow(DUE_ONLY);
  check('U15 undo restores an issue that had only a due date (start stays empty)', dueMoved.start_date !== null && dueBack.start_date === dueBefore.start_date && dueBack.due_date === dueBefore.due_date, JSON.stringify([dueBefore.start_date, dueMoved.start_date, dueBack.start_date]));

  // ---- somebody else changes the issue in the meantime: undo is refused, nothing is overwritten
  await h.drag(PLAN, 'move', 4);
  const planAfter = await h.serverRow(PLAN);
  const other = await context.newPage();
  await other.goto(BASE + '/projects/demo/vis_gantt'); await other.waitForSelector('.vis-item');
  const status = await other.evaluate(async ([row, start, due]) => {
    const tok = document.querySelector('meta[name=csrf-token]').content;
    const res = await fetch('/vis_gantt/issues/' + row.issue_id + '/dates', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok }, body: JSON.stringify({ issue: { start_date: start, due_date: due, lock_version: row.lock_version } }) });
    return res.status;
  }, [planAfter, h.addDays(planAfter.start_date, 1), h.addDays(planAfter.due_date, 1)]);
  await other.close();
  const theirs = await h.serverRow(PLAN);
  const histBefore = await h.history();
  await h.clearToast(); await h.click('undo'); await h.waitToast(['ok', 'error']); await page.waitForTimeout(500);
  const refused = await h.toast();
  const afterRefusal = await h.serverRow(PLAN);
  check('U16 undo is refused when somebody else changed the issue meanwhile', status === 200 && refused && refused.kind === 'error' && afterRefusal.start_date === theirs.start_date, refused && refused.text);
  check('U17 the refused entry is dropped', (await h.history()).undo === histBefore.undo - 1);

  // ---- reload: the stack is gone (history of the issues stays in Redmine)
  await page.reload(); await page.waitForSelector('.vis-item'); await page.waitForTimeout(400);
  check('U18 after a reload there is nothing to undo', (await h.buttonState('undo')).disabled);

  // ---- the journal of the issue records the undo as a regular change
  await page.goto(BASE + '/issues/' + (await h.serverRow(UI)).issue_id);
  const journal = await page.locator('#history').innerText();
  check('U19 the issue history shows both the change and the undo', (journal.match(/Start date changed/g) || []).length >= 2, journal.replace(/\s+/g, ' ').slice(0, 200));

  console.log(problems.filter(p => !/Failed to load resource/.test(p)).join('\n') || 'no console problems');
  await browser.close();
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})();

