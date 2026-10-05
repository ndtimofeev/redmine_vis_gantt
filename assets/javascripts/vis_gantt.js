/*
 * Interactive Gantt chart for Redmine on top of vis-timeline.
 *
 * The server sends a flat list of rows (projects, versions, issues, in the order the
 * built-in Gantt draws them). Every row becomes a vis-timeline "group" (the left column)
 * and, if it has dates, an "item" (the bar).
 *
 * Moving or resizing the bar of an issue saves the new dates through
 * PUT /vis_gantt/issues/:id/dates and reloads the chart, because Redmine may have
 * rescheduled other issues (followers, parents with derived dates, version/project bars).
 * By comparing the chart before and after, the script knows everything that changed,
 * which is what Undo / Redo put back (PUT /vis_gantt/restore_dates, all or nothing).
 */
(function () {
  'use strict';

  var DAY = 24 * 60 * 60 * 1000;
  var HISTORY_LIMIT = 50;
  var LABEL_WIDTH_KEY = 'redmine_vis_gantt.labelWidth';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // The script is included in <head>, so wait for the page before looking for the container.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Shows a message in place of the chart. Used for failures that would otherwise leave the page empty.
  function showFailure(root, message) {
    while (root.firstChild) { root.removeChild(root.firstChild); }
    var box = document.createElement('div');
    box.className = 'flash error';
    box.setAttribute('role', 'alert');
    box.textContent = message;
    root.appendChild(box);
    if (window.console) { console.error('[redmine_vis_gantt] ' + message); }
  }

  function start() {
    var root = document.getElementById('vis-gantt');
    if (!root) { return; }

    var config;
    try {
      config = JSON.parse(root.getAttribute('data-config'));
    } catch (e) {
      showFailure(root, 'redmine_vis_gantt: cannot read the chart configuration: ' + e.message);
      return;
    }

    if (typeof vis === 'undefined') {
      showFailure(root, config.i18n.libraryMissing);
      return;
    }
    // From here on the script is running: drop the "loading" placeholder.
    while (root.firstChild) { root.removeChild(root.firstChild); }

    // Anything that goes wrong while setting up must be visible, not an empty page.
    try {
      run(root, config);
    } catch (e) {
      showFailure(root, config.i18n.scriptFailed.replace('%{message}', e && e.message ? e.message : String(e)));
      throw e; // keep the stack trace in the console
    }
  }

  function run(root, config) {
    var t = config.i18n;
    var app = root.closest('.vg-app') || root.parentNode;
    var stage = root.closest('.vg-stage') || root.parentNode;

    var rowsById = {};
    var rowOrder = [];
    var relations = [];
    var collapsed = {};
    var showRelations = true;
    var selectedId = null;
    var timeline = null;
    var groups = new vis.DataSet();
    var items = new vis.DataSet();
    var busy = false;
    var undoStack = [];
    var redoStack = [];
    var toastEl, toastIcon, toastMessage, toastUndo, toastTimer, toastHover, chipEl, liveEl;
    var buttons = {};
    var labelEls = {};
    var linkEls = {};
    var pendingNudge = null;
    var detailsEl = null;
    var detailsSignature = null;
    var stateKey = 'redmine_vis_gantt.state:' + window.location.pathname + window.location.search;
    var coarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // vis-timeline animation options: none when the user asks for less motion.
    function anim(duration) { return reduceMotion ? false : { duration: duration }; }

    // ---------------------------------------------------------------- dates

    // 'YYYY-MM-DD' -> local midnight. (new Date('YYYY-MM-DD') would be UTC.)
    function parseDay(str) {
      var p = str.split('-');
      return new Date(+p[0], +p[1] - 1, +p[2]);
    }

    function addDays(date, n) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    // Date -> 'YYYY-MM-DD' of the nearest local midnight, so that a one hour
    // drift around DST changes cannot move a bar to the neighbouring day.
    function formatDay(date) {
      var d = new Date(date.getTime() + DAY / 2);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function snapDay(date) {
      var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      return date.getHours() >= 12 ? addDays(d, 1) : d;
    }

    function dayDiff(a, b) { return Math.round((a - b) / DAY); }

    var dateFormat = (function () {
      try {
        return new Intl.DateTimeFormat(config.locale || undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      } catch (e) {
        return null;
      }
    })();

    // 'YYYY-MM-DD' -> '12 Oct 2026' in the user's language.
    function niceDate(str) {
      return dateFormat ? dateFormat.format(parseDay(str)) : str;
    }

    // ------------------------------------------------------------- helpers

    function el(tag, className, text) {
      var e = document.createElement(tag);
      if (className) { e.className = className; }
      if (text != null) { e.textContent = text; }
      return e;
    }

    function svgEl(tag, attributes) {
      var node = document.createElementNS(SVG_NS, tag);
      Object.keys(attributes || {}).forEach(function (key) { node.setAttribute(key, attributes[key]); });
      return node;
    }

    function esc(str) {
      return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function csrfToken() {
      var meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.getAttribute('content') : '';
    }

    function fmt(template, values) {
      return String(template).replace(/%\{(\w+)\}/g, function (m, key) { return values[key] != null ? values[key] : m; });
    }

    function storageGet(key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }

    function storageSet(key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) { /* private mode etc. */ }
    }

    // The view (zoom window, collapsed branches) survives opening an issue and coming back.
    function loadState() {
      try {
        var raw = window.sessionStorage.getItem(stateKey);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }

    var saveTimer = null;
    function saveState() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        if (!timeline) { return; }
        var w = timeline.getWindow();
        var ids = Object.keys(collapsed).filter(function (id) { return collapsed[id]; });
        try {
          window.sessionStorage.setItem(stateKey, JSON.stringify({ start: w.start.getTime(), end: w.end.getTime(), collapsed: ids }));
        } catch (e) { /* storage full or disabled */ }
      }, 300);
    }

    // ---------------------------------------------------------------- icons

    // 20x20 line icons (stroke = currentColor).
    var ICONS = {
      undo: 'M8 5L4 9l4 4M4 9h8a4 4 0 0 1 0 8H8',
      redo: 'M12 5l4 4-4 4M16 9H8a4 4 0 0 0 0 8h4',
      'zoom-in': 'M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM13 13l4 4M9 6.5v5M6.5 9h5',
      'zoom-out': 'M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM13 13l4 4M6.5 9h5',
      fit: 'M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4',
      'expand-all': 'M5 4l5 5 5-5M5 11l5 5 5-5',
      'collapse-all': 'M5 9l5-5 5 5M5 16l5-5 5 5',
      relations: 'M8 12l4-4M9.5 6.5l1-1a3 3 0 0 1 4.2 4.2l-1 1M10.5 13.5l-1 1a3 3 0 0 1-4.2-4.2l1-1',
      close: 'M5 5l10 10M15 5L5 15',
      check: 'M4.5 10.5l3.5 3.5 7.5-8'
    };

    function icon(name) {
      var svg = svgEl('svg', { viewBox: '0 0 20 20', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false', 'class': 'vg-icon' });
      svg.appendChild(svgEl('path', { d: ICONS[name], fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      return svg;
    }

    // ---------------------------------------------------------------- rows

    function isVisible(row) {
      var parent = rowsById[row.parent];
      while (parent) {
        if (collapsed[parent.id]) { return false; }
        parent = rowsById[parent.parent];
      }
      return true;
    }

    function hasChildren(row) { return !!row.hasChildren; }

    function rowTitle(row) {
      return row.kind === 'issue' ? row.tracker + ' #' + row.issue_id + ': ' + row.name : row.name;
    }

    function initials(name) {
      var parts = String(name).trim().split(/\s+/).filter(Boolean);
      if (!parts.length) { return '?'; }
      var first = Array.from(parts[0])[0] || '';
      var last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] || '') : '';
      return (first + last).toUpperCase();
    }

    // The row that is reachable with the Tab key: the selected one, else the first one on screen. The rows
    // form a tree and the arrow keys move inside it, so only one of them is a tab stop.
    function rovingTarget() {
      var selected = selectedId && rowsById[selectedId];
      if (selected && isVisible(selected)) { return selected.id; }
      for (var i = 0; i < rowOrder.length; i++) {
        if (isVisible(rowOrder[i])) { return rowOrder[i].id; }
      }
      return null;
    }

    function updateRoving() {
      var target = rovingTarget();
      Object.keys(linkEls).forEach(function (id) { linkEls[id].tabIndex = id === target ? 0 : -1; });
    }

    function buildLabel(row) {
      var parent = row.kind === 'issue' && hasChildren(row);
      var selected = row.id === selectedId;
      var box = el('div', 'vg-label vg-label-' + row.kind + (parent ? ' vg-label-parent' : '') + (selected ? ' vg-selected' : ''));
      box.style.setProperty('--vg-depth', String(row.depth || 0));
      box.setAttribute('role', 'treeitem');
      box.setAttribute('aria-level', String((row.depth || 0) + 1));
      box.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (hasChildren(row)) { box.setAttribute('aria-expanded', collapsed[row.id] ? 'false' : 'true'); }
      labelEls[row.id] = box;

      // The expander is a mouse shortcut; from the keyboard a row is expanded and collapsed with Space.
      var expander = el('span', 'vg-expander');
      expander.setAttribute('aria-hidden', 'true');
      if (hasChildren(row)) {
        expander.classList.add(collapsed[row.id] ? 'vg-collapsed' : 'vg-expanded');
        expander.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          toggle(row.id);
        });
      }
      box.appendChild(expander);

      var link = el('a', 'vg-title');
      link.href = row.url;
      link.title = rowTitle(row);
      link.tabIndex = row.id === rovingTarget() ? 0 : -1;
      linkEls[row.id] = link;
      // Tabbing to a row selects it, which is how the arrow keys get a target without a mouse.
      link.addEventListener('focus', function () { setSelected(row.id); });
      if (row.kind === 'issue') {
        link.className += (row.closed ? ' vg-closed' : '') + (row.overdue ? ' vg-overdue' : '');
        link.appendChild(el('span', 'vg-id', row.tracker + ' #' + row.issue_id));
        link.appendChild(el('span', 'vg-subject', row.name));
      } else {
        link.appendChild(el('span', 'vg-subject', row.name));
      }
      box.appendChild(link);

      if (row.kind === 'issue' && !row.start) {
        box.appendChild(el('span', 'vg-nodates', t.noDates));
      }
      if (row.kind === 'issue' && row.assignee) {
        var chip = el('span', 'vg-avatar', initials(row.assignee));
        chip.title = t.assignee + ': ' + row.assignee;
        box.appendChild(chip);
      }
      // A click on the row (but not on its link or the chevron) selects it.
      box.addEventListener('click', function (event) {
        if (!event.target.closest('a, .vg-expander')) { setSelected(row.id); }
      });
      return box;
    }

    function toGroup(row, index) {
      return {
        id: row.id,
        // vis-timeline needs some content; the label itself comes from groupTemplate.
        content: rowTitle(row),
        order: index,
        visible: isVisible(row),
        className: 'vg-row vg-row-' + row.kind,
        row: row
      };
    }

    // ---------------------------------------------------------------- bars

    function pct(fraction) { return Math.round(fraction * 1000) / 10; }

    function barLabel(row) {
      if (row.kind === 'project') { return ''; }
      if (row.done_ratio == null) { return ''; }
      return row.done_ratio + '%';
    }

    function canEdit(row) {
      return row.kind === 'issue' && !!row.editable && (row.editable.start || row.editable.due);
    }

    // The tooltip is a DOM element (vis-timeline would strip the class attributes of an HTML string).
    function tooltipElement(row) {
      var box = el('div', 'vg-tip');
      box.appendChild(el('div', 'vg-tip-title', rowTitle(row)));
      function line(label, value, note) {
        var r = el('div', 'vg-tip-row');
        r.appendChild(el('span', null, label));
        var b = el('b', null, value);
        if (note) { b.appendChild(el('i', null, ' (' + note + ')')); }
        r.appendChild(b);
        box.appendChild(r);
      }
      if (row.kind === 'issue') {
        line(t.status, row.status + (row.done_ratio != null ? ' · ' + row.done_ratio + '%' : ''));
        if (row.assignee) { line(t.assignee, row.assignee); }
      } else if (row.kind === 'version' && row.done_ratio != null) {
        line(t.doneRatio, row.done_ratio + '%');
      }
      if (row.start) {
        var span = row.due ? dayDiff(parseDay(row.due), parseDay(row.start)) + 1 : 1;
        line(t.startDate, niceDate(row.start));
        line(t.dueDate, niceDate(row.due || row.start), row.due_inherited ? t.dueInherited : null);
        line(t.duration, fmt(t.days, { count: span }));
      }
      if (row.derived) {
        box.appendChild(el('div', 'vg-tip-note', t.datesDerived));
      } else if (row.kind === 'issue' && !canEdit(row)) {
        box.appendChild(el('div', 'vg-tip-note', t.notEditable));
      } else if (canEdit(row)) {
        box.appendChild(el('div', 'vg-tip-note', t.dragHint));
      }
      return box;
    }

    function toItem(row) {
      if (!row.start) { return null; }
      var start = parseDay(row.start);
      var end = addDays(parseDay(row.due || row.start), 1);
      var classes = ['vg-bar', 'vg-bar-' + row.kind];
      if (row.closed) { classes.push('vg-closed'); }
      if (row.derived) { classes.push('vg-derived'); }
      if (row.kind === 'issue' && hasChildren(row)) { classes.push('vg-parent'); }
      if (row.kind === 'issue' && row.late_to != null && !row.closed) { classes.push('vg-late'); }
      if (canEdit(row)) { classes.push('vg-editable'); }
      var style = '';
      if (row.progress != null) {
        var done = pct(row.progress);
        var late = row.late_to != null ? pct(row.late_to) : done;
        style = '--vg-done:' + done + '%;--vg-late:' + late + '%;';
      }
      return {
        id: row.id,
        group: row.id,
        type: 'range',
        start: start,
        end: end,
        content: esc(barLabel(row)),
        className: classes.join(' '),
        style: style,
        editable: canEdit(row) ? { updateTime: true, updateGroup: false, remove: false } : false,
        row: row
      };
    }

    // ---------------------------------------------------------------- data

    function syncDataSet(dataSet, list) {
      var keep = {};
      list.forEach(function (o) { keep[o.id] = true; });
      dataSet.getIds().forEach(function (id) {
        if (!keep[id]) { dataSet.remove(id); }
      });
      dataSet.update(list);
    }

    function applyData(data) {
      rowsById = {};
      rowOrder = data.rows;
      data.rows.forEach(function (row) { rowsById[row.id] = row; });
      data.rows.forEach(function (row) {
        var parent = rowsById[row.parent];
        if (parent) { parent.hasChildren = true; }
      });
      relations = data.relations || [];

      syncDataSet(groups, data.rows.map(toGroup));
      syncDataSet(items, data.rows.map(toItem).filter(Boolean));
      updateCorner();
      updateEmptyState();
      updateDetails();
      scheduleArrows();
    }

    function toggle(id) {
      collapsed[id] = !collapsed[id];
      refreshGroups();
      saveState();
    }

    function setAllCollapsed(value) {
      rowOrder.forEach(function (row) {
        if (hasChildren(row)) { collapsed[row.id] = value; }
      });
      refreshGroups();
      saveState();
    }

    function refreshGroups() {
      groups.update(rowOrder.map(toGroup));
      updateRoving();
      scheduleArrows();
    }

    function request(url, method, body) {
      var headers = { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
      var options = { method: method, credentials: 'same-origin', headers: headers };
      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['X-CSRF-Token'] = csrfToken();
        options.body = JSON.stringify(body);
      }
      return fetch(url, options).catch(function () {
        var failure = new Error(t.networkError);
        failure.network = true;
        throw failure;
      }).then(function (response) {
        return response.text().then(function (text) {
          var parsed = {};
          try { parsed = text ? JSON.parse(text) : {}; } catch (e) { /* not JSON */ }
          if (response.ok) { return parsed; }
          var error = new Error((parsed.errors && parsed.errors.join(' ')) || t.failed + ' (' + response.status + ')');
          error.status = response.status;
          throw error;
        });
      });
    }

    function reload() {
      return request(config.dataUrl, 'GET').then(applyData);
    }

    function saveDates(row, start, due) {
      var url = config.updateUrlTemplate.replace('__ID__', row.issue_id);
      return request(url, 'PUT', { issue: { start_date: start, due_date: due, lock_version: row.lock_version } });
    }

    // -------------------------------------------------------- undo / redo

    // The dates of every issue on the chart, as stored: what an undo has to put back.
    function snapshot() {
      var snap = {};
      rowOrder.forEach(function (row) {
        if (row.kind !== 'issue') { return; }
        snap[row.issue_id] = {
          start: row.start_date || null, due: row.due_date || null, lock: row.lock_version,
          // Parents with derived dates follow their children by themselves; what the user may
          // not edit cannot be put back by the user.
          restorable: canEdit(row) && !row.derived, row: row
        };
      });
      return snap;
    }

    // Everything that differs between two snapshots, the moved issue first and the rest by
    // their old start date: that order keeps every intermediate state valid for Redmine.
    function diffSnapshots(movedId, before, after) {
      var changes = [];
      Object.keys(before).forEach(function (id) {
        var b = before[id];
        var a = after[id];
        if (!a || !b.restorable || (b.start === a.start && b.due === a.due)) { return; }
        changes.push({ issueId: +id, from: { start: b.start, due: b.due }, to: { start: a.start, due: a.due } });
      });
      changes.sort(function (x, y) {
        if (x.issueId === movedId) { return -1; }
        if (y.issueId === movedId) { return 1; }
        var xs = x.from.start || x.from.due || '9999';
        var ys = y.from.start || y.from.due || '9999';
        return xs < ys ? -1 : xs > ys ? 1 : x.issueId - y.issueId;
      });
      return changes;
    }

    function pushHistory(entry) {
      undoStack.push(entry);
      if (undoStack.length > HISTORY_LIMIT) { undoStack.shift(); }
      redoStack = [];
      updateHistoryButtons();
    }

    function entryName(entry) {
      var row = rowsById['i' + entry.changes[0].issueId];
      return row ? '#' + row.issue_id + ' ' + row.name : '#' + entry.changes[0].issueId;
    }

    function updateHistoryButtons() {
      var undoEntry = undoStack[undoStack.length - 1];
      var redoEntry = redoStack[redoStack.length - 1];
      setButton('undo', !undoEntry || busy, undoEntry ? fmt(t.undoTitle, { what: entryName(undoEntry) }) : t.nothingToUndo);
      setButton('redo', !redoEntry || busy, redoEntry ? fmt(t.redoTitle, { what: entryName(redoEntry) }) : t.nothingToRedo);
    }

    // direction: 'undo' puts the old dates back, 'redo' applies the new ones again.
    //
    // First the chart is reloaded and checked: an entry may only be applied while every issue in it
    // still has the dates this entry left it with (that is what makes undoing several steps on the
    // same issue work, and what stops it from overwriting somebody else's change). The lock_version
    // sent is the one just loaded, so a change made in the meantime is still caught by the server.
    function travel(direction) {
      var from = direction === 'undo' ? undoStack : redoStack;
      var entry = from[from.length - 1];
      if (!entry || busy) { return; }

      busy = true;
      updateHistoryButtons();
      showToast(t.saving, { kind: 'progress' });
      reload().then(function () {
        var current = snapshot();
        var payload = [];
        entry.changes.forEach(function (change) {
          var now = current[change.issueId];
          var expected = direction === 'undo' ? change.to : change.from;
          var target = direction === 'undo' ? change.from : change.to;
          if (!now || now.start !== expected.start || now.due !== expected.due) {
            var conflict = new Error(fmt(t.staleIssue, { id: change.issueId }));
            conflict.status = 409;
            throw conflict;
          }
          payload.push({ id: change.issueId, start_date: target.start, due_date: target.due, lock_version: now.lock });
        });
        return request(config.restoreUrl, 'PUT', { changes: payload });
      }).then(function () {
        return reload();
      }).then(function () {
        from.pop();
        (direction === 'undo' ? redoStack : undoStack).push(entry);
        busy = false;
        updateHistoryButtons();
        showToast(direction === 'undo' ? t.undone : t.redone, { kind: 'ok' });
      }, function (error) {
        busy = false;
        // A conflict, a refusal or a validation error will not go away by itself: drop the entry.
        // A network error leaves it in place to try again.
        if (error.status) { from.pop(); reload(); }
        updateHistoryButtons();
        showToast(error.message || t.failed, { kind: 'error' });
      });
    }

    // -------------------------------------------------------- drag & drop

    function moveChip(event) {
      if (!chipEl || chipEl.hidden) { return; }
      var rect = stage.getBoundingClientRect();
      chipEl.style.left = (event.clientX - rect.left + 14) + 'px';
      chipEl.style.top = (event.clientY - rect.top + 18) + 'px';
    }

    function showChip(start, end) {
      if (!chipEl) { return; }
      var first = formatDay(start);
      var last = formatDay(addDays(end, -1));
      var span = dayDiff(parseDay(last), parseDay(first)) + 1;
      chipEl.textContent = niceDate(first) + ' → ' + niceDate(last) + ' · ' + fmt(t.days, { count: span });
      chipEl.hidden = false;
    }

    function hideChip() {
      if (chipEl) { chipEl.hidden = true; }
    }

    // Called while an item is being dragged. Keeps the bar on whole days, at
    // least one day long, and refuses changes to the fields the user may not edit.
    function onMoving(item, callback) {
      var original = items.get(item.id);
      var row = original.row;
      var start = snapDay(item.start);
      var end = snapDay(item.end);
      var startMoved = start.getTime() !== original.start.getTime();
      var endMoved = end.getTime() !== original.end.getTime();

      if (startMoved && endMoved) {
        // The whole bar is being moved: both dates must be editable.
        if (!(row.editable.start && row.editable.due)) { hideChip(); return callback(null); }
      } else if (startMoved && !row.editable.start) {
        start = original.start;
      } else if (endMoved && !row.editable.due) {
        end = original.end;
      }

      if (end <= start) {
        if (startMoved && !endMoved) { start = addDays(end, -1); } else { end = addDays(start, 1); }
      }
      item.start = start;
      item.end = end;
      showChip(start, end);
      callback(item);
    }

    // Saves new dates for an issue, reloads the chart and records the change for undo. Resolves to true
    // if the dates were saved (also when only the refresh afterwards failed), false otherwise.
    function commitDates(row, start, due) {
      if (busy) {
        showToast(t.busy, { kind: 'error' });
        return Promise.resolve(false);
      }
      busy = true;
      updateHistoryButtons();
      showToast(t.saving, { kind: 'progress' });
      var before = snapshot();
      return saveDates(row, start, due).then(function () {
        return reload().then(function () {
          var changes = diffSnapshots(row.issue_id, before, snapshot());
          busy = false;
          if (changes.length) { pushHistory({ changes: changes }); }
          updateHistoryButtons();
          showToast(t.saved, { kind: 'ok', undo: changes.length > 0 });
          return true;
        }, function () {
          // The save went through; only showing the result failed. Do not report a failed save.
          busy = false;
          updateHistoryButtons();
          showToast(t.refreshFailed, { kind: 'error' });
          return true;
        });
      }, function (error) {
        busy = false;
        updateHistoryButtons();
        showToast(error.message || t.failed, { kind: 'error' });
        // The chart may be stale (e.g. somebody else changed the issue).
        if (error.status === 409) { reload(); }
        return false;
      });
    }

    function onMove(item, callback) {
      hideChip();
      var original = items.get(item.id);
      var row = original.row;
      var start = formatDay(item.start);
      var due = formatDay(addDays(item.end, -1));

      if (start === row.start && due === row.due) { return callback(null); }
      commitDates(row, start, due).then(function (saved) {
        if (!saved) { return callback(null); }
        // The chart has been reloaded by now. vis-timeline would write the dragged item back into the
        // data set, and that object still carries the old row (with its old lock_version): hand it the
        // current one instead.
        var fresh = rowsById[item.id] && toItem(rowsById[item.id]);
        callback(fresh || item);
      });
    }

    // -------------------------------------------------------------- keyboard nudging

    // Arrow keys move the selected bar by a day (Shift: a week); + and - lengthen and shorten it.
    // Presses within half a second are combined into one save.
    function nudge(row, startDays, dueDays) {
      if (!pendingNudge || pendingNudge.id !== row.id) {
        flushNudge();
        pendingNudge = { id: row.id, row: row, start: parseDay(row.start), end: addDays(parseDay(row.due || row.start), 1), timer: null };
      }
      var start = addDays(pendingNudge.start, startDays);
      var end = addDays(pendingNudge.end, dueDays);
      if (end <= start) { return; }
      pendingNudge.start = start;
      pendingNudge.end = end;
      items.update({ id: row.id, start: start, end: end });
      showChip(start, end);
      placeChipAtItem(row.id);
      scheduleArrows();
      clearTimeout(pendingNudge.timer);
      pendingNudge.timer = setTimeout(flushNudge, 500);
    }

    function flushNudge() {
      if (!pendingNudge) { return; }
      var pending = pendingNudge;
      pendingNudge = null;
      clearTimeout(pending.timer);
      hideChip();
      var start = formatDay(pending.start);
      var due = formatDay(addDays(pending.end, -1));
      if (start === pending.row.start && due === pending.row.due) { return; }
      commitDates(pending.row, start, due).then(function (saved) {
        if (!saved) { reload(); } // put the bar back where the server has it
      });
    }

    function placeChipAtItem(id) {
      var item = timeline.itemSet.items[id];
      if (!chipEl || !item || !item.dom || !item.dom.box) { return; }
      var rect = item.dom.box.getBoundingClientRect();
      var host = stage.getBoundingClientRect();
      chipEl.style.left = Math.max(8, rect.left - host.left) + 'px';
      chipEl.style.top = (rect.bottom - host.top + 6) + 'px';
    }

    // The selected row: its label is highlighted, its dates are shown (and can be typed) in the strip
    // above the chart, and it is what the arrow keys act on.
    function markSelected(id, on) {
      var box = labelEls[id];
      if (!box) { return; }
      box.classList.toggle('vg-selected', on);
      box.setAttribute('aria-selected', on ? 'true' : 'false');
    }

    function setSelected(id) {
      if (selectedId === id) { return; }
      markSelected(selectedId, false);
      selectedId = id;
      markSelected(id, true);
      updateRoving();
      if (timeline) {
        if (id && items.get(id)) { timeline.setSelection([id]); } else if (!id) { timeline.setSelection([]); }
      }
      updateDetails();
      scheduleArrows();
    }

    // Folding re-draws the labels, which drops the focus together with the old link: put it back on the
    // new one as soon as the chart has been redrawn (or shortly after, if it does not report a change).
    function refocusRow(id) {
      var done = false;
      function focusIt() {
        if (done) { return; }
        done = true;
        timeline.off('changed', focusIt);
        var link = linkEls[id];
        if (link && document.body.contains(link)) { link.focus(); }
      }
      timeline.on('changed', focusIt);
      setTimeout(focusIt, 200);
    }

    // Up / Down / Home / End move the selection through the rows that are on screen.
    function moveSelection(key, keepFocus) {
      var visible = rowOrder.filter(isVisible);
      if (!visible.length) { return; }
      var index = -1;
      visible.forEach(function (row, i) { if (row.id === selectedId) { index = i; } });
      var next = key === 'Home' ? 0 : key === 'End' ? visible.length - 1 :
        Math.max(0, Math.min(visible.length - 1, index + (key === 'ArrowDown' ? 1 : -1)));
      var row = visible[next];
      setSelected(row.id);
      var link = linkEls[row.id];
      if (link && keepFocus) { link.focus(); }
    }

    // ------------------------------------------------------- details strip

    // Shows the selected row and, for an issue the user may reschedule, two date fields: the same
    // operation as dragging the bar, for those who cannot or would rather not use the mouse.
    function updateDetails() {
      if (!detailsEl) { return; }
      var row = selectedId && rowsById[selectedId];
      var signature = row ? [row.id, row.name, row.start_date, row.due_date, row.lock_version, row.status, row.assignee,
                             canEdit(row) ? 1 : 0, row.derived ? 1 : 0].join('|') : '';
      if (signature === detailsSignature) { return; }
      detailsSignature = signature;
      var hadFocus = detailsEl.contains(document.activeElement);
      while (detailsEl.firstChild) { detailsEl.removeChild(detailsEl.firstChild); }

      if (!row) {
        detailsEl.appendChild(el('span', 'vg-details-hint', t.detailsHint));
        return;
      }
      var title = el('a', 'vg-details-title', rowTitle(row));
      title.href = row.url;
      detailsEl.appendChild(title);

      var meta = [];
      if (row.kind === 'issue') {
        meta.push(row.status + (row.done_ratio != null ? ' · ' + row.done_ratio + '%' : ''));
        if (row.assignee) { meta.push(row.assignee); }
      } else if (row.done_ratio != null) {
        meta.push(t.doneRatio + ' ' + row.done_ratio + '%');
      }
      if (meta.length) { detailsEl.appendChild(el('span', 'vg-details-meta', meta.join(' · '))); }

      if (row.kind === 'issue' && canEdit(row) && !row.derived) {
        detailsEl.appendChild(dateForm(row, hadFocus));
      } else if (row.start) {
        var span = row.due ? dayDiff(parseDay(row.due), parseDay(row.start)) + 1 : 1;
        detailsEl.appendChild(el('span', 'vg-details-meta',
          niceDate(row.start) + ' → ' + niceDate(row.due || row.start) + ' · ' + fmt(t.days, { count: span })));
        if (row.derived) { detailsEl.appendChild(el('span', 'vg-details-hint', t.datesDerived)); }
        else if (row.kind === 'issue') { detailsEl.appendChild(el('span', 'vg-details-hint', t.notEditable)); }
      } else if (row.kind === 'issue') {
        detailsEl.appendChild(el('span', 'vg-details-hint', t.notEditable));
      }
    }

    function dateForm(row, takeFocus) {
      var form = el('form');
      form.noValidate = true;
      function field(name, label, value, editable) {
        var wrap = el('label');
        wrap.appendChild(el('span', null, label));
        var input = el('input');
        input.type = 'date';
        input.name = name;
        input.value = value || '';
        input.disabled = !editable;
        wrap.appendChild(input);
        form.appendChild(wrap);
        return input;
      }
      var start = field('start_date', t.startDate, row.start_date, row.editable.start);
      var due = field('due_date', t.dueDate, row.due_date, row.editable.due);
      var apply = el('button', 'vg-details-apply', t.apply);
      apply.type = 'submit';
      form.appendChild(apply);
      if (takeFocus) { setTimeout(function () { (start.disabled ? due : start).focus(); }, 0); }

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var from = start.disabled ? row.start_date : start.value;
        var to = due.disabled ? row.due_date : (due.value || from);
        if (!from || !to) { showToast(t.invalidDates, { kind: 'error' }); return; }
        if (from === row.start_date && to === (row.due_date || row.start_date)) { return; }
        commitDates(row, from, to);
      });
      return form;
    }

    // ------------------------------------------------------------ hover

    var hoverId = null;

    function setHover(id) {
      if (id === hoverId) { return; }
      var previous = timeline.itemSet.groups[hoverId];
      if (previous) {
        if (previous.dom.label) { previous.dom.label.classList.remove('vg-hover'); }
        if (previous.dom.foreground) { previous.dom.foreground.classList.remove('vg-hover'); }
      }
      hoverId = id;
      var group = timeline.itemSet.groups[id];
      if (group) {
        if (group.dom.label) { group.dom.label.classList.add('vg-hover'); }
        if (group.dom.foreground) { group.dom.foreground.classList.add('vg-hover'); }
      }
    }

    // The row under the pointer is highlighted across both panels (the subject and its bar).
    var hoverFrame = null;
    function onPointerMoveForHover(event) {
      if (event.buttons || hoverFrame) { return; }
      hoverFrame = requestAnimationFrame(function () {
        hoverFrame = null;
        var props = timeline.getEventProperties(event);
        setHover(props && props.group != null ? props.group : null);
      });
    }

    // ------------------------------------------------------------ relations

    var arrowLayer = null;
    var arrowTimer = null;

    function scheduleArrows() {
      clearTimeout(arrowTimer);
      arrowTimer = setTimeout(drawArrows, 30);
    }

    function ensureArrowLayer() {
      var host = timeline && timeline.dom.center;
      if (!host) { return null; }
      if (arrowLayer && arrowLayer.parentNode === host) { return arrowLayer; }
      arrowLayer = svgEl('svg', { 'class': 'vg-arrows', 'aria-hidden': 'true', focusable: 'false' });
      // First child: the lines run behind the bars and their text.
      host.insertBefore(arrowLayer, host.firstChild);
      return arrowLayer;
    }

    // Straight segments joined by small rounded corners.
    function roundedPath(points, radius) {
      var d = 'M' + points[0][0] + ',' + points[0][1];
      for (var i = 1; i < points.length - 1; i++) {
        var p0 = points[i - 1];
        var p1 = points[i];
        var p2 = points[i + 1];
        var l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        var l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        if (!l1 || !l2) { continue; }
        var r1 = Math.min(radius, l1 / 2);
        var r2 = Math.min(radius, l2 / 2);
        var a = [p1[0] - (p1[0] - p0[0]) / l1 * r1, p1[1] - (p1[1] - p0[1]) / l1 * r1];
        var b = [p1[0] + (p2[0] - p1[0]) / l2 * r2, p1[1] + (p2[1] - p1[1]) / l2 * r2];
        d += 'L' + a[0] + ',' + a[1] + 'Q' + p1[0] + ',' + p1[1] + ' ' + b[0] + ',' + b[1];
      }
      var last = points[points.length - 1];
      return d + 'L' + last[0] + ',' + last[1];
    }

    // Draws "blocks" and "precedes" relations between the bars that are currently in the DOM:
    // from the right end of one bar to the left end of the other. When the target starts before
    // the source ends, the line runs through the gap between the two rows.
    function drawArrows() {
      var layer = ensureArrowLayer();
      if (!layer) { return; }
      while (layer.firstChild) { layer.removeChild(layer.firstChild); }
      if (!showRelations) { return; }

      var host = timeline.dom.center;
      var hostRect = host.getBoundingClientRect();
      layer.setAttribute('width', host.clientWidth);
      layer.setAttribute('height', host.clientHeight);

      var defs = svgEl('defs');
      ['', '-active'].forEach(function (suffix) {
        var marker = svgEl('marker', { id: 'vg-head' + suffix, markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto', markerUnits: 'userSpaceOnUse' });
        marker.appendChild(svgEl('path', { d: 'M0,0.5 L7.5,4 L0,7.5 z', 'class': 'vg-head' + (suffix ? ' vg-head-active' : '') }));
        defs.appendChild(marker);
      });
      layer.appendChild(defs);

      var rowHeight = parseFloat(getComputedStyle(app).getPropertyValue('--vg-row-h')) || 30;

      function box(id) {
        var item = timeline.itemSet.items[id];
        if (!item || !item.displayed || !item.dom || !item.dom.box) { return null; }
        var rect = item.dom.box.getBoundingClientRect();
        if (!rect.width && !rect.height) { return null; }
        return {
          left: rect.left - hostRect.left, right: rect.right - hostRect.left,
          mid: rect.top - hostRect.top + rect.height / 2
        };
      }

      function isActive(relation) { return !!selectedId && (relation.from === selectedId || relation.to === selectedId); }
      // the lines of the selected row are drawn last, i.e. on top
      relations.slice().sort(function (a, b) { return (isActive(a) ? 1 : 0) - (isActive(b) ? 1 : 0); }).forEach(function (relation) {
        var from = box(relation.from);
        var to = box(relation.to);
        if (!from || !to) { return; }
        var gap = 10;
        var points;
        if (to.left >= from.right + 2 * gap) {
          points = [[from.right, from.mid], [from.right + gap, from.mid], [from.right + gap, to.mid], [to.left, to.mid]];
        } else {
          var edge = from.mid + (to.mid >= from.mid ? rowHeight / 2 : -rowHeight / 2);
          points = [[from.right, from.mid], [from.right + gap, from.mid], [from.right + gap, edge],
                    [to.left - gap, edge], [to.left - gap, to.mid], [to.left, to.mid]];
        }
        var type = relation.type === 'blocks' ? 'blocks' : 'precedes';
        var classes = 'vg-rel vg-rel-' + type;
        var active = isActive(relation);
        if (selectedId) { classes += active ? ' vg-rel-active' : ' vg-rel-dim'; }
        var d = roundedPath(points, 5);
        // a light outline keeps the line readable where it crosses a bar or another line
        layer.appendChild(svgEl('path', { d: d, 'class': 'vg-rel-halo' }));
        layer.appendChild(svgEl('path', { d: d, 'class': classes, 'marker-end': 'url(#vg-head' + (active ? '-active' : '') + ')' }));
      });
    }

    // ---------------------------------------------------------------- toast

    function buildToast() {
      // Screen readers get the messages from a separate, always present live region: a box that is
      // shown and hidden is announced unreliably.
      liveEl = el('div', 'vg-sr-only');
      liveEl.setAttribute('role', 'status');
      liveEl.setAttribute('aria-live', 'polite');
      liveEl.setAttribute('aria-atomic', 'true');
      stage.appendChild(liveEl);

      toastEl = el('div', 'vg-toast');
      toastEl.id = 'vis-gantt-toast';
      toastEl.hidden = true;
      toastIcon = el('span', 'vg-toast-icon');
      toastIcon.setAttribute('aria-hidden', 'true');
      toastMessage = el('span', 'vg-toast-message');
      toastUndo = el('button', 'vg-toast-action', t.undo);
      toastUndo.type = 'button';
      toastUndo.setAttribute('data-vg-action', 'toast-undo');
      toastUndo.hidden = true;
      toastUndo.addEventListener('click', function () { travel('undo'); });
      var close = el('button', 'vg-toast-close');
      close.type = 'button';
      close.setAttribute('aria-label', t.dismiss);
      close.title = t.dismiss;
      close.appendChild(icon('close'));
      close.addEventListener('click', hideToast);
      toastEl.appendChild(toastIcon);
      toastEl.appendChild(toastMessage);
      toastEl.appendChild(toastUndo);
      toastEl.appendChild(close);
      // A message that is being read (pointer over it, or focus inside) does not disappear.
      toastEl.addEventListener('mouseenter', function () { toastHover = true; clearTimeout(toastTimer); });
      toastEl.addEventListener('mouseleave', function () { toastHover = false; armToast(); });
      toastEl.addEventListener('focusin', function () { toastHover = true; clearTimeout(toastTimer); });
      toastEl.addEventListener('focusout', function () { toastHover = false; armToast(); });
      stage.appendChild(toastEl);
    }

    function hideToast() {
      clearTimeout(toastTimer);
      toastHover = false;
      toastEl.hidden = true;
      toastEl.setAttribute('data-kind', '');
    }

    // Only a success message goes away by itself; failures stay until dismissed.
    function armToast() {
      clearTimeout(toastTimer);
      if (toastEl.hidden || toastHover || toastEl.getAttribute('data-kind') !== 'ok') { return; }
      toastTimer = setTimeout(hideToast, toastUndo.hidden ? 3500 : 8000);
    }

    function announce(message) {
      if (!liveEl) { return; }
      liveEl.textContent = '';
      setTimeout(function () { liveEl.textContent = message; }, 30);
    }

    function showToast(message, options) {
      clearTimeout(toastTimer);
      toastHover = toastEl.matches(':hover') || toastEl.contains(document.activeElement);
      toastMessage.textContent = message;
      toastEl.setAttribute('data-kind', options.kind);
      while (toastIcon.firstChild) { toastIcon.removeChild(toastIcon.firstChild); }
      if (options.kind === 'ok') { toastIcon.appendChild(icon('check')); }
      if (options.kind === 'error') { toastIcon.textContent = '!'; }
      toastIcon.hidden = options.kind === 'progress';
      toastUndo.hidden = !options.undo;
      toastEl.hidden = false;
      if (options.kind !== 'progress') { announce(message); }
      armToast();
    }

    // -------------------------------------------------------------- toolbar

    function setButton(action, disabled, title) {
      var b = buttons[action];
      if (!b) { return; }
      // aria-disabled, not disabled: the button stays focusable and its title explains why it does nothing.
      b.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      if (title) { b.title = title; b.setAttribute('aria-label', title); }
    }

    function buildToolbar() {
      var bar = document.getElementById('vis-gantt-toolbar');
      var groupEl = null;

      function group(label) {
        groupEl = el('div', 'vg-group');
        groupEl.setAttribute('role', 'group');
        groupEl.setAttribute('aria-label', label);
        bar.appendChild(groupEl);
      }

      function button(action, options) {
        var b = el('button', 'vg-btn' + (options.text ? ' vg-btn-text' : '') + (options.icon && options.text ? ' vg-btn-both' : ''));
        b.type = 'button';
        b.setAttribute('data-vg-action', action);
        if (options.icon) { b.appendChild(icon(options.icon)); }
        if (options.text) { b.appendChild(el('span', 'vg-btn-label', options.text)); }
        b.title = options.title || options.text || '';
        b.setAttribute('aria-label', options.title || options.text);
        b.addEventListener('click', function (event) {
          if (b.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
          options.handler(event);
        });
        groupEl.appendChild(b);
        buttons[action] = b;
        return b;
      }

      bar.setAttribute('aria-label', t.toolbar);
      group(t.history);
      button('undo', { icon: 'undo', text: t.undo, title: t.nothingToUndo, handler: function () { travel('undo'); } });
      button('redo', { icon: 'redo', text: t.redo, title: t.nothingToRedo, handler: function () { travel('redo'); } });
      updateHistoryButtons();

      group(t.scale);
      PRESETS.forEach(function (preset) {
        var b = button('preset-' + preset.key, { text: t[preset.key], title: t[preset.key], handler: function () { setSpan(preset.days); } });
        b.setAttribute('data-vg-preset', preset.key);
        b.setAttribute('aria-pressed', 'false');
      });
      button('zoom-out', { icon: 'zoom-out', title: t.zoomOut, handler: function () { timeline.zoomOut(0.4, { animation: anim(300) }); } });
      button('zoom-in', { icon: 'zoom-in', title: t.zoomIn, handler: function () { timeline.zoomIn(0.4, { animation: anim(300) }); } });

      group(t.navigate);
      button('today', { text: t.today, title: t.today, handler: function () { timeline.moveTo(new Date(), { animation: anim(300) }); } });
      button('fit', { icon: 'fit', title: t.fit, handler: function () { timeline.fit({ animation: anim(300) }); } });

      group(t.tree);
      button('expand-all', { icon: 'expand-all', title: t.expandAll, handler: function () { setAllCollapsed(false); } });
      button('collapse-all', { icon: 'collapse-all', title: t.collapseAll, handler: function () { setAllCollapsed(true); } });

      bar.appendChild(el('span', 'vg-spacer'));

      var toggleRel = el('button', 'vg-btn vg-btn-toggle vg-btn-both');
      toggleRel.type = 'button';
      toggleRel.setAttribute('data-vg-action', 'toggle-relations');
      toggleRel.setAttribute('aria-pressed', 'true');
      toggleRel.title = t.relations;
      toggleRel.appendChild(icon('relations'));
      toggleRel.appendChild(el('span', 'vg-btn-label', t.relations));
      toggleRel.addEventListener('click', function () {
        showRelations = !showRelations;
        toggleRel.setAttribute('aria-pressed', showRelations ? 'true' : 'false');
        drawArrows();
      });
      bar.appendChild(toggleRel);
      buttons['toggle-relations'] = toggleRel;

      var help = el('button', 'vg-btn vg-btn-help', '?');
      help.type = 'button';
      help.setAttribute('data-vg-action', 'help');
      help.title = t.helpTitle;
      help.setAttribute('aria-label', t.helpTitle);
      help.setAttribute('aria-expanded', 'false');
      help.setAttribute('aria-controls', 'vis-gantt-help');
      help.addEventListener('click', function () {
        var panel = document.getElementById('vis-gantt-help');
        panel.hidden = !panel.hidden;
        help.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
      });
      bar.appendChild(help);
      buttons.help = help;
    }

    var PRESETS = [
      { key: 'week', days: 14 },
      { key: 'month', days: 45 },
      { key: 'quarter', days: 120 },
      { key: 'year', days: 400 }
    ];

    // Zoom to a preset span, keeping the centre of what is on screen.
    function setSpan(days) {
      var w = timeline.getWindow();
      var centre = new Date((w.start.getTime() + w.end.getTime()) / 2);
      timeline.setWindow(new Date(centre.getTime() - days * DAY / 2), new Date(centre.getTime() + days * DAY / 2), { animation: anim(250) });
    }

    // Marks the preset closest to what is on screen (in the logarithm of the span).
    function updatePresets() {
      if (!timeline) { return; }
      var w = timeline.getWindow();
      var span = (w.end - w.start) / DAY;
      var best = null;
      PRESETS.forEach(function (preset) {
        var distance = Math.abs(Math.log(span / preset.days));
        if (!best || distance < best.distance) { best = { key: preset.key, distance: distance }; }
      });
      PRESETS.forEach(function (preset) {
        var b = buttons['preset-' + preset.key];
        if (b) { b.setAttribute('aria-pressed', best && best.key === preset.key && best.distance < 0.35 ? 'true' : 'false'); }
      });
    }

    function buildHelp() {
      var help = document.getElementById('vis-gantt-help');
      if (!help) { return; }
      var list = el('ul');
      t.help.forEach(function (text) { list.appendChild(el('li', null, text)); });
      help.appendChild(list);
    }

    function buildLegend() {
      var legend = document.getElementById('vis-gantt-legend');
      if (!legend) { return; }
      [['done', t.legendDone], ['late', t.legendLate], ['todo', t.legendTodo], ['closed', t.legendClosed],
       ['summary', t.legendSummary], ['version', t.legendVersion], ['today', t.legendToday],
       ['precedes', t.legendPrecedes], ['blocks', t.legendBlocks]].forEach(function (pair) {
        var item = el('li', 'vg-legend-item');
        var swatch = el('i', 'vg-swatch vg-swatch-' + pair[0]);
        swatch.setAttribute('aria-hidden', 'true');
        item.appendChild(swatch);
        item.appendChild(document.createTextNode(pair[1]));
        legend.appendChild(item);
      });
    }

    // -------------------------------------------------------- label column

    var cornerEl, splitterEl, emptyEl;

    function clampLabelWidth(width) {
      var max = Math.max(200, Math.min(620, stage.clientWidth - 260));
      return Math.max(150, Math.min(max, Math.round(width)));
    }

    function setLabelWidth(width, persist) {
      width = clampLabelWidth(width);
      app.style.setProperty('--vg-label-w', width + 'px');
      if (splitterEl) { splitterEl.setAttribute('aria-valuenow', String(width)); }
      if (persist) { storageSet(LABEL_WIDTH_KEY, String(width)); }
      if (timeline) { timeline.redraw(); positionOverlays(); scheduleArrows(); }
    }

    function initialLabelWidth() {
      var stored = parseInt(storageGet(LABEL_WIDTH_KEY), 10);
      if (stored) { return stored; }
      return Math.round(Math.max(190, Math.min(330, stage.clientWidth * 0.34)));
    }

    function buildLabelColumnControls() {
      cornerEl = el('div', 'vg-corner');
      cornerEl.appendChild(el('span', 'vg-corner-title', t.issues));
      cornerEl.appendChild(el('span', 'vg-corner-count'));
      stage.appendChild(cornerEl);

      splitterEl = el('div', 'vg-splitter');
      splitterEl.setAttribute('role', 'separator');
      splitterEl.setAttribute('aria-orientation', 'vertical');
      splitterEl.setAttribute('aria-label', t.resizeColumn);
      splitterEl.setAttribute('aria-valuemin', '150');
      splitterEl.tabIndex = 0;
      stage.appendChild(splitterEl);

      var startX = 0;
      var startWidth = 0;
      splitterEl.addEventListener('pointerdown', function (event) {
        startX = event.clientX;
        startWidth = parseFloat(getComputedStyle(app).getPropertyValue('--vg-label-w')) || 300;
        splitterEl.setPointerCapture(event.pointerId);
        splitterEl.classList.add('vg-dragging');
        event.preventDefault();
      });
      splitterEl.addEventListener('pointermove', function (event) {
        if (!splitterEl.classList.contains('vg-dragging')) { return; }
        setLabelWidth(startWidth + event.clientX - startX, false);
      });
      splitterEl.addEventListener('pointerup', function (event) {
        splitterEl.classList.remove('vg-dragging');
        splitterEl.releasePointerCapture(event.pointerId);
        setLabelWidth(startWidth + event.clientX - startX, true);
      });
      splitterEl.addEventListener('dblclick', function () { storageSet(LABEL_WIDTH_KEY, ''); setLabelWidth(initialLabelWidth(), false); });
      splitterEl.addEventListener('keydown', function (event) {
        var step = event.shiftKey ? 40 : 12;
        var current = parseFloat(getComputedStyle(app).getPropertyValue('--vg-label-w')) || 300;
        if (event.key === 'ArrowLeft') { setLabelWidth(current - step, true); event.preventDefault(); }
        if (event.key === 'ArrowRight') { setLabelWidth(current + step, true); event.preventDefault(); }
      });

      emptyEl = el('div', 'vg-empty', t.empty);
      emptyEl.hidden = true;
      stage.appendChild(emptyEl);
    }

    function updateCorner() {
      if (!cornerEl) { return; }
      var count = rowOrder.filter(function (row) { return row.kind === 'issue'; }).length;
      cornerEl.querySelector('.vg-corner-count').textContent = String(count);
    }

    function updateEmptyState() {
      if (emptyEl) { emptyEl.hidden = rowOrder.length > 0; }
    }

    // The header over the subject column and the splitter line follow the time axis and the labels.
    function positionOverlays() {
      if (!timeline || !cornerEl || !timeline.dom.root) { return; }
      var stageRect = stage.getBoundingClientRect();
      var frame = timeline.dom.root.getBoundingClientRect();
      var axis = timeline.dom.top ? timeline.dom.top.getBoundingClientRect() : { height: 0 };
      var left = timeline.dom.left ? timeline.dom.left.getBoundingClientRect().width : 0;
      var x = frame.left - stageRect.left;
      var y = frame.top - stageRect.top;
      cornerEl.style.left = x + 'px';
      cornerEl.style.top = y + 'px';
      cornerEl.style.width = left + 'px';
      cornerEl.style.height = axis.height + 'px';
      app.style.setProperty('--vg-axis-h', axis.height + 'px');
      splitterEl.style.left = (x + left - 4) + 'px';
      splitterEl.style.top = y + 'px';
      splitterEl.style.height = frame.height + 'px';
    }

    // ------------------------------------------------------------ keyboard

    function onKeyDown(event) {
      var target = event.target;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) { return; }
      var key = (event.key || '');
      var mod = event.ctrlKey || event.metaKey;

      if (mod && !event.altKey) {
        var lower = key.toLowerCase();
        if (lower === 'z' && !event.shiftKey) { event.preventDefault(); travel('undo'); }
        if ((lower === 'z' && event.shiftKey) || lower === 'y') { event.preventDefault(); travel('redo'); }
        return;
      }
      if (mod || event.altKey) { return; }

      if (key === 'Escape' && toastEl && !toastEl.hidden) { hideToast(); return; }

      // Moving through the rows and folding them: only while the focus is in the chart.
      if (target && root.contains(target)) {
        if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
          event.preventDefault();
          moveSelection(key, !!target.closest('.vg-label'));
          return;
        }
        var focused = selectedId && rowsById[selectedId];
        if (key === ' ' && focused && hasChildren(focused) && target.closest('.vg-label')) {
          event.preventDefault();
          toggle(focused.id);
          refocusRow(focused.id);
          return;
        }
      }

      var row = selectedId && rowsById[selectedId];
      if (!row || row.kind !== 'issue' || !row.start || !canEdit(row)) { return; }
      var week = event.shiftKey ? 7 : 1;
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (!(row.editable.start && row.editable.due)) { return; }
        var days = (key === 'ArrowRight' ? 1 : -1) * week;
        event.preventDefault();
        nudge(row, days, days);
      } else if ((key === '+' || key === '=' || key === '-' || key === '_') && row.editable.due) {
        event.preventDefault();
        nudge(row, 0, (key === '+' || key === '=' ? 1 : -1) * week);
      }
    }

    // ----------------------------------------------------------------- init

    function chartHeight() {
      var top = root.getBoundingClientRect().top;
      return Math.max(320, Math.round(window.innerHeight - top - 76));
    }

    function applyHeight() {
      if (timeline) { timeline.setOptions({ maxHeight: chartHeight() + 'px' }); }
    }

    // Like the built-in Gantt: from the start of this month, six months wide.
    function initialWindow() {
      var now = new Date();
      var start = addDays(new Date(now.getFullYear(), now.getMonth(), 1), -7);
      var end = new Date(now.getFullYear(), now.getMonth() + 6, 1);
      return { start: start, end: end };
    }

    function init() {
      var saved = loadState();
      if (saved && saved.collapsed) { saved.collapsed.forEach(function (id) { collapsed[id] = true; }); }
      var savedWindow = saved && saved.end > saved.start && (saved.end - saved.start) > 2 * DAY &&
        (saved.end - saved.start) < 50 * 365 * DAY ? { start: new Date(saved.start), end: new Date(saved.end) } : null;

      detailsEl = document.getElementById('vis-gantt-details');
      buildToolbar();
      buildHelp();
      buildLegend();
      buildToast();
      chipEl = el('div', 'vg-chip');
      chipEl.hidden = true;
      stage.appendChild(chipEl);
      buildLabelColumnControls();
      app.style.setProperty('--vg-label-w', clampLabelWidth(initialLabelWidth()) + 'px');
      applyData(config.initial);

      var win = savedWindow || initialWindow();
      // On touch screens a finger that lands on a bar should scroll the chart, not reschedule the issue:
      // bars are draggable only after they have been tapped.
      var options = {
        locale: config.locale,
        orientation: { axis: 'top', item: 'top' },
        start: win.start,
        end: win.end,
        maxHeight: chartHeight() + 'px',
        stack: false,
        margin: { item: { horizontal: 0, vertical: 0 }, axis: 0 },
        zoomMin: 3 * DAY,
        zoomMax: 20 * 365 * DAY,
        zoomKey: 'ctrlKey',
        verticalScroll: true,
        showCurrentTime: true,
        groupOrder: 'order',
        groupTemplate: function (group) { return buildLabel(group.row); },
        editable: { updateTime: true, updateGroup: false, add: false, remove: false },
        itemsAlwaysDraggable: coarsePointer ? { item: false, range: false } : { item: true, range: true },
        selectable: true,
        snap: function (date) { return snapDay(date); },
        onMoving: onMoving,
        onMove: onMove,
        tooltip: { followMouse: false, overflowMethod: 'cap', template: function (itemData) { return tooltipElement(itemData.row); } }
      };

      timeline = new vis.Timeline(root, items, groups, options);

      // Nothing to see in the default window although there are bars: show them all instead of an empty chart.
      if (!savedWindow && items.length) {
        var visible = items.get().some(function (item) { return item.end > win.start && item.start < win.end; });
        if (!visible) { timeline.fit({ animation: false }); }
      }

      // Open an issue/version/project on double click.
      timeline.on('doubleClick', function (props) {
        var row = rowsById[props.item || props.group];
        if (row && row.url) { window.location.href = row.url; }
      });
      timeline.on('select', function (props) {
        setSelected(props.items && props.items.length ? props.items[0] : null);
      });

      ['changed', 'rangechanged', 'scroll'].forEach(function (name) { timeline.on(name, scheduleArrows); });
      timeline.on('changed', positionOverlays);
      timeline.on('rangechange', updatePresets);
      timeline.on('rangechanged', updatePresets);
      timeline.on('rangechanged', saveState);
      window.addEventListener('resize', function () {
        applyHeight();
        setLabelWidth(parseFloat(getComputedStyle(app).getPropertyValue('--vg-label-w')) || 300, false);
        scheduleArrows();
      });
      // Opening or closing the filters changes how much room the chart has.
      var legend = document.querySelector('#filters > legend');
      if (legend) { legend.addEventListener('click', function () { setTimeout(applyHeight, 50); }); }
      document.addEventListener('mousemove', moveChip);
      document.addEventListener('mouseup', hideChip);
      document.addEventListener('keydown', onKeyDown);
      root.addEventListener('mousemove', onPointerMoveForHover);
      root.addEventListener('mouseleave', function () { setHover(null); });

      // A printout is not scrolled: show every row, then go back to the height of the screen.
      window.addEventListener('beforeprint', function () {
        timeline.setOptions({ maxHeight: '100000px' });
        timeline.redraw();
        positionOverlays();
        drawArrows();
      });
      window.addEventListener('afterprint', function () {
        applyHeight();
        timeline.redraw();
        positionOverlays();
        scheduleArrows();
      });

      // The row list is a tree for assistive technology.
      var labelSet = root.querySelector('.vis-labelset');
      if (labelSet) {
        labelSet.setAttribute('role', 'tree');
        labelSet.setAttribute('aria-label', t.issues);
      }
      updateDetails();

      updatePresets();
      positionOverlays();
      window.visGantt = {
        timeline: timeline, items: items, groups: groups, reload: reload,
        history: function () {
          var last = undoStack[undoStack.length - 1];
          return { undo: undoStack.length, redo: redoStack.length, lastChanges: last ? last.changes.length : 0 };
        }
      };
    }

    init();
  }
})();
