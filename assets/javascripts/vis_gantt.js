/*
 * Gantt chart for Redmine on top of vis-timeline.
 *
 * The server sends a flat list of rows (projects, versions, issues, in the order
 * the built-in Gantt draws them). Every row becomes a vis-timeline "group" (the
 * left column) and, if it has dates, an "item" (the bar). Moving or resizing the
 * bar of an issue saves the new dates through PUT /vis_gantt/issues/:id/dates and
 * then reloads the chart, because the server may have rescheduled other issues
 * (following issues, parents with derived dates, version and project bars).
 */
(function () {
  'use strict';

  var DAY = 24 * 60 * 60 * 1000;
  // Same colours as the built-in Gantt (.task_done, .task_late, .task_todo).
  var COLOR_DONE = '#00c600';
  var COLOR_LATE = '#f66';
  var COLOR_TODO = '#aaa';
  var RELATION_COLORS = { blocks: '#F34F4F', precedes: '#628FEA' };

  // The script is included in <head>, so wait for the page before looking for the container.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  function start() {
  var root = document.getElementById('vis-gantt');
  if (!root || typeof vis === 'undefined') { return; }

  var config = JSON.parse(root.getAttribute('data-config'));
  var t = config.i18n;

  var rowsById = {};
  var rowOrder = [];
  var relations = [];
  var collapsed = {};
  var showRelations = true;
  var timeline = null;
  var groups = new vis.DataSet();
  var items = new vis.DataSet();
  var statusEl = document.getElementById('vis-gantt-status');
  var statusTimer = null;

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

  // ------------------------------------------------------------- helpers

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) { e.className = className; }
    if (text != null) { e.textContent = text; }
    return e;
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

  function setStatus(message, kind) {
    clearTimeout(statusTimer);
    statusEl.className = 'vg-status' + (kind ? ' vg-status-' + kind : '');
    statusEl.textContent = message || '';
    if (message && kind !== 'error') {
      statusTimer = setTimeout(function () { setStatus(''); }, 3000);
    }
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

  function buildLabel(row) {
    var box = el('div', 'vg-label vg-label-' + row.kind);
    box.style.paddingLeft = (row.depth * 14 + 4) + 'px';
    box.title = rowTitle(row);

    var expander = el('span', 'vg-expander');
    if (hasChildren(row)) {
      expander.classList.add(collapsed[row.id] ? 'vg-collapsed' : 'vg-expanded');
      expander.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        toggle(row.id);
      });
    }
    box.appendChild(expander);

    var link = el('a');
    link.href = row.url;
    if (row.kind === 'issue') {
      link.className = 'issue' + (row.closed ? ' closed' : '') + (row.overdue ? ' vg-overdue' : '');
      link.appendChild(document.createTextNode(row.tracker + ' #' + row.issue_id + ': '));
      link.appendChild(el('span', 'vg-subject', row.name));
    } else {
      link.className = row.kind === 'version' ? 'vg-version' : 'project';
      link.textContent = row.name;
    }
    box.appendChild(link);
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

  function barBackground(row) {
    if (row.progress == null) { return ''; }
    var done = pct(row.progress);
    var late = row.late_to != null ? pct(row.late_to) : done;
    return 'background:linear-gradient(to right,' +
      COLOR_DONE + ' ' + done + '%,' +
      COLOR_LATE + ' ' + done + '%,' + COLOR_LATE + ' ' + late + '%,' +
      COLOR_TODO + ' ' + late + '%);';
  }

  function barLabel(row) {
    if (row.kind === 'project') { return ''; }
    if (row.kind === 'version') { return row.done_ratio + '%'; }
    return row.status + (row.done_ratio != null ? ' ' + row.done_ratio + '%' : '');
  }

  function tooltip(row) {
    var lines = ['<strong>' + esc(rowTitle(row)) + '</strong>'];
    if (row.kind === 'issue') {
      lines.push(esc(t.status) + ': ' + esc(row.status) +
        (row.done_ratio != null ? ' (' + row.done_ratio + '%)' : ''));
      if (row.assignee) { lines.push(esc(t.assignee) + ': ' + esc(row.assignee)); }
    }
    if (row.start) { lines.push(esc(t.startDate) + ': ' + esc(row.start)); }
    if (row.due) {
      lines.push(esc(t.dueDate) + ': ' + esc(row.due) + (row.due_inherited ? ' (' + esc(t.dueInherited) + ')' : ''));
    }
    if (row.derived) {
      lines.push('<em>' + esc(t.datesDerived) + '</em>');
    } else if (row.kind === 'issue' && !canEdit(row)) {
      lines.push('<em>' + esc(t.notEditable) + '</em>');
    }
    return lines.join('<br>');
  }

  function canEdit(row) {
    return row.kind === 'issue' && !!row.editable && (row.editable.start || row.editable.due);
  }

  function toItem(row) {
    if (!row.start) { return null; }
    var start = parseDay(row.start);
    var end = addDays(parseDay(row.due || row.start), 1);
    var classes = ['vg-bar', 'vg-bar-' + row.kind];
    if (row.closed) { classes.push('vg-closed'); }
    if (row.derived) { classes.push('vg-derived'); }
    if (row.kind === 'issue' && hasChildren(row)) { classes.push('vg-parent'); }
    if (canEdit(row)) { classes.push('vg-editable'); }
    return {
      id: row.id,
      group: row.id,
      type: 'range',
      start: start,
      end: end,
      content: esc(barLabel(row)),
      title: tooltip(row),
      className: classes.join(' '),
      style: barBackground(row),
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

    var newGroups = data.rows.map(toGroup);
    var newItems = data.rows.map(toItem).filter(Boolean);
    syncDataSet(groups, newGroups);
    syncDataSet(items, newItems);
    scheduleArrows();
  }

  function toggle(id) {
    collapsed[id] = !collapsed[id];
    refreshGroups();
  }

  function setAllCollapsed(value) {
    rowOrder.forEach(function (row) {
      if (hasChildren(row)) { collapsed[row.id] = value; }
    });
    refreshGroups();
  }

  function refreshGroups() {
    groups.update(rowOrder.map(toGroup));
    scheduleArrows();
  }

  function reload() {
    return fetch(config.dataUrl, {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (response) {
      if (!response.ok) { throw new Error(response.status + ' ' + response.statusText); }
      return response.json();
    }).then(applyData);
  }

  // -------------------------------------------------------------- saving

  function saveDates(row, start, due) {
    var url = config.updateUrlTemplate.replace('__ID__', row.issue_id);
    return fetch(url, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': csrfToken(),
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ issue: { start_date: start, due_date: due, lock_version: row.lock_version } })
    }).then(function (response) {
      return response.text().then(function (text) {
        var body = {};
        try { body = text ? JSON.parse(text) : {}; } catch (e) { /* not JSON */ }
        if (response.ok) { return body; }
        var error = new Error((body.errors && body.errors.join(' ')) || t.failed + ' (' + response.status + ')');
        error.status = response.status;
        throw error;
      });
    });
  }

  // -------------------------------------------------------- drag & drop

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
      if (!(row.editable.start && row.editable.due)) { return callback(null); }
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
    callback(item);
  }

  function onMove(item, callback) {
    var original = items.get(item.id);
    var row = original.row;
    var start = formatDay(item.start);
    var due = formatDay(addDays(item.end, -1));

    if (start === (row.start) && due === (row.due)) { return callback(null); }

    setStatus(t.saving, 'progress');
    saveDates(row, start, due).then(function () {
      callback(item);
      return reload();
    }).then(function () {
      setStatus(t.saved, 'ok');
    }, function (error) {
      callback(null);
      setStatus(error.message || t.failed, 'error');
      // The chart may be stale (e.g. somebody else changed the issue).
      if (error.status === 409) { reload(); }
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
    arrowLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowLayer.setAttribute('class', 'vg-arrows');
    host.appendChild(arrowLayer);
    return arrowLayer;
  }

  function svg(tag, attributes) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attributes).forEach(function (key) { node.setAttribute(key, attributes[key]); });
    return node;
  }

  // Draws "blocks" and "precedes" relations between the bars that are
  // currently in the DOM, from the right end of one bar to the left end of the
  // other, with an elbow like the built-in Gantt does.
  function drawArrows() {
    var layer = ensureArrowLayer();
    if (!layer) { return; }
    while (layer.firstChild) { layer.removeChild(layer.firstChild); }
    if (!showRelations) { return; }

    var host = timeline.dom.center;
    var hostRect = host.getBoundingClientRect();
    layer.setAttribute('width', host.clientWidth);
    layer.setAttribute('height', host.clientHeight);

    var defs = svg('defs', {});
    Object.keys(RELATION_COLORS).forEach(function (type) {
      var marker = svg('marker', {
        id: 'vg-arrow-' + type, markerWidth: 8, markerHeight: 8, refX: 7, refY: 4,
        orient: 'auto', markerUnits: 'userSpaceOnUse'
      });
      marker.appendChild(svg('path', { d: 'M0,0 L8,4 L0,8 z', fill: RELATION_COLORS[type] }));
      defs.appendChild(marker);
    });
    layer.appendChild(defs);

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

    relations.forEach(function (relation) {
      var from = box(relation.from);
      var to = box(relation.to);
      if (!from || !to) { return; }
      var margin = 8;
      var x1 = from.right;
      var x2 = to.left;
      var points = [[x1, from.mid], [x1 + margin, from.mid]];
      if (x2 - margin >= x1 + margin) {
        points.push([x1 + margin, to.mid]);
      } else {
        // Target starts before the source ends: route around the bars.
        var midY = from.mid + (to.mid >= from.mid ? 10 : -10);
        points.push([x1 + margin, midY], [x2 - margin, midY]);
      }
      points.push([x2 - margin, to.mid], [x2, to.mid]);
      layer.appendChild(svg('polyline', {
        points: points.map(function (p) { return p.join(','); }).join(' '),
        fill: 'none', stroke: RELATION_COLORS[relation.type] || '#888', 'stroke-width': 1.5,
        'marker-end': 'url(#vg-arrow-' + relation.type + ')'
      }));
    });
  }

  // -------------------------------------------------------------- toolbar

  function buildToolbar() {
    var bar = document.getElementById('vis-gantt-toolbar');

    function button(label, className, handler) {
      var b = el('a', className, label);
      b.href = '#';
      b.addEventListener('click', function (event) { event.preventDefault(); handler(); });
      bar.appendChild(b);
      return b;
    }

    button(t.zoomIn, 'icon icon-zoom-in', function () { timeline.zoomIn(0.4); });
    button(t.zoomOut, 'icon icon-zoom-out', function () { timeline.zoomOut(0.4); });
    button(t.today, '', function () { timeline.moveTo(new Date()); });
    button(t.fit, '', function () { timeline.fit(); });
    button(t.expandAll, '', function () { setAllCollapsed(false); });
    button(t.collapseAll, '', function () { setAllCollapsed(true); });

    var label = el('label', 'vg-toggle');
    var checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = showRelations;
    checkbox.addEventListener('change', function () { showRelations = checkbox.checked; drawArrows(); });
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(' ' + t.relations));
    bar.appendChild(label);
  }

  // ----------------------------------------------------------------- init

  function chartHeight() {
    var top = root.getBoundingClientRect().top + window.pageYOffset;
    return Math.max(320, Math.round(window.innerHeight - (top - window.pageYOffset) - 40));
  }

  // Like the built-in Gantt: from the start of this month, six months wide.
  function initialWindow() {
    var now = new Date();
    var start = addDays(new Date(now.getFullYear(), now.getMonth(), 1), -7);
    var end = new Date(now.getFullYear(), now.getMonth() + 6, 1);
    return { start: start, end: end };
  }

  function init() {
    buildToolbar();
    applyData(config.initial);

    var win = initialWindow();
    var options = {
      locale: config.locale,
      orientation: { axis: 'top', item: 'top' },
      start: win.start,
      end: win.end,
      maxHeight: chartHeight() + 'px',
      stack: false,
      margin: { item: { horizontal: 0, vertical: 4 }, axis: 4 },
      zoomMin: 3 * DAY,
      zoomMax: 20 * 365 * DAY,
      zoomKey: 'ctrlKey',
      verticalScroll: true,
      showCurrentTime: true,
      showWeekScale: true,
      groupOrder: 'order',
      groupTemplate: function (group) { return buildLabel(group.row); },
      editable: { updateTime: true, updateGroup: false, add: false, remove: false },
      itemsAlwaysDraggable: { item: true, range: true },
      selectable: true,
      snap: function (date) { return snapDay(date); },
      onMoving: onMoving,
      onMove: onMove,
      tooltip: { followMouse: true, overflowMethod: 'cap' }
    };

    timeline = new vis.Timeline(root, items, groups, options);

    // Open an issue/version/project on double click.
    timeline.on('doubleClick', function (props) {
      var row = rowsById[props.item || props.group];
      if (row && row.url) { window.location.href = row.url; }
    });

    ['changed', 'rangechanged', 'scroll'].forEach(function (name) { timeline.on(name, scheduleArrows); });
    window.addEventListener('resize', function () {
      timeline.setOptions({ maxHeight: chartHeight() + 'px' });
      scheduleArrows();
    });

    if (!rowOrder.length) { setStatus(t.empty); }
    window.visGantt = { timeline: timeline, items: items, groups: groups, reload: reload };
  }

  init();
  }
})();
