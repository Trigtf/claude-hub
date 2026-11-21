const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const searchEl = $('#search');
const tabsEl = $('#tabs');
const termsEl = $('#terms');
const emptyEl = $('#empty');
const dropEl = $('#drop');
const hintEl = $('#drop-hint');
const chipsEl = $('#chips');
const autoEl = $('#auto');

let projects = [];
const sessions = new Map();
const byId = new Map();
let activeKey = null;
let nextId = 1;
const inboxByKey = new Map();
const currentInbox = () => inboxByKey.get(activeKey) || [];

const keyOf = (p) => (p.special ? `special:${p.special}` : p.path.toLowerCase());
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return t('now');
  if (s < 3600) return t('{n}m ago', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n}h ago', { n: Math.floor(s / 3600) });
  return t('{n}d ago', { n: Math.floor(s / 86400) });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------- project list ----------
function renderList() {
  const q = searchEl.value.trim().toLowerCase();
  listEl.textContent = '';
  const shown = projects.filter((p) => `${p.name} ${p.path}`.toLowerCase().includes(q));
  if (!shown.length) {
    listEl.appendChild(el('li', 'msg', projects.length ? t('No results.') : t('Loading...')));
    return shown;
  }
  const lastPinned = q ? -1 : shown.reduce((n, p, i) => (p.pinned ? i : n), -1);
  shown.forEach((p, i) => {
    const key = keyOf(p);
    const li = el('li');
    if (sessions.has(key)) li.classList.add('open');
    if (key === activeKey) li.classList.add('active');
    if (p.pinned) li.classList.add('pinned');
    if (i === lastPinned && i < shown.length - 1) li.classList.add('group-end');
    li.title = p.path;
    li.appendChild(el('span', 'dot'));
    const txt = el('div', 'txt');
    txt.appendChild(el('div', 'name', p.name));
    const when = ago(p.last_session);
    txt.appendChild(el('div', 'sub', when ? `${when}  •  ${p.path}` : p.path));
    li.appendChild(txt);
    const pin = el('button', 'pinbtn', p.pinned ? '★' : '☆');
    pin.title = p.pinned ? t('Unpin') : t('Pin to top');
    pin.addEventListener('click', (e) => { e.stopPropagation(); togglePin(p); });
    pin.addEventListener('mousedown', (e) => e.stopPropagation());
    li.appendChild(pin);
    li.addEventListener('click', () => openProject(p));
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); window.hub.projectMenu(p.path, p.pinned, lang()); });
    if (!q) setupRowDrag(li, p);
    listEl.appendChild(li);
  });
  return shown;
}

async function togglePin(p) {
  const res = await window.hub.pinProject(p.path, p.name, !p.pinned);
  if (!res.ok) { alert(res.error); return; }
  await loadProjects();
}

let dragPath = null;

function clearDropMarks() {
  for (const x of listEl.querySelectorAll('.drop-before, .drop-after')) x.classList.remove('drop-before', 'drop-after');
}

function setupRowDrag(li, p) {
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    dragPath = p.path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-hub-project', p.path);
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => { dragPath = null; li.classList.remove('dragging'); clearDropMarks(); });
  li.addEventListener('dragover', (e) => {
    if (!dragPath || dragPath === p.path) return;
    const dragged = projects.find((x) => x.path === dragPath);
    if (!dragged || dragged.pinned !== p.pinned) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = li.getBoundingClientRect();
    clearDropMarks();
    li.classList.add(e.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
  });
  li.addEventListener('drop', (e) => {
    if (!dragPath || !(li.classList.contains('drop-before') || li.classList.contains('drop-after'))) return;
    e.preventDefault();
    const after = li.classList.contains('drop-after');
    const moved = dragPath;
    clearDropMarks();
    moveProject(moved, p.path, after);
  });
}

async function moveProject(draggedPath, targetPath, after) {
  const from = projects.findIndex((x) => x.path === draggedPath);
  if (from < 0) return;
  const [item] = projects.splice(from, 1);
  let to = projects.findIndex((x) => x.path === targetPath);
  if (to < 0) { projects.splice(from, 0, item); return; }
  if (after) to += 1;
  projects.splice(to, 0, item);
  renderList();
  const res = await window.hub.setOrder(projects.map((x) => x.path));
  if (!res.ok) { alert(res.error); await loadProjects(); }
}

window.hub.onProjectAction(async ({ action, path: projectPath }) => {
  if (action === 'pin') {
    const p = projects.find((x) => x.path === projectPath);
    if (p) await togglePin(p);
  } else if (action === 'resetOrder') {
    const res = await window.hub.setOrder(null);
    if (!res.ok) alert(res.error);
    await loadProjects();
  }
});

async function loadProjects() {
  const res = await window.hub.listProjects();
  if (res.error) {
    listEl.textContent = '';
    listEl.appendChild(el('li', 'msg', res.error));
    return;
  }
  projects = res.projects;
  renderList();
}

// ---------- terminals ----------
function renderTabs() {
  tabsEl.textContent = '';
  for (const s of sessions.values()) {
    const tab = el('div', 'tab');
    if (s.key === activeKey) tab.classList.add('active');
    if (!s.alive) tab.classList.add('dead');
    tab.title = s.project.path;
    tab.appendChild(el('span', 'dot'));
    tab.appendChild(el('span', null, s.project.name));
    if (s.newFiles) {
      const badge = el('span', 'newbadge', String(s.newFiles));
      badge.title = t('New files from Claude');
      tab.appendChild(badge);
    }
    const x = el('button', 'x', '×');
    x.title = t('Close');
    x.addEventListener('click', (e) => { e.stopPropagation(); closeSession(s); });
    tab.appendChild(x);
    tab.addEventListener('click', () => activate(s.key));
    tabsEl.appendChild(tab);
  }
}

const TERM_THEMES = {
  dark: { background: '#14161a', foreground: '#d7dae0', cursor: '#d97757', selectionBackground: '#3a4352' },
  light: {
    background: '#f6f7f9', foreground: '#1f2430', cursor: '#c4562f', selectionBackground: '#bcd2f0', cursorAccent: '#f6f7f9',
    black: '#1f2430', red: '#c0362c', green: '#1a7f3c', yellow: '#8a6a00', blue: '#1f5fbf', magenta: '#8a3fa0', cyan: '#0f7c88', white: '#5f6775',
    brightBlack: '#5f6775', brightRed: '#d9473b', brightGreen: '#23994a', brightYellow: '#a07c00', brightBlue: '#2f73d9', brightMagenta: '#a352bb', brightCyan: '#1a95a3', brightWhite: '#1f2430',
  },
};

function currentTheme() { return localStorage.getItem('hubTheme') === 'light' ? 'light' : 'dark'; }

function applyTheme() {
  const t = currentTheme();
  document.documentElement.dataset.theme = t;
  for (const s of sessions.values()) {
    s.term.options.theme = TERM_THEMES[t];
    s.term.options.minimumContrastRatio = t === 'light' ? 4.5 : 1;
  }
}
document.documentElement.dataset.theme = currentTheme();

// Electron 45 made the main-process clipboard API async and removed readImage, so read it
// here with the standard web API (text wins over image: Word/browsers put both on the clipboard).
async function readClipboardData() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) return { type: 'text', text };
  } catch { /* fall through to images */ }
  try {
    for (const item of await navigator.clipboard.read()) {
      const mime = item.types.find((t) => t.startsWith('image/'));
      if (!mime) continue;
      const buf = await (await item.getType(mime)).arrayBuffer();
      return { type: 'image', path: await window.hub.saveImage(buf, mime.split('/')[1].replace(/[^a-z0-9]/gi, '') || 'png') };
    }
  } catch { /* nothing readable */ }
  return window.hub.readClipboard().catch(() => ({ type: 'empty' }));
}

const DEFAULT_FONT = 'Cascadia Mono';
const DEFAULT_SIZE = 14;

function termFontSettings() {
  const size = Math.round(Number(localStorage.getItem('termFontSize')));
  return {
    family: localStorage.getItem('termFont') || DEFAULT_FONT,
    size: size >= 8 && size <= 32 ? size : DEFAULT_SIZE,
  };
}

function cssFontFamily(name) {
  const clean = String(name).replace(/["'<>;{}]/g, '').trim() || DEFAULT_FONT;
  return clean.includes(',') ? clean : `"${clean}", "Cascadia Mono", Consolas, "Courier New", monospace`;
}

// delta: +1 / -1 steps, 0 resets to the default size. Shared by Ctrl+plus/minus/0 and Ctrl+wheel.
function zoomTerm(delta) {
  const cur = termFontSettings().size;
  const next = delta === 0 ? DEFAULT_SIZE : Math.min(32, Math.max(8, cur + delta));
  if (next === cur) return;
  localStorage.setItem('termFontSize', String(next));
  applyTermFont();
  flashHint(t('Font size: {n}', { n: next }));
}

function applyTermFont() {
  const { family, size } = termFontSettings();
  for (const s of sessions.values()) {
    s.term.options.fontFamily = cssFontFamily(family);
    s.term.options.fontSize = size;
  }
  fitActive();
}

let webglBroken = false;
const webglEnabled = () => localStorage.getItem('termWebgl') !== '0' && !webglBroken;

function setWebgl(s, on) {
  if (on && !s.webgl) {
    try {
      const addon = new WebglAddon.WebglAddon();
      addon.onContextLoss(() => {
        try { addon.dispose(); } catch { /* already gone */ }
        if (s.webgl === addon) s.webgl = null;
      });
      s.term.loadAddon(addon);
      s.webgl = addon;
    } catch {
      webglBroken = true;
      s.webgl = null;
    }
  } else if (!on && s.webgl) {
    try { s.webgl.dispose(); } catch { /* already gone */ }
    s.webgl = null;
  }
}

function applyWebgl() {
  for (const x of sessions.values()) setWebgl(x, x.key === activeKey && webglEnabled());
}

function fitActive() {
  const s = sessions.get(activeKey);
  if (s) { try { s.fit.fit(); } catch { /* not visible yet */ } }
}

function activate(key) {
  activeKey = key;
  for (const s of sessions.values()) s.el.classList.toggle('active', s.key === key);
  applyWebgl();
  emptyEl.style.display = sessions.size ? 'none' : 'grid';
  const s = sessions.get(key);
  if (s) s.newFiles = 0;
  renderTabs();
  renderList();
  renderChips();
  renderOutputs();
  updatePanelTitles();
  persistTabs();
  if (s) {
    requestAnimationFrame(() => { fitActive(); s.term.refresh(0, s.term.rows - 1); s.term.focus(); });
  }
}

function createSession(project) {
  const id = `s${nextId++}`;
  const container = el('div', 'term');
  termsEl.appendChild(container);

  const font = termFontSettings();
  const term = new Terminal({
    fontFamily: cssFontFamily(font.family),
    fontSize: font.size,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: TERM_THEMES[currentTheme()],
    minimumContrastRatio: currentTheme() === 'light' ? 4.5 : 1,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);

  const s = { id, key: keyOf(project), project, el: container, term, fit, alive: false, started: false, typed: false };
  sessions.set(s.key, s);
  byId.set(id, s);

  term.onData((d) => {
    if (!s.alive) {
      if (d === '\r' && s.started) startPty(s);
      return;
    }
    s.typed = true;
    window.hub.write(id, d);
  });
  term.onResize(({ cols, rows }) => { if (s.alive) window.hub.resize(id, cols, rows); });

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey) return true;
    if (ev.code === 'Equal' || ev.code === 'NumpadAdd') { ev.preventDefault(); zoomTerm(1); return false; }
    if (ev.code === 'Minus' || ev.code === 'NumpadSubtract') { ev.preventDefault(); zoomTerm(-1); return false; }
    if (ev.code === 'Digit0' || ev.code === 'Numpad0') { ev.preventDefault(); zoomTerm(0); return false; }
    // ev.code is the physical key, so this works with any layout (e.g. Greek, where Ctrl+V gives a non-Latin key).
    const k = ev.code === 'KeyV' ? 'v' : ev.code === 'KeyC' ? 'c' : ev.key.toLowerCase();
    if (k === 'v' && !ev.altKey) {
      // Paste explicitly via the main-process clipboard: the native paste event
      // is unreliable in the Electron terminal. preventDefault stops a double paste.
      ev.preventDefault();
      readClipboardData().then((r) => {
        if (r.type === 'image') { addItems([{ path: r.path, isImage: true }], false, s.key); insertPaths([r.path], s); }
        else if (r.type === 'text') term.paste(r.text);
      });
      return false;
    }
    if (k === 'c' && term.hasSelection()) {
      window.hub.writeClipboard(term.getSelection());
      term.clearSelection();
      return false;
    }
    return true;
  });

  container.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt || dt.getData('text/plain') || !dt.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    filesFromTransfer(dt).then((items) => { addItems(items, false, s.key); insertPaths(items.map((i) => i.path), s); });
  }, true);

  container.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    zoomTerm(e.deltaY < 0 ? 1 : -1);
  }, { capture: true, passive: false });

  container.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (term.hasSelection()) { window.hub.writeClipboard(term.getSelection()); term.clearSelection(); return; }
    const r = await readClipboardData();
    if (r.type === 'image') { addItems([{ path: r.path, isImage: true }], false, s.key); insertPaths([r.path], s); }
    else if (r.type === 'text') term.paste(r.text);
  });

  return s;
}

async function startPty(s) {
  s.fit.fit();
  const resumeLast = localStorage.getItem('resumeLast') !== '0';
  const resume = (resumeLast && Boolean(s.project.last_session)) || s.typed;
  const res = await window.hub.spawn({ id: s.id, kind: s.project.special || 'claude', cwd: s.project.path, resume, cols: s.term.cols, rows: s.term.rows, lang: lang() });
  s.started = true;
  if (!res.ok) {
    s.term.write(`\r\n\x1b[31m${t('Failed to start: {error}', { error: res.error })}\x1b[0m\r\n`);
    return;
  }
  s.alive = true;
  renderTabs();
}

async function openAuth() {
  const project = { name: 'gcloud auth', path: window.hub.homeDir, special: 'auth', pinned: false };
  const key = keyOf(project);
  const existing = sessions.get(key);
  if (existing) { activate(key); return; }
  const s = createSession(project);
  activate(key);
  await startPty(s);
}

async function openProject(project) {
  const key = keyOf(project);
  let s = sessions.get(key);
  const isNew = !s;
  if (!s) s = createSession(project);
  activate(key);
  if (isNew) await startPty(s);
}

function closeSession(s) {
  if (s.alive && !confirm(t('"{name}" is still running. Close it?', { name: s.project.name }))) return;
  window.hub.kill(s.id);
  s.term.dispose();
  s.el.remove();
  sessions.delete(s.key);
  byId.delete(s.id);
  inboxByKey.delete(s.key);
  outputs = outputs.filter((o) => o.key !== s.key);
  if (activeKey === s.key) {
    const rest = [...sessions.keys()];
    activate(rest.length ? rest[rest.length - 1] : null);
  } else {
    renderTabs();
    renderList();
  }
  persistTabs();
}

let restoring = false;

function persistTabs() {
  if (restoring) return;
  const tabs = [...sessions.values()].filter((s) => !s.project.special).map((s) => s.project.path);
  const active = sessions.get(activeKey);
  localStorage.setItem('openTabs', JSON.stringify({ tabs, active: active && !active.project.special ? active.project.path : null }));
}

async function restoreTabs() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('openTabs') || 'null'); } catch { saved = null; }
  if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return;
  const exists = await window.hub.pathsExist(saved.tabs);
  saved.tabs = saved.tabs.filter((_, i) => exists[i]);
  if (!saved.tabs.length) { persistTabs(); return; }
  restoring = true;
  const find = (p) => projects.find((x) => x.path.toLowerCase() === String(p).toLowerCase())
    || { name: baseName(String(p)), path: String(p), pinned: false, last_session: null };
  for (const p of saved.tabs) await openProject(find(p));
  restoring = false;
  if (saved.active) activate(keyOf(find(saved.active)));
  persistTabs();
}

window.hub.onData((id, data) => { const s = byId.get(id); if (s) s.term.write(data); });
window.hub.onExit((id, code) => {
  const s = byId.get(id);
  if (!s) return;
  s.alive = false;
  const what = s.project.special === 'auth' ? t('Login finished') : t('claude exited');
  s.term.write(`\r\n\x1b[33m${t('[{what} (code {code}). Press Enter to restart.]', { what, code })}\x1b[0m\r\n`);
  renderTabs();
});

new ResizeObserver(() => requestAnimationFrame(fitActive)).observe(termsEl);

// ---------- files / clipboard inbox ----------
let hintTimer;
function flashHint(msg) {
  hintEl.textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hintEl.textContent = t('Drop files/folders here or press Ctrl+V'); }, 3500);
}

function extFromMime(type) {
  const m = /^image\/([a-z0-9]+)/i.exec(type || '');
  return m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : 'png';
}

async function filesFromTransfer(dt) {
  const files = Array.from(dt.files);
  const out = [];
  for (const f of files) {
    const p = window.hub.pathForFile(f);
    if (p) out.push({ path: p, isImage: IMAGE_EXT.test(p) });
    else if (f.type.startsWith('image/')) {
      const saved = await window.hub.saveImage(await f.arrayBuffer(), extFromMime(f.type));
      out.push({ path: saved, isImage: true });
    }
  }
  return out;
}

function fileUrl(p) {
  return encodeURI(`file:///${p.replace(/\\/g, '/')}`).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function renderChips() {
  chipsEl.textContent = '';
  for (const item of currentInbox()) {
    const li = el('li');
    if (item.isImage) {
      li.classList.add('card');
      const img = el('img', 'preview');
      img.src = fileUrl(item.path);
      img.title = t('Click to enlarge');
      img.addEventListener('click', () => showImage(img.src));
      li.appendChild(img);
    } else {
      const m = /\.([a-z0-9]{1,4})$/i.exec(item.path);
      li.appendChild(el('span', 'ico', m ? m[1].toUpperCase() : 'DIR'));
    }
    const name = el('span', 'cname', baseName(item.path));
    name.title = item.path;
    li.appendChild(name);
    const again = el('button', null, '↩');
    again.title = t('Send again to the active terminal');
    again.addEventListener('click', () => insertPaths([item.path]));
    const rm = el('button', null, '×');
    rm.title = t('Remove from list');
    rm.addEventListener('click', () => { inboxByKey.set(activeKey, currentInbox().filter((i) => i !== item)); renderChips(); });
    li.appendChild(again);
    li.appendChild(rm);
    chipsEl.appendChild(li);
  }
}

function insertPaths(paths, session) {
  const s = session || sessions.get(activeKey);
  if (!s || !s.alive) { flashHint(t('Open a project first to send it')); return; }
  s.term.paste(`${paths.map((p) => `"${p}"`).join(' ')} `);
  s.term.focus();
}

function addItems(items, insert, key = activeKey) {
  if (!items.length || !key) return;
  inboxByKey.set(key, [...items].reverse().concat(inboxByKey.get(key) || []).slice(0, 40));
  if (key !== activeKey) return;
  renderChips();
  if (insert && autoEl.checked) insertPaths(items.map((i) => i.path));
}

function requireProject() {
  if (activeKey && sessions.get(activeKey)) return activeKey;
  flashHint(t('Open a project first to add files'));
  return null;
}

async function handleTransfer(dt) {
  const key = requireProject();
  if (!key) return;
  const files = await filesFromTransfer(dt);
  if (files.length) { addItems(files, true, key); return; }
  const text = dt.getData('text/plain');
  if (text) {
    const saved = await window.hub.saveText(text);
    addItems([{ path: saved, isImage: false }], true, key);
  }
}

async function pasteFromClipboard() {
  const key = requireProject();
  if (!key) return;
  const r = await readClipboardData();
  if (r.type === 'image') addItems([{ path: r.path, isImage: true }], true, key);
  else if (r.type === 'text') addItems([{ path: await window.hub.saveText(r.text), isImage: false }], true, key);
  else flashHint(t('The clipboard is empty'));
}

function updatePanelTitles() {
  const s = sessions.get(activeKey);
  const name = s ? s.project.name : '';
  $('#drop-proj').textContent = name;
  $('#out-proj').textContent = name;
}

for (const target of [dropEl, $('#main')]) {
  target.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files') && ![...e.dataTransfer.types].includes('text/plain')) return;
    e.preventDefault();
    dropEl.classList.add('over');
  });
  target.addEventListener('dragleave', (e) => { if (e.target === target || !target.contains(e.relatedTarget)) dropEl.classList.remove('over'); });
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    dropEl.classList.remove('over');
    const dt = e.dataTransfer;
    const files = Array.from(dt.files);
    const text = dt.getData('text/plain');
    // DataTransfer is only valid synchronously, so hand over a snapshot
    handleTransfer({ files, getData: () => text });
  });
}

dropEl.addEventListener('paste', (e) => {
  e.preventDefault();
  const dt = e.clipboardData;
  const files = Array.from(dt.files);
  const text = dt.getData('text/plain');
  if (files.length || text) handleTransfer({ files, getData: () => text });
  else pasteFromClipboard();
});
$('#paste-btn').addEventListener('click', pasteFromClipboard);
$('#inbox-btn').addEventListener('click', () => window.hub.openInbox());

// ---------- sidebar controls ----------
$('#refresh').addEventListener('click', loadProjects);
searchEl.addEventListener('input', renderList);
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const shown = renderList();
    if (shown.length && shown[0]) openProject(shown[0]);
  }
});

function setupSplitter(splitter, cssVar, storeKey, widthFromMouse) {
  const saved = localStorage.getItem(storeKey);
  if (saved) document.documentElement.style.setProperty(cssVar, `${saved}px`);
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    splitter.classList.add('drag');
    const onMove = (ev) => {
      const w = Math.min(640, Math.max(240, widthFromMouse(ev)));
      document.documentElement.style.setProperty(cssVar, `${w}px`);
      localStorage.setItem(storeKey, String(w));
    };
    const onUp = () => {
      splitter.classList.remove('drag');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}
setupSplitter($('#splitter'), '--side', 'side', (ev) => ev.clientX);
setupSplitter($('#splitter-r'), '--right', 'right', (ev) => window.innerWidth - ev.clientX);

const lightbox = $('#lightbox');
lightbox.addEventListener('click', () => { lightbox.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lightbox.hidden = true; });
function showImage(src) {
  lightbox.querySelector('img').src = src;
  lightbox.hidden = false;
}

$('#auth').addEventListener('click', openAuth);

// ---------- files produced by Claude ----------
const outList = $('#outputs-list');
const outCount = $('#out-count');
const onlyDeliv = $('#only-deliv');
const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'pyc', 'css', 'scss', 'less', 'java', 'class', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'cmd', 'ps1', 'lua', 'vue', 'svelte', 'lock', 'map', 'toml', 'ini', 'cfg', 'conf', 'yml', 'yaml', 'json', 'gitignore', 'env']);
const PREVIEW_TEXT_EXT = new Set(['txt', 'md', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml', 'html', 'htm', 'sql', 'ini', 'js', 'py', 'css', 'ts']);
let outputs = [];

const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name) || [, ''])[1].toLowerCase();

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' });
}

function renderOutputs() {
  const mine = outputs.filter((o) => o.key === activeKey);
  const shown = mine.filter((o) => !(onlyDeliv.checked && CODE_EXT.has(o.ext)));
  outCount.textContent = shown.length ? `(${shown.length})` : '';
  outList.textContent = '';
  if (!shown.length) {
    const hidden = mine.length - shown.length;
    outList.appendChild(el('li', 'empty', hidden > 0
      ? t('{n} code files hidden (uncheck "deliverables only" to show them).', { n: hidden })
      : activeKey
        ? t('When Claude creates a file in this project, it will appear here so you can save it.')
        : t('Pick a project to see its files.')));
    return;
  }
  for (const o of shown) {
    const li = el('li', 'out');
    if (o.fresh) li.classList.add('fresh');
    li.draggable = true;
    li.title = t('Drag it to any folder or app');
    li.addEventListener('dragstart', (e) => { e.preventDefault(); window.hub.startDrag(o.path); });

    if (IMAGE_EXT.test(o.name)) {
      const img = el('img', 'oprev');
      img.src = `${fileUrl(o.path)}?t=${Math.round(o.mtime)}`;
      img.addEventListener('click', () => showImage(img.src));
      li.appendChild(img);
    } else if (typeof o.text === 'string') {
      li.appendChild(el('pre', 'otext', o.text.split('\n').slice(0, 8).join('\n').slice(0, 500)));
    } else {
      li.appendChild(el('div', 'obadge', (o.ext || 'FILE').toUpperCase().slice(0, 5)));
    }

    const name = el('div', 'oname', o.name);
    name.title = o.path;
    li.appendChild(name);
    li.appendChild(el('div', 'ometa', `${o.projectName}  •  ${fmtSize(o.size)}  •  ${fmtTime(o.mtime)}`));

    const btns = el('div', 'obtns');
    const save = el('button', 'save', t('Save as...'));
    save.addEventListener('click', async () => {
      const r = await window.hub.saveFile(o.path);
      if (r.saved) { save.textContent = t('Saved'); setTimeout(() => { save.textContent = t('Save as...'); }, 2200); }
      else if (r.error) { save.textContent = t('Error'); save.title = r.error; }
    });
    const open = el('button', null, t('Open'));
    open.addEventListener('click', () => window.hub.openFile(o.path));
    const reveal = el('button', null, t('Folder'));
    reveal.addEventListener('click', () => window.hub.revealFile(o.path));
    btns.append(save, open, reveal);
    li.appendChild(btns);
    outList.appendChild(li);
  }
}

async function addOutput(info) {
  const s = byId.get(info.id);
  const item = { ...info, key: s ? s.key : null, projectName: s ? s.project.name : baseName(info.project), ext: extOf(info.name), fresh: true };
  if (PREVIEW_TEXT_EXT.has(item.ext)) item.text = await window.hub.previewFile(item.path);
  outputs = [item, ...outputs.filter((o) => o.path.toLowerCase() !== item.path.toLowerCase())].slice(0, 60);
  renderOutputs();
  const visible = !(onlyDeliv.checked && CODE_EXT.has(item.ext));
  if (visible && s && item.key === activeKey) {
    outCount.classList.add('pulse');
    setTimeout(() => outCount.classList.remove('pulse'), 4000);
  } else if (visible && s) {
    s.newFiles = (s.newFiles || 0) + 1;
    renderTabs();
  }
  setTimeout(() => { item.fresh = false; for (const li of outList.querySelectorAll('li.fresh')) li.classList.remove('fresh'); }, 5000);
}

window.hub.onNewFile(addOutput);
onlyDeliv.addEventListener('change', renderOutputs);
$('#out-clear').addEventListener('click', () => { outputs = outputs.filter((o) => o.key !== activeKey); renderOutputs(); });
renderOutputs();

// ---------- dialogs: new project / settings ----------
const modal = $('#modal');
const dlgNew = $('#dlg-new');
const dlgSet = $('#dlg-settings');
const newNameEl = $('#new-name');
const newWhereEl = $('#new-where');
const setPathEl = $('#set-path');
let newBase = '';

function openDialog(dlg, focusEl) {
  dlgNew.hidden = dlg !== dlgNew;
  dlgSet.hidden = dlg !== dlgSet;
  modal.hidden = false;
  focusEl.focus();
  focusEl.select();
}

function closeDialog() {
  modal.hidden = true;
  dlgNew.hidden = true;
  dlgSet.hidden = true;
  const s = sessions.get(activeKey);
  if (s) s.term.focus();
}

modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeDialog(); });
for (const b of modal.querySelectorAll('.cancel')) b.addEventListener('click', closeDialog);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeDialog(); });

function updateWhere() {
  const name = newNameEl.value.trim();
  newWhereEl.textContent = name ? `${newBase}\\${name}` : newBase;
}

async function showNewDialog() {
  newBase = (await window.hub.getSettings()).newProjectsPath;
  newNameEl.value = '';
  $('#new-error').textContent = '';
  updateWhere();
  openDialog(dlgNew, newNameEl);
}

const setFontEl = $('#set-font');
const setSizeEl = $('#set-size');
const sampleEl = $('#font-sample');

function updateSample() {
  const size = Math.min(32, Math.max(8, Math.round(Number(setSizeEl.value)) || DEFAULT_SIZE));
  sampleEl.style.fontFamily = cssFontFamily(setFontEl.value);
  sampleEl.style.fontSize = `${size}px`;
}

const MODE_LABELS = {
  default: t('default (asks before each tool)'),
  acceptEdits: t('acceptEdits (auto-accepts file edits)'),
  plan: t('plan (planning only, no changes)'),
  dontAsk: t('dontAsk (denies anything not pre-approved)'),
  auto: t('auto (auto-approves with safety checks)'),
  bypassPermissions: t('bypassPermissions (never asks)'),
};
const cl = {
  path: $('#cl-path'), model: $('#cl-model'), note: $('#cl-model-note'), mode: $('#cl-mode'), warn: $('#cl-mode-warn'),
  skip: $('#cl-skipprompt'), bypassOk: $('#cl-bypassok'), allow: $('#cl-allow'), deny: $('#cl-deny'), ask: $('#cl-ask'),
  update: $('#cl-autoupdate'), channel: $('#cl-channel'),
};
let claudeState = null;

function showSettingsTab(name) {
  for (const b of dlgSet.querySelectorAll('.stab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const pane of dlgSet.querySelectorAll('.spane')) pane.hidden = pane.dataset.pane !== name;
  if (name === 'mcp') refreshMcp();
}
for (const b of dlgSet.querySelectorAll('.stab')) b.addEventListener('click', () => showSettingsTab(b.dataset.tab));

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;

function addEnvRow(container, key = '', value = '') {
  const row = el('div', 'envrow');
  const k = el('input');
  k.type = 'text';
  k.placeholder = 'NAME';
  k.value = key;
  k.spellcheck = false;
  const v = el('input');
  v.placeholder = 'value';
  v.value = value;
  v.spellcheck = false;
  const mask = () => { v.type = SECRET_NAME.test(k.value) ? 'password' : 'text'; };
  mask();
  k.addEventListener('input', mask);
  v.addEventListener('focus', () => { v.type = 'text'; });
  v.addEventListener('blur', mask);
  const rm = el('button', null, '×');
  rm.type = 'button';
  rm.addEventListener('click', () => row.remove());
  row.append(k, v, rm);
  container.appendChild(row);
}

function fillEnv(container, obj) {
  container.textContent = '';
  for (const [k, v] of Object.entries(obj || {})) addEnvRow(container, k, String(v));
}

function collectEnv(container) {
  const out = {};
  for (const row of container.querySelectorAll('.envrow')) {
    const [k, v] = row.querySelectorAll('input');
    if (k.value.trim()) out[k.value.trim()] = v.value;
  }
  return out;
}

for (const b of dlgSet.querySelectorAll('.addrow')) b.addEventListener('click', () => addEnvRow($(`#${b.dataset.target}`)));
cl.mode.addEventListener('change', () => { cl.warn.hidden = cl.mode.value !== 'bypassPermissions'; });

function fillClaude(st) {
  cl.path.textContent = st.path;
  cl.model.value = st.model;
  cl.note.textContent = st.modelSource === 'env'
    ? t('Saved to the ANTHROPIC_MODEL env (your settings.json already uses it, and it overrides the model key).')
    : t('Saved to the model key in settings.json. If ANTHROPIC_MODEL is set in the environment, it takes precedence.');
  cl.mode.textContent = '';
  for (const m of st.modes) {
    const opt = el('option', null, MODE_LABELS[m] || t('{mode} (not supported by this Claude version)', { mode: m }));
    opt.value = m;
    cl.mode.appendChild(opt);
  }
  cl.mode.value = st.defaultMode;
  cl.warn.hidden = st.defaultMode !== 'bypassPermissions';
  cl.skip.checked = st.skipBypassPrompt;
  cl.bypassOk.checked = st.bypassAllowed;
  cl.allow.value = st.allow.join('\n');
  cl.deny.value = st.deny.join('\n');
  cl.ask.value = st.ask.join('\n');
  cl.update.checked = st.autoUpdates;
  cl.channel.value = st.channel;
  fillEnv($('#env-claude'), st.env);
  fillEnv($('#env-gcloud'), st.gcloudEnv);
}

function collectClaude() {
  const lines = (ta) => ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
  return {
    model: cl.model.value,
    defaultMode: cl.mode.value,
    allow: lines(cl.allow),
    deny: lines(cl.deny),
    ask: lines(cl.ask),
    skipBypassPrompt: cl.skip.checked,
    bypassAllowed: cl.bypassOk.checked,
    autoUpdates: cl.update.checked,
    channel: cl.channel.value,
    env: collectEnv($('#env-claude')),
    gcloudEnv: collectEnv($('#env-gcloud')),
  };
}

const activeProjectPath = () => {
  const s = sessions.get(activeKey);
  return s && !s.project.special ? s.project.path : '';
};

async function refreshMcp() {
  const box = $('#mcp-list');
  const items = await window.hub.mcpList(activeProjectPath());
  box.textContent = '';
  if (!items.length) { box.appendChild(el('div', 'mcpnone', t('No MCP servers.'))); return; }
  for (const it of items) {
    const row = el('div', 'mcprow');
    row.appendChild(el('span', 'mname', it.name));
    row.appendChild(el('span', 'mscope', it.scope === 'local' ? `local · ${baseName(it.where)}` : it.scope === 'project' ? '.mcp.json' : 'user'));
    const target = el('span', 'mtarget', `${it.type}: ${it.target}`);
    target.title = it.target;
    row.appendChild(target);
    const rm = el('button', null, t('Delete'));
    rm.type = 'button';
    rm.addEventListener('click', async () => {
      if (!confirm(t('Delete MCP server "{name}" ({scope})?', { name: it.name, scope: it.scope }))) return;
      const r = await window.hub.mcpRemove({ name: it.name, scope: it.scope, cwd: it.where });
      $('#set-error').textContent = r.ok ? '' : r.error;
      refreshMcp();
    });
    row.appendChild(rm);
    box.appendChild(row);
  }
}

$('#mcp-check').addEventListener('click', async () => {
  const out = $('#mcp-check-out');
  out.hidden = false;
  out.textContent = t('Checking connection...');
  out.textContent = await window.hub.mcpCheck(activeProjectPath());
});
for (const id of ['#mcp-name', '#mcp-target', '#mcp-env']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#mcp-add-go').click(); }
  });
}
$('#mcp-add-toggle').addEventListener('click', () => { $('#mcp-add').hidden = !$('#mcp-add').hidden; });
$('#mcp-add-cancel').addEventListener('click', () => { $('#mcp-add').hidden = true; });
$('#mcp-add-go').addEventListener('click', async () => {
  const scope = $('#mcp-scope').value;
  const cwd = activeProjectPath();
  if (scope !== 'user' && !cwd) { $('#set-error').textContent = t('For local/project scope, open a project first.'); return; }
  const r = await window.hub.mcpAdd({
    name: $('#mcp-name').value.trim(),
    transport: $('#mcp-transport').value,
    scope,
    target: $('#mcp-target').value,
    env: $('#mcp-env').value.split(/\s+/).filter(Boolean),
    cwd,
  });
  $('#set-error').textContent = r.ok ? '' : r.error;
  if (r.ok) {
    for (const id of ['#mcp-name', '#mcp-target', '#mcp-env']) $(id).value = '';
    $('#mcp-add').hidden = true;
    refreshMcp();
  }
});

async function showSettings() {
  setPathEl.value = (await window.hub.getSettings()).newProjectsPath;
  const font = termFontSettings();
  setFontEl.value = font.family;
  setSizeEl.value = font.size;
  $('#set-webgl').checked = localStorage.getItem('termWebgl') !== '0';
  $('#set-resume').checked = localStorage.getItem('resumeLast') !== '0';
  $('#set-theme').value = currentTheme();
  $('#set-lang').value = ['en', 'el'].includes(localStorage.getItem('hubLang')) ? localStorage.getItem('hubLang') : 'auto';
  updateSample();
  $('#set-error').textContent = '';
  const st = await window.hub.claudeGet();
  if (st.error) { claudeState = null; $('#set-error').textContent = st.error; } else { claudeState = st; fillClaude(st); }
  showSettingsTab('general');
  openDialog(dlgSet, setPathEl);
}

setFontEl.addEventListener('input', updateSample);
setSizeEl.addEventListener('input', updateSample);
$('#font-reset').addEventListener('click', () => {
  setFontEl.value = DEFAULT_FONT;
  setSizeEl.value = DEFAULT_SIZE;
  updateSample();
});

async function createProjectFlow(name) {
  const res = await window.hub.createProject(name);
  if (!res.ok) return { error: res.error };
  await loadProjects();
  const found = projects.find((p) => p.path.toLowerCase() === res.path.toLowerCase())
    || { name: res.name, path: res.path, pinned: false, last_session: null };
  await openProject(found);
  return {};
}

newNameEl.addEventListener('input', updateWhere);
dlgNew.addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await createProjectFlow(newNameEl.value);
  if (r.error) $('#new-error').textContent = r.error;
  else closeDialog();
});
$('#new-change').addEventListener('click', showSettings);
$('#new-project').addEventListener('click', showNewDialog);
$('#settings-btn').addEventListener('click', showSettings);
$('#set-browse').addEventListener('click', async () => {
  const picked = await window.hub.chooseFolder(setPathEl.value);
  if (picked) setPathEl.value = picked;
});
dlgSet.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pathCheck = await window.hub.setSettings(setPathEl.value, true);
  if (!pathCheck.ok) { showSettingsTab('general'); $('#set-error').textContent = pathCheck.error; return; }
  if (claudeState) {
    const check = await window.hub.claudeSet({ ...collectClaude(), dryRun: true });
    if (!check.ok) { showSettingsTab('claude'); $('#set-error').textContent = check.error; return; }
  }
  const res = await window.hub.setSettings(setPathEl.value);
  if (!res.ok) { showSettingsTab('general'); $('#set-error').textContent = res.error; return; }
  if (claudeState) {
    const saved = await window.hub.claudeSet(collectClaude());
    if (!saved.ok) { showSettingsTab('claude'); $('#set-error').textContent = saved.error; return; }
  }
  const size = Math.min(32, Math.max(8, Math.round(Number(setSizeEl.value)) || DEFAULT_SIZE));
  localStorage.setItem('termFont', setFontEl.value.trim() || DEFAULT_FONT);
  localStorage.setItem('termFontSize', String(size));
  localStorage.setItem('termWebgl', $('#set-webgl').checked ? '1' : '0');
  localStorage.setItem('resumeLast', $('#set-resume').checked ? '1' : '0');
  localStorage.setItem('hubTheme', $('#set-theme').value === 'light' ? 'light' : 'dark');
  const langSel = $('#set-lang').value;
  if (langSel === 'en' || langSel === 'el') localStorage.setItem('hubLang', langSel); else localStorage.removeItem('hubLang');
  applyTheme();
  applyTermFont();
  applyWebgl();
  closeDialog();
  loadProjects();
});

loadProjects().then(restoreTabs);
