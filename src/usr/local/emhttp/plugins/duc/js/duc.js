/* Disk Usage (duc) browser for the Unraid webGUI.
 *
 * Data comes from api.php, which wraps `duc json`. Every name from the index is
 * inserted with textContent / setAttribute, never as HTML, because file names
 * on a share are user controlled.
 */
var DucBrowser = (function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var RINGS = 4;            // levels drawn in the chart
  var INNER = 72;           // radius of the centre disc
  var OUTER = 296;
  var LIST_LIMIT = 500;     // rows shown in the table
  var COLUMN = { actual: 1, apparent: 2, count: 3 };   // fields of a history point after its time
  var CHART = { w: 800, h: 200, left: 64, right: 12, top: 12, bottom: 26 };

  var opt, el = {};
  var state = { roots: [], root: null, path: null, mode: 'actual', period: 30, running: false, statusTimer: null,
                listTree: null, history: null };
  var seq = 0;              // discards responses from superseded navigations

  function $(id) { return document.getElementById(id); }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem('duc.' + key);
      localStorage.setItem('duc.' + key, value);
    } catch (e) { return null; }
  }

  function human(bytes) {
    var units = ['B', 'K', 'M', 'G', 'T', 'P'];
    var i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return (i === 0 ? bytes : bytes.toFixed(bytes < 10 ? 1 : 0)) + units[i];
  }

  function value(node) {
    if (state.mode === 'count') return node.type === 'dir' ? node.count : 1;
    return state.mode === 'apparent' ? node.size_apparent : node.size_actual;
  }

  function fmt(v) { return state.mode === 'count' ? v.toLocaleString() : human(v); }

  function join(dir, name) { return (dir === '/' ? '' : dir) + '/' + name; }

  function parent(path) {
    var i = path.lastIndexOf('/');
    return i <= 0 ? '/' : path.slice(0, i);
  }

  function api(params) {
    var q = new URLSearchParams(params).toString();
    return fetch(opt.api + '?' + q, { credentials: 'same-origin' }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || r.statusText);
        return body;
      });
    });
  }

  function post(action) {
    var body = new URLSearchParams({ action: action, csrf_token: opt.csrf });
    return fetch(opt.api, { method: 'POST', body: body, credentials: 'same-origin' })
      .then(function (r) { return r.json(); });
  }

  function message(text, isError) {
    el.message.textContent = text || '';
    el.message.className = 'duc-message' + (isError ? ' error' : '');
    el.message.style.display = text ? '' : 'none';
  }

  /* ---------- status / index runs ---------- */

  function refreshStatus() {
    clearTimeout(state.statusTimer);
    return api({ action: 'status' }).then(function (s) {
      var st = s.status || {};
      var wasRunning = state.running;
      state.running = st.state === 'running';

      el.run.style.display = state.running ? 'none' : '';
      el.cancel.style.display = state.running ? '' : 'none';

      var text = '';
      if (state.running) {
        text = opt.text.running + '… ' + (st.progress || '');
      } else if (st.state === 'failed') {
        text = opt.text.failed + ': ' + (st.message || '');
      } else if (st.state === 'cancelled') {
        text = opt.text.cancelled;
      } else if (s.database.exists) {
        text = opt.text.lastRun + ': ' + new Date(s.database.modified * 1000).toLocaleString();
      }
      el.state.textContent = text;
      el.state.className = st.state === 'failed' ? 'error' : '';
      el.state.title = (s.log || []).join('\n');

      setRoots(s.roots || []);
      el.body.style.display = s.database.exists ? '' : 'none';
      if (!s.database.exists) {
        message(opt.text.noIndex);
        clearView();
      } else if (wasRunning && !state.running) {
        load();                                   // fresh index available
      }
      state.statusTimer = setTimeout(refreshStatus, state.running ? 3000 : 30000);
    }).catch(function (e) {
      el.state.textContent = e.message;
      state.statusTimer = setTimeout(refreshStatus, 30000);
    });
  }

  function setRoots(roots) {
    var paths = roots.map(function (r) { return r.path; });
    if (paths.join('\n') === state.roots.map(function (r) { return r.path; }).join('\n')) {
      state.roots = roots;
      return;
    }
    state.roots = roots;
    el.root.textContent = '';
    roots.forEach(function (r) {
      var o = document.createElement('option');
      o.value = r.path;
      o.textContent = r.path + '  (' + human(r.size) + ')';
      el.root.appendChild(o);
    });
    if (!roots.length) return;
    var saved = store('root');
    var root = paths.indexOf(state.root) >= 0 ? state.root : (paths.indexOf(saved) >= 0 ? saved : paths[0]);
    el.root.value = root;
    if (root !== state.root) {
      state.root = root;
      var savedPath = store('path');
      navigate(savedPath && (savedPath === root || savedPath.indexOf(join(root, '')) === 0) ? savedPath : root);
    }
  }

  /* ---------- navigation ---------- */

  function navigate(path) {
    state.path = path;
    store('root', state.root);
    store('path', path);
    load();
  }

  function load() {
    if (!state.path) return;
    var my = ++seq;
    var apparent = state.mode === 'apparent' ? '1' : '0';
    var known = currentSize();
    var min = state.mode === 'count' ? 0 : Math.floor(known / 2000);

    renderCrumbs();
    message('');
    el.chart.classList.add('loading');

    Promise.all([
      api({ action: 'ls', path: state.path, levels: RINGS, min: min, apparent: apparent }),
      api({ action: 'ls', path: state.path, levels: 1, min: 0, apparent: apparent }),
      api({ action: 'history', root: state.root, path: state.path }).catch(function () { return null; })
    ]).then(function (res) {
      if (my !== seq) return;
      el.chart.classList.remove('loading');
      sortTree(res[0]);
      sortTree(res[1]);
      state.listTree = res[1];
      state.history = res[2];
      drawChart(res[0]);
      drawList(res[1]);
      drawHistory();
    }).catch(function (e) {
      if (my !== seq) return;
      el.chart.classList.remove('loading');
      clearView();
      message(e.message, true);
      if (state.path !== state.root) {           // folder vanished from a newer index
        state.path = state.root;
        store('path', state.root);
      }
    });
  }

  function currentSize() {
    var r = state.roots.filter(function (x) { return x.path === state.root; })[0];
    return state.lastSize && state.lastSizePath === state.path ? state.lastSize : (r ? r.size : 0);
  }

  function sortTree(node) {
    if (!node.children) return;
    node.children.sort(function (a, b) { return value(b) - value(a); });
    node.children.forEach(sortTree);
  }

  function renderCrumbs() {
    el.crumbs.textContent = '';
    var parts = [{ label: state.root, path: state.root }];
    if (state.path !== state.root) {
      var rel = state.path.slice(state.root.length).replace(/^\//, '');
      var acc = state.root;
      rel.split('/').forEach(function (seg) {
        acc = join(acc, seg);
        parts.push({ label: seg, path: acc });
      });
    }
    parts.forEach(function (p, i) {
      if (i) el.crumbs.appendChild(document.createTextNode(' / '));
      var a = document.createElement(i === parts.length - 1 ? 'span' : 'a');
      a.textContent = p.label;
      if (i < parts.length - 1) {
        a.href = '#';
        a.addEventListener('click', function (e) { e.preventDefault(); navigate(p.path); });
      }
      el.crumbs.appendChild(a);
    });
  }

  function clearView() {
    el.chart.textContent = '';
    el.list.textContent = '';
    el.more.textContent = '';
    el.history.style.display = 'none';
    el.periodLabel.style.display = 'none';
    state.listTree = state.history = null;
  }

  /* ---------- sunburst ---------- */

  function arcPath(a0, a1, r0, r1) {
    if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
    var large = a1 - a0 > Math.PI ? 1 : 0;
    function pt(a, r) { return (r * Math.sin(a)).toFixed(2) + ' ' + (-r * Math.cos(a)).toFixed(2); }
    return 'M' + pt(a0, r1) + ' A' + r1 + ' ' + r1 + ' 0 ' + large + ' 1 ' + pt(a1, r1) +
           ' L' + pt(a1, r0) + ' A' + r0 + ' ' + r0 + ' 0 ' + large + ' 0 ' + pt(a0, r0) + 'Z';
  }

  function drawChart(tree) {
    el.chart.textContent = '';
    var total = value(tree);
    state.lastSize = tree.size_actual;
    state.lastSizePath = state.path;
    var ring = (OUTER - INNER) / RINGS;

    function walk(node, path, a0, depth, hue) {
      var a = a0;
      (node.children || []).forEach(function (child, i) {
        var v = value(child);
        var span = total > 0 ? (v / total) * Math.PI * 2 : 0;
        if (span < 0.004) { a += span; return; }
        var h = depth === 0 ? (i * 137.508) % 360 : hue;
        var full = join(path, child.name);
        var p = document.createElementNS(SVGNS, 'path');
        p.setAttribute('d', arcPath(a, a + span, INNER + depth * ring, INNER + (depth + 1) * ring - 1));
        var light = 52 + depth * 9;
        p.setAttribute('fill', child.type === 'dir'
          ? 'hsl(' + h + ',62%,' + light + '%)'
          : 'hsl(' + h + ',18%,' + (light + 6) + '%)');
        p.setAttribute('class', child.type === 'dir' ? 'dir' : 'file');
        p.addEventListener('mousemove', function (e) { tip(e, full, child, total); });
        p.addEventListener('mouseleave', hideTip);
        if (child.type === 'dir') {
          p.addEventListener('click', function () { hideTip(); state.lastSize = child.size_actual; state.lastSizePath = full; navigate(full); });
        }
        el.chart.appendChild(p);
        if (child.children && depth + 1 < RINGS) walk(child, full, a, depth + 1, h);
        a += span;
      });
    }
    walk(tree, state.path, 0, 0, 0);

    var c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('r', INNER - 2);
    c.setAttribute('class', 'centre' + (state.path !== state.root ? ' up' : ''));
    if (state.path !== state.root) {
      var t = document.createElementNS(SVGNS, 'title');
      t.textContent = opt.text.up;
      c.appendChild(t);
      c.addEventListener('click', function () { navigate(parent(state.path)); });
    }
    el.chart.appendChild(c);

    var name = state.path === state.root ? state.root : state.path.slice(state.path.lastIndexOf('/') + 1);
    label(name.length > 18 ? name.slice(0, 17) + '…' : name, -8, 'label-name');
    label(fmt(total), 14, 'label-size');
  }

  function label(text, y, cls) {
    var t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('y', y);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', cls);
    t.textContent = text;
    el.chart.appendChild(t);
  }

  function tip(e, path, node, total) {
    var pct = total ? (value(node) / total * 100).toFixed(1) : 0;
    el.tip.textContent = '';
    var b = document.createElement('strong');
    b.textContent = path.slice(path.lastIndexOf('/') + 1);
    el.tip.appendChild(b);
    el.tip.appendChild(document.createElement('br'));
    el.tip.appendChild(document.createTextNode(
      fmt(value(node)) + ' (' + pct + '%)' +
      (node.type === 'dir' ? ' · ' + node.count.toLocaleString() + ' ' + opt.text.files : '')));
    var box = el.chart.parentNode.getBoundingClientRect();
    el.tip.style.left = (e.clientX - box.left + 14) + 'px';
    el.tip.style.top = (e.clientY - box.top + 14) + 'px';
    el.tip.style.display = 'block';
  }

  function hideTip() { el.tip.style.display = 'none'; }

  /* ---------- listing ---------- */

  function drawList(tree) {
    el.list.textContent = '';
    el.more.textContent = '';
    var hist = state.history;
    var ref = referencePoint();
    var children = hist && hist.enabled && ref ? hist.children : null;
    el.table.classList.toggle('no-delta', !children || !Object.keys(children).length);
    el.deltaHead.textContent = ref ? opt.text.historySince + ' ' + shortDate(ref[0]) : opt.text.change;
    el.deltaHead.title = ref ? opt.text.historySince + ' ' + longDate(ref[0], true) + '. ' + opt.text.changeTitle
                             : opt.text.changeTitle;
    var total = value(tree);
    var kids = tree.children || [];
    if (!kids.length) {
      el.more.textContent = opt.text.empty;
      return;
    }
    kids.slice(0, LIST_LIMIT).forEach(function (child) {
      var v = value(child);
      var pct = total ? v / total * 100 : 0;
      var tr = document.createElement('tr');

      var name = document.createElement('td');
      name.className = 'name';
      var icon = document.createElement('i');
      icon.className = 'fa ' + (child.type === 'dir' ? 'fa-folder' : 'fa-file-o');
      name.appendChild(icon);
      var full = join(state.path, child.name);
      if (child.type === 'dir') {
        var a = document.createElement('a');
        a.href = '#';
        a.textContent = child.name;
        a.addEventListener('click', function (e) {
          e.preventDefault();
          state.lastSize = child.size_actual;
          state.lastSizePath = full;
          navigate(full);
        });
        name.appendChild(a);
      } else {
        name.appendChild(document.createTextNode(child.name));
      }
      tr.appendChild(name);

      var size = document.createElement('td');
      size.className = 'size';
      size.textContent = fmt(v);
      tr.appendChild(size);

      var delta = document.createElement('td');
      delta.className = 'delta';
      if (children && child.type === 'dir') showDelta(delta, children[child.name], v, ref[0]);
      tr.appendChild(delta);

      var bar = document.createElement('td');
      bar.className = 'pct';
      var outer = document.createElement('div');
      outer.className = 'bar';
      var inner = document.createElement('div');
      inner.style.width = pct.toFixed(1) + '%';
      outer.appendChild(inner);
      bar.appendChild(outer);
      bar.appendChild(document.createTextNode(pct.toFixed(1)));
      tr.appendChild(bar);

      var files = document.createElement('td');
      files.className = 'files';
      files.textContent = child.type === 'dir' ? child.count.toLocaleString() : '';
      tr.appendChild(files);

      el.list.appendChild(tr);
    });
    if (kids.length > LIST_LIMIT) {
      el.more.textContent = (kids.length - LIST_LIMIT).toLocaleString() + ' ' + opt.text.more;
    }
  }

  /* ---------- history ---------- */

  function pointValue(p) { return p[COLUMN[state.mode]]; }

  /* Month names keep dates unambiguous in every locale (9 Nov, Nov 9, 9. Nov.). */
  function shortDate(t) {
    return new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function longDate(t, withTime) {
    var o = { day: 'numeric', month: 'short', year: 'numeric' };
    if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
    return new Date(t * 1000).toLocaleString(undefined, o);
  }

  /* The snapshot of the current folder that changes are measured against: the newest one at
     least `period` days older than the latest run, or the oldest one when the history is shorter.
     The slack lets a run that started a little later than the day before still count as a day old. */
  var PERIOD_SLACK = 3 * 3600;

  function referencePoint() {
    var pts = state.history && state.history.points;
    if (!pts || pts.length < 2) return null;
    if (!state.period) return pts[0];
    var cutoff = pts[pts.length - 1][0] - state.period * 86400 + PERIOD_SLACK;
    var ref = pts[0];
    for (var i = 1; i < pts.length && pts[i][0] <= cutoff; i++) ref = pts[i];
    return ref === pts[pts.length - 1] ? pts[pts.length - 2] : ref;
  }

  function showDelta(td, series, current, refTime) {
    var base = null;
    (series || []).forEach(function (p) { if (p[0] <= refTime) base = p; });
    if (!base) {
      // Top-level folders are always recorded, so a missing reference means the folder is new.
      if (series && series.length && state.path === state.root) {
        td.textContent = opt.text.historyNew;
        td.className += ' new';
      }
      return;
    }
    var d = current - pointValue(base);
    td.textContent = d === 0 ? '0' : (d > 0 ? '+' : '−') + fmt(Math.abs(d));
    td.className += d > 0 ? ' up' : (d < 0 ? ' down' : ' same');
    td.title = opt.text.historySince + ' ' + longDate(base[0], true) + ': ' + fmt(pointValue(base));
  }

  function svg(name, attrs, parentNode) {
    var n = document.createElementNS(SVGNS, name);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    (parentNode || el.hchart).appendChild(n);
    return n;
  }

  function drawHistory() {
    var hist = state.history;
    el.hchart.textContent = '';
    hideHistoryTip();
    el.periodLabel.style.display = hist && hist.enabled ? '' : 'none';
    if (!hist || !hist.enabled) { el.history.style.display = 'none'; return; }
    el.history.style.display = '';

    var all = hist.points || [];
    var ref = referencePoint();
    if (all.length < 2 || !ref) {
      var depth = state.path === state.root ? 0 : state.path.slice(state.root.length).replace(/^\//, '').split('/').length;
      el.hnote.textContent = all.length === 1 ? opt.text.historyOne
        : (depth > hist.depth ? opt.text.historyDeeper : opt.text.historyNone);
      el.hchart.style.display = 'none';
      return;
    }
    el.hnote.textContent = opt.text.historySince + ' ' + longDate(ref[0]);
    el.hchart.style.display = '';

    var pts = all.filter(function (p) { return p[0] >= ref[0]; });
    var t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    var vals = pts.map(pointValue);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = (hi - lo) * 0.1 || Math.max(hi * 0.01, 1);
    lo = Math.max(0, lo - pad); hi += pad;
    var c = CHART, pw = c.w - c.left - c.right, ph = c.h - c.top - c.bottom;
    function x(t) { return c.left + (t1 > t0 ? (t - t0) / (t1 - t0) * pw : pw / 2); }
    function y(v) { return c.top + (1 - (v - lo) / (hi - lo)) * ph; }

    for (var g = 0; g <= 3; g++) {
      var gv = lo + (hi - lo) * g / 3;
      svg('line', { x1: c.left, x2: c.w - c.right, y1: y(gv), y2: y(gv), 'class': 'grid' });
      svg('text', { x: c.left - 6, y: y(gv) + 4, 'text-anchor': 'end' }).textContent = fmt(Math.round(gv));
    }
    [t0, (t0 + t1) / 2, t1].forEach(function (t, i) {
      svg('text', { x: x(t), y: c.h - 6, 'text-anchor': ['start', 'middle', 'end'][i] })
        .textContent = new Date(t0 * 1000).getFullYear() === new Date(t1 * 1000).getFullYear() ? shortDate(t) : longDate(t);
    });

    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(pointValue(p)).toFixed(1); }).join(' ');
    svg('path', { d: line + ' L' + x(t1).toFixed(1) + ' ' + (c.top + ph) + ' L' + x(t0).toFixed(1) + ' ' + (c.top + ph) + 'Z', 'class': 'area' });
    svg('path', { d: line, 'class': 'line' });
    if (pts.length <= 60) pts.forEach(function (p) { svg('circle', { cx: x(p[0]), cy: y(pointValue(p)), r: 2.5, 'class': 'dot' }); });

    var marker = svg('circle', { r: 4.5, 'class': 'marker', style: 'display:none' });
    var hit = svg('rect', { x: c.left, y: c.top, width: pw, height: ph, 'class': 'hit' });
    hit.addEventListener('mousemove', function (e) {
      var box = el.hchart.getBoundingClientRect();
      var t = t0 + ((e.clientX - box.left) / box.width * c.w - c.left) / pw * (t1 - t0);
      var best = pts[0];
      pts.forEach(function (p) { if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; });
      marker.setAttribute('cx', x(best[0]));
      marker.setAttribute('cy', y(pointValue(best)));
      marker.style.display = '';
      el.htip.textContent = longDate(best[0], true) + ': ' + fmt(pointValue(best));
      var wrap = el.hchart.parentNode.getBoundingClientRect();
      el.htip.style.display = 'block';
      var left = e.clientX - wrap.left + 14;
      if (left + el.htip.offsetWidth > wrap.width) left = e.clientX - wrap.left - el.htip.offsetWidth - 14;
      el.htip.style.left = Math.max(0, left) + 'px';
      el.htip.style.top = (e.clientY - wrap.top + 14) + 'px';
    });
    hit.addEventListener('mouseleave', function () { marker.style.display = 'none'; hideHistoryTip(); });
  }

  function hideHistoryTip() { el.htip.style.display = 'none'; }

  /* ---------- init ---------- */

  function init(options) {
    opt = options;
    ['root', 'mode', 'state', 'run', 'cancel', 'message', 'crumbs', 'chart', 'tip', 'list', 'more']
      .forEach(function (k) { el[k] = $('duc-' + k); });
    el.body = document.querySelector('#duc-app .duc-body');
    el.table = document.querySelector('#duc-app table.duc-list');
    el.history = $('duc-history');
    el.hchart = $('duc-history-chart');
    el.hnote = $('duc-history-note');
    el.htip = $('duc-history-tip');
    el.period = $('duc-period');
    el.periodLabel = $('duc-period-label');
    el.deltaHead = $('duc-delta-head');

    state.mode = store('mode') || 'actual';
    el.mode.value = state.mode;
    var period = store('period');
    state.period = period !== null && period !== undefined && /^\d+$/.test(period) ? +period : 30;
    el.period.value = String(state.period);
    if (el.period.value !== String(state.period)) { state.period = 30; el.period.value = '30'; }

    el.root.addEventListener('change', function () {
      state.root = el.root.value;
      state.lastSize = 0;
      navigate(state.root);
    });
    el.mode.addEventListener('change', function () {
      state.mode = el.mode.value;
      store('mode', state.mode);
      load();
    });
    el.period.addEventListener('change', function () {
      state.period = +el.period.value;
      store('period', el.period.value);
      if (state.listTree) drawList(state.listTree);
      drawHistory();
    });
    el.run.addEventListener('click', function () {
      el.run.disabled = true;
      post('index').then(function (r) {
        el.run.disabled = false;
        if (r.error) message(r.error, true);
        refreshStatus();
      });
    });
    el.cancel.addEventListener('click', function () {
      post('cancel').then(refreshStatus);
    });

    refreshStatus();
  }

  return { init: init };
})();
