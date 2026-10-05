// Shared helpers for the browser scenarios. The page contract they rely on:
//   buttons:  [data-vg-action="undo" | "redo" | "zoom-in" | "zoom-out" | "today" | "fit" | "expand-all" | "collapse-all" | "toggle-relations"]
//   toast:    #vis-gantt-toast[data-kind="ok" | "error" | "progress"] with .vg-toast-message and [data-vg-action="toast-undo"]
//   chart:    window.visGantt = { timeline, items, groups, reload, history() }
const { BASE } = require('./lib');

const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

function helpers(page, project = 'demo') {
  const dataUrl = `/projects/${project}/vis_gantt/data`;
  const h = {
    addDays, days,
    allRows: () => page.evaluate(async url => (await (await fetch(url, { credentials: 'same-origin' })).json()).rows, dataUrl),
    idOf: async name => (await h.allRows()).find(r => r.name === name).id,
    serverRow: async id => (await h.allRows()).find(r => r.id === id),
    // the dates as stored on the issues, by issue id
    datesById: async () => Object.fromEntries((await h.allRows()).filter(r => r.kind === 'issue').map(r => [r.id, [r.start_date, r.due_date]])),
    box: id => page.evaluate(id => {
      const it = window.visGantt.timeline.itemSet.items[id];
      if (!it || !it.dom || !it.dom.box) return null;
      const r = it.dom.box.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, id),
    toast: () => page.evaluate(() => { const t = document.getElementById('vis-gantt-toast'); return t ? { kind: t.getAttribute('data-kind'), text: (t.querySelector('.vg-toast-message') || t).innerText.trim(), visible: !t.hidden } : null; }),
    clearToast: () => page.evaluate(() => { const t = document.getElementById('vis-gantt-toast'); if (t) { t.setAttribute('data-kind', ''); t.hidden = true; } }),
    waitToast: kinds => page.waitForFunction(k => { const t = document.getElementById('vis-gantt-toast'); return t && !t.hidden && k.includes(t.getAttribute('data-kind')); }, kinds, { timeout: 8000 }).catch(() => {}),
    history: () => page.evaluate(() => window.visGantt.history()),
    buttonState: action => page.evaluate(a => { const b = document.querySelector(`[data-vg-action="${a}"]`); return b ? { disabled: b.getAttribute('aria-disabled') === 'true', title: b.title } : null; }, action),
    click: action => page.click(`[data-vg-action="${action}"]`),
    // Drags a bar. mode: 'move' | 'left' | 'right'. vis-timeline (Hammer.js) ignores the first ~10px of a drag.
    async drag(id, mode, dxDays) {
      const row = await h.serverRow(id);
      const b = await h.box(id);
      const pxPerDay = b.w / (days(row.start, row.due) + 1);
      const y = b.y + b.h / 2;
      const x0 = mode === 'move' ? b.x + b.w / 2 : mode === 'left' ? b.x + 2 : b.x + b.w - 2;
      await h.clearToast();
      await page.mouse.move(x0, y);
      await page.mouse.down();
      const dx = dxDays * pxPerDay + Math.sign(dxDays) * 10;
      for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + dx * i / 8, y);
      await page.mouse.up();
      await h.waitToast(['ok', 'error']);
      await page.waitForTimeout(400);
      return { row, toast: await h.toast() };
    },
  };
  return h;
}

module.exports = { helpers, addDays, days, BASE };
