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
  const collapsed = collapsedGroups();
  const groupBody = new Map();
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
    const nameRow = el('div', 'name');
    nameRow.appendChild(el('span', 'label', p.name));
    const agentNames = { claude: 'Claude Code', opencode: 'opencode' };
    if (p.ai) {
      const tag = el('span', 'tag ai', 'AI');
      tag.title = t('Used by {agents}', { agents: (p.agents || []).map((a) => agentNames[a] || a).join(', ') });
      nameRow.appendChild(tag);
    } else if (p.aiConfig) {
      const tag = el('span', 'tag ai cfg', 'AI cfg');
      tag.title = t('Has AI agent config files');
      nameRow.appendChild(tag);
    }
    const rootTag = el('span', p.nested ? 'tag nested' : 'tag root', p.nested ? t('nested') : t('root'));
    rootTag.title = p.nested ? t('Nested folder inside another project') : t('Project root');
    nameRow.appendChild(rootTag);
    txt.appendChild(nameRow);
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
    if (!p.group) { listEl.appendChild(li); return; }
    let body = groupBody.get(p.group);
    if (!body) {
      const open = q || !collapsed.has(p.group);
      const head = el('li', 'grp');
      head.appendChild(el('span', 'chev', open ? '▾' : '▸'));
      head.appendChild(el('span', 'label', p.groupName));
      const count = el('span', 'count', '0');
      head.appendChild(count);
      head.title = p.group;
      head.addEventListener('click', () => toggleGroup(p.group));
      listEl.appendChild(head);
      body = { count, open, n: 0 };
      groupBody.set(p.group, body);
    }
    body.count.textContent = String(++body.n);
    li.classList.add('in-group');
    if (!body.open) li.hidden = true;
    listEl.appendChild(li);
  });
  return shown;
}

function collapsedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '[]')); } catch { return new Set(); }
}

function toggleGroup(group) {
  const c = collapsedGroups();
  if (!c.delete(group)) c.add(group);
  localStorage.setItem('collapsedGroups', JSON.stringify([...c]));
  renderList();
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
    if (!dragged || dragged.pinned !== p.pinned || (dragged.group || null) !== (p.group || null)) return;
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
  } else if (action === 'rename') {
    const p = projects.find((x) => x.path === projectPath);
    if (p) showRenameDialog(p.path, p.name);
  } else if (action === 'hide') {
    const res = await window.hub.hideProject(projectPath);
    if (!res.ok) alert(res.error);
    await loadProjects();
  } else if (action === 'unhideAll') {
    const res = await window.hub.unhideAll();
    if (!res.ok) alert(res.error);
    await loadProjects();
  } else if (action === 'delete') {
    const res = await window.hub.deleteProject(projectPath, lang());
    if (res.cancelled) return;
    if (!res.ok) { alert(res.error); return; }
    const open = sessions.get(keyOf({ path: projectPath }));
    if (open) { open.alive = false; closeSession(open); } // its terminal was already stopped by the main process
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
      badge.title = t('New files from agent');
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

function currentAgent() { return localStorage.getItem('hubAgent') === 'opencode' ? 'opencode' : 'claude'; }

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
const webglEnabled = () => localStorage.getItem('termWebgl') === '1' && !webglBroken;

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

// ---------- command-line selection (Ctrl+A, Shift+Home / Shift+End) ----------
// The agent draws its input as a prompt row ("> text", optionally inside a box) between border rules.
// These helpers find that block from the terminal buffer so a selection covers only what was typed.
const PROMPT_MARK = /^[>❯›](\s|$)/;
const BORDER_ROW = /^[\s╭╮╰╯┌┐└┘├┤]*[─━]{3,}[\s╭╮╰╯┌┐└┘├┤]*$/;

function inputRow(term, y) {
  const line = term.buffer.active.getLine(y);
  if (!line) return null;
  const cells = [];
  for (let x = 0; x < term.cols; x++) {
    const c = line.getCell(x);
    cells.push(!c || c.getWidth() === 0 ? '' : (c.getChars() || ' '));
  }
  if (BORDER_ROW.test(cells.join(''))) return { y, cells, border: true, lb: -1, rb: -1 };
  const sp = (x) => cells[x] === ' ';
  const bar = (x) => cells[x] === '│' || cells[x] === '┃';
  let a = 0;
  let b = cells.length;
  while (b > a && sp(b - 1)) b--;
  let rb = -1;
  if (b > a && bar(b - 1)) { rb = b - 1; b--; while (b > a && sp(b - 1)) b--; }
  while (a < b && sp(a)) a++;
  let lb = -1;
  if (a < b && bar(a)) { lb = a; a++; while (a < b && sp(a)) a++; }
  const prompt = PROMPT_MARK.test(cells.slice(a, b).join('').slice(0, 2));
  if (prompt) { a++; while (a < b && sp(a)) a++; }
  return { y, cells, border: false, a, b, lb, rb, prompt, blank: b <= a && !prompt };
}

function findInputBlock(term) {
  const buf = term.buffer.active;
  const cy = buf.baseY + buf.cursorY;
  const cur = inputRow(term, cy);
  if (!cur || cur.border) return null;
  if (cur.blank && cur.lb < 0) return null;
  const rows = [cur];
  // Inside a bordered box (opencode): grow along rows that share the same left bar column.
  if (cur.lb >= 0) {
    for (let y = cy - 1; y >= Math.max(0, cy - 25); y--) {
      const r = inputRow(term, y);
      if (!r || r.border || r.blank || r.lb !== cur.lb) break;
      rows.unshift(r);
      if (r.prompt) break;
    }
    for (let y = cy + 1; y < buf.length; y++) {
      const r = inputRow(term, y);
      if (!r || r.border || r.blank || r.lb !== cur.lb || r.prompt) break;
      rows.push(r);
    }
  }
  return { rows, cy };
}

const rowText = (r, from, to) => r.cells.slice(from, to).join('').trimEnd();

function selectCommandLine(s) {
  s.kbSel = null;
  const blk = findInputBlock(s.term);
  if (!blk) return false;
  const first = blk.rows[0];
  const last = blk.rows[blk.rows.length - 1];
  const length = (last.y - first.y) * s.term.cols + (last.b - first.a);
  if (length <= 0) { s.term.clearSelection(); s.cleanSel = null; return true; }
  s.term.select(first.a, first.y, length);
  s.cleanSel = { key: s.term.getSelection(), text: blk.rows.map((r) => rowText(r, r.a, r.b)).join('\n') };
  if (first === last) s.cleanSel.del = { row: first, from: first.a, to: first.b, sig: rowText(first, first.a, first.b), ...caretOf(s.term) };
  return true;
}

function selectLineEdge(s, toStart) {
  s.kbSel = null;
  const blk = findInputBlock(s.term);
  if (!blk) return false;
  const onCursorRow = blk.rows.find((r) => r.y === blk.cy);
  const row = onCursorRow || blk.rows[blk.rows.length - 1];
  const caret = onCursorRow ? Math.min(Math.max(s.term.buffer.active.cursorX, row.a), row.b) : row.b;
  const from = toStart ? row.a : caret;
  const to = toStart ? caret : row.b;
  if (to <= from) return true;
  s.term.select(from, row.y, to - from);
  s.cleanSel = { key: s.term.getSelection(), text: rowText(row, from, to) };
  if (onCursorRow) s.cleanSel.del = { row, from, to, sig: rowText(row, row.a, row.b), ...caretOf(s.term) };
  return true;
}

// Clean text for an arbitrary cell range (used by the Ctrl+Shift arrow selection).
function cleanRangeText(term, startRow, startCol, length) {
  if (length <= 0) return '';
  const cols = term.cols;
  const endAbs = startRow * cols + startCol + length;
  const endRow = Math.floor((endAbs - 1) / cols);
  const endCol = ((endAbs - 1) % cols) + 1;
  const parts = [];
  for (let y = startRow; y <= endRow; y++) {
    const r = inputRow(term, y);
    if (!r || r.border) continue;
    const from = y === startRow ? Math.max(startCol, r.a) : r.a;
    const to = y === endRow ? Math.min(endCol, r.b) : r.b;
    if (to > from) parts.push(rowText(r, from, to));
  }
  return parts.join('\n');
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function moveCaretWord(row, col, dir) {
  const { a, b, cells } = row;
  const word = (x) => WORD_CHAR.test(cells[x] || '');
  let i = Math.min(Math.max(col, a), b);
  if (dir < 0) {
    while (i > a && !word(i - 1)) i--;
    while (i > a && word(i - 1)) i--;
    return i;
  }
  while (i < b && !word(i)) i++;
  while (i < b && word(i)) i++;
  return i;
}

function applyKbSel(s, blk) {
  const cols = s.term.cols;
  const { anchor, caret } = s.kbSel;
  const aAbs = anchor.y * cols + anchor.col;
  const cAbs = caret.y * cols + caret.col;
  const startAbs = Math.min(aAbs, cAbs);
  const len = Math.abs(cAbs - aAbs);
  if (len <= 0) { s.term.clearSelection(); s.cleanSel = null; return; }
  const startRow = Math.floor(startAbs / cols);
  const startCol = startAbs - startRow * cols;
  s.term.select(startCol, startRow, len);
  s.cleanSel = { key: s.term.getSelection(), text: cleanRangeText(s.term, startRow, startCol, len) };
  if (anchor.y === caret.y) {
    const row = blk.rows.find((r) => r.y === anchor.y);
    const from = Math.min(anchor.col, caret.col);
    const to = Math.max(anchor.col, caret.col);
    if (row && to > from) s.cleanSel.del = { row, from, to, sig: rowText(row, row.a, row.b), ...caretOf(s.term) };
  }
}

// Ctrl+Shift+Home/End/Left/Right: select within the command line, extending from an anchor.
function handleKbSel(s, code) {
  const blk = findInputBlock(s.term);
  if (!blk) return false;
  const cur = blk.rows.find((r) => r.y === blk.cy) || blk.rows[blk.rows.length - 1];
  const cursorCol = cur.y === blk.cy ? Math.min(Math.max(s.term.buffer.active.cursorX, cur.a), cur.b) : cur.b;
  const sig = blk.rows.map((r) => `${r.y}:${r.a}:${r.b}:${rowText(r, r.a, r.b)}`).join('|');
  if (!s.kbSel || s.kbSel.sig !== sig) {
    s.kbSel = { anchor: { y: cur.y, col: cursorCol }, caret: { y: cur.y, col: cursorCol }, sig };
  }
  const sel = s.kbSel;
  if (code === 'Home') {
    sel.caret = { y: blk.rows[0].y, col: blk.rows[0].a };
  } else if (code === 'End') {
    const last = blk.rows[blk.rows.length - 1];
    sel.caret = { y: last.y, col: last.b };
  } else {
    const idx = blk.rows.findIndex((r) => r.y === sel.caret.y);
    const row = idx >= 0 ? blk.rows[idx] : cur;
    const atStart = sel.caret.col <= row.a;
    const atEnd = sel.caret.col >= row.b;
    if (code === 'ArrowLeft') {
      if (atStart && idx > 0) sel.caret = { y: blk.rows[idx - 1].y, col: blk.rows[idx - 1].b };
      else sel.caret = { y: row.y, col: moveCaretWord(row, sel.caret.col, -1) };
    } else {
      if (atEnd && idx >= 0 && idx < blk.rows.length - 1) sel.caret = { y: blk.rows[idx + 1].y, col: blk.rows[idx + 1].a };
      else sel.caret = { y: row.y, col: moveCaretWord(row, sel.caret.col, 1) };
    }
  }
  applyKbSel(s, blk);
  return true;
}

const caretOf = (term) => ({ cx: term.buffer.active.cursorX, cy: term.buffer.active.baseY + term.buffer.active.cursorY });
const charCount = (cells, from, to) => cells.slice(from, to).filter((c) => c !== '').length;

// Deletes the selected command-line text inside the agent: move the caret to the selection end (Right arrows)
// and Backspace over it. Only done when the selection is on one row and the row/caret are unchanged since it was made.
function deleteCleanSelection(s) {
  const sel = s.cleanSel;
  if (!s.alive || !sel || !sel.del || !s.term.hasSelection() || s.term.getSelection() !== sel.key) return false;
  const d = sel.del;
  const cur = caretOf(s.term);
  const r = inputRow(s.term, d.row.y);
  const unchanged = r && !r.border && r.a === d.row.a && r.b === d.row.b && rowText(r, r.a, r.b) === d.sig;
  if (!unchanged || cur.cx !== d.cx || cur.cy !== d.cy || cur.cy !== d.row.y) { s.cleanSel = null; return false; }
  const caret = Math.min(Math.max(cur.cx, d.from), d.to);
  const right = charCount(r.cells, caret, d.to);
  const back = charCount(r.cells, d.from, d.to);
  if (!back) return false;
  window.hub.write(s.id, '\x1b[C'.repeat(right) + '\x7f'.repeat(back));
  s.term.clearSelection();
  s.cleanSel = null;
  s.typed = true;
  return true;
}

// Selected text, without the box borders / prompt marker when the selection came from the helpers above.
function selectionText(s) {
  const sel = s.term.getSelection();
  return s.cleanSel && s.cleanSel.key === sel ? s.cleanSel.text : sel;
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
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_ev, uri) => window.hub.openExternal(uri)));
  term.open(container);

  const s = { id, key: keyOf(project), project, el: container, term, fit, alive: false, started: false, typed: false, pendingPastes: [] };
  sessions.set(s.key, s);
  byId.set(id, s);

  term.onData((d) => {
    if (!s.alive) {
      if (d === '\r' && s.started) startPty(s);
      return;
    }
    s.typed = true;
    s.kbSel = null;
    if (d === '\r') s.pendingPastes = [];
    window.hub.write(id, d);
  });
  term.onResize(({ cols, rows }) => { if (s.alive) window.hub.resize(id, cols, rows); });

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === 'keydown' && (ev.key === 'Backspace' || ev.key === 'Delete')) {
      const removed = deleteCleanSelection(s);
      s.kbSel = null;
      s.reconcileArmedUntil = Date.now() + 5000;
      for (const ms of [30, 120, 350, 700, 1200]) setTimeout(() => reconcileTerminalPastes(s), ms);
      if (removed) ev.preventDefault();
      return !removed;
    }
    // Typing over a selected command-line range replaces it, as in a chat box.
    if (ev.type === 'keydown' && ev.key.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      deleteCleanSelection(s);
      s.kbSel = null;
    }
    if (ev.type === 'keydown' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && (ev.code === 'Home' || ev.code === 'End')) {
      if (selectLineEdge(s, ev.code === 'Home')) { ev.preventDefault(); return false; }
      return true;
    }
    // Ctrl+Shift+Home/End/Left/Right: select the command line word-by-word / to its edges.
    if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && !ev.altKey
      && (ev.code === 'Home' || ev.code === 'End' || ev.code === 'ArrowLeft' || ev.code === 'ArrowRight')) {
      if (handleKbSel(s, ev.code)) { ev.preventDefault(); return false; }
    }
    if (ev.type !== 'keydown' || !ev.ctrlKey) return true;
    if (ev.code === 'Equal' || ev.code === 'NumpadAdd') { ev.preventDefault(); zoomTerm(1); return false; }
    if (ev.code === 'Minus' || ev.code === 'NumpadSubtract') { ev.preventDefault(); zoomTerm(-1); return false; }
    if (ev.code === 'Digit0' || ev.code === 'Numpad0') { ev.preventDefault(); zoomTerm(0); return false; }
    // ev.code is the physical key, so this works with any layout (e.g. Greek, where Ctrl+V gives a non-Latin key).
    if (ev.code === 'KeyA' && !ev.altKey && !ev.shiftKey) {
      ev.preventDefault();
      // Only ever select the command line: never fall back to the whole screen.
      if (!selectCommandLine(s)) {
        const b = term.buffer.active;
        const y = b.baseY + b.cursorY;
        term.select(0, y, term.cols);
        s.cleanSel = null;
      }
      return false;
    }
    const k = ev.code === 'KeyV' ? 'v' : ev.code === 'KeyC' ? 'c' : ev.key.toLowerCase();
    if (k === 'v' && !ev.altKey) {
      // Paste explicitly via the main-process clipboard: the native paste event
      // is unreliable in the Electron terminal. preventDefault stops a double paste.
      ev.preventDefault();
      deleteCleanSelection(s);
      readClipboardData().then((r) => {
        if (r.type === 'image') {
          const item = { path: r.path, isImage: true };
          const before = captureInputLine(s);
          addItems([item], false, s.key);
          insertPaths([r.path], s);
          trackTerminalPaste(s, item, before);
        } else if (r.type === 'text') term.paste(r.text);
      });
      return false;
    }
    if (k === 'c' && term.hasSelection()) {
      window.hub.writeClipboard(selectionText(s));
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
    const before = captureInputLine(s);
    filesFromTransfer(dt).then((items) => {
      addItems(items, false, s.key);
      insertPaths(items.map((i) => i.path), s);
      for (const it of items) trackTerminalPaste(s, it, before);
    });
  }, true);

  container.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    zoomTerm(e.deltaY < 0 ? 1 : -1);
  }, { capture: true, passive: false });

  container.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (term.hasSelection()) { window.hub.writeClipboard(selectionText(s)); term.clearSelection(); return; }
    const r = await readClipboardData();
    if (r.type === 'image') {
      const item = { path: r.path, isImage: true };
      const before = captureInputLine(s);
      addItems([item], false, s.key);
      insertPaths([r.path], s);
      trackTerminalPaste(s, item, before);
    } else if (r.type === 'text') term.paste(r.text);
  });

  return s;
}

async function startPty(s) {
  s.fit.fit();
  const agent = s.project.special === 'auth' ? 'claude' : currentAgent();
  s.agent = agent;
  const resumeLast = localStorage.getItem('resumeLast') !== '0';
  const resume = s.typed ? true : resumeLast && (agent === 'opencode' || Boolean(s.project.last_session));
  const res = await window.hub.spawn({ id: s.id, kind: s.project.special || 'claude', cwd: s.project.path, resume, cols: s.term.cols, rows: s.term.rows, lang: lang(), agent });
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

// Restart every open project terminal so a change of agent takes effect immediately.
async function restartSessionsForAgent() {
  for (const s of [...sessions.values()]) {
    if (s.project.special || !s.alive) continue;
    window.hub.kill(s.id);
    s.alive = false;
    s.started = false;
    s.pendingPastes = [];
    s.kbSel = null;
    s.cleanSel = null;
    try { s.term.reset(); } catch { /* terminal already disposed */ }
    await startPty(s);
  }
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
  try {
    for (const p of saved.tabs) {
      try { await openProject(find(p)); } catch { /* skip a tab that fails to open */ }
    }
  } finally { restoring = false; }
  if (saved.active) activate(keyOf(find(saved.active)));
  persistTabs();
}

window.hub.onData((id, data) => {
  const s = byId.get(id);
  if (!s) return;
  s.term.write(data, () => {
    if (s.pendingPastes && s.pendingPastes.length && s.reconcileArmedUntil > Date.now()) {
      clearTimeout(s.reconcileTimer);
      s.reconcileTimer = setTimeout(() => reconcileTerminalPastes(s), 60);
    }
  });
});
window.hub.onExit((id, code) => {
  const s = byId.get(id);
  if (!s) return;
  s.alive = false;
  const what = s.project.special === 'auth' ? t('Login finished') : t('{agent} exited', { agent: s.agent === 'opencode' ? 'opencode' : 'claude' });
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

function captureInputLine(s) {
  const b = s.term.buffer.active;
  const line = b.getLine(b.baseY + b.cursorY);
  return line ? line.translateToString(true) : '';
}

// The characters that appeared on the input line because of the paste. Agents like opencode
// render a pasted file as e.g. "[image 1]", so we can't assume the raw path stays visible.
function insertedBetween(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) { endB--; endA--; }
  return after.slice(start, endA);
}

function trackTerminalPaste(s, item, before) {
  if (!s.pendingPastes) return;
  const entry = { item, needle: '', createdAt: Date.now(), expires: Date.now() + 60000 };
  s.pendingPastes.push(entry);
  const capture = () => {
    if (!s.pendingPastes.includes(entry)) return;
    const token = insertedBetween(before, captureInputLine(s)).trim();
    if (token) entry.needle = token;
  };
  for (const ms of [250, 600, 1200]) setTimeout(capture, ms);
}

// When a pasted attachment (e.g. "[image 1]") is deleted from the input with Backspace/Delete,
// drop the matching chip from the right panel instead of leaving it behind.
function reconcileTerminalPastes(s) {
  const pending = s.pendingPastes;
  if (!pending || !pending.length) return;
  const b = s.term.buffer.active;
  const y = b.baseY + b.cursorY;
  let text = '';
  for (let i = Math.max(0, y - 2); i <= Math.min(b.length - 1, y + 1); i++) {
    const line = b.getLine(i);
    if (line) text += line.translateToString(true);
  }
  const now = Date.now();
  const gone = [];
  s.pendingPastes = pending.filter((e) => {
    if (now > e.expires) return false;
    if (!e.needle || now - e.createdAt < 1500) return true;
    if (text.includes(e.needle)) return true;
    gone.push(e.item);
    return false;
  });
  if (!gone.length) return;
  inboxByKey.set(s.key, (inboxByKey.get(s.key) || []).filter((i) => !gone.includes(i)));
  if (s.key === activeKey) renderChips();
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

function syncRightRail() {
  const both = $('#drop').classList.contains('collapsed') && $('#outputs').classList.contains('collapsed');
  $('#rightbar').classList.toggle('rail', both);
  $('#splitter-r').hidden = both;
}

function applyPaneCollapse() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('collapsedPanes') || '[]'); } catch { /* use defaults */ }
  for (const id of ['drop', 'outputs']) $(`#${id}`).classList.toggle('collapsed', saved.includes(id));
  syncRightRail();
}
for (const btn of document.querySelectorAll('.drop-head .collapse')) {
  btn.addEventListener('click', () => {
    $(`#${btn.dataset.target}`).classList.toggle('collapsed');
    localStorage.setItem('collapsedPanes', JSON.stringify(['drop', 'outputs'].filter((id) => $(`#${id}`).classList.contains('collapsed'))));
    syncRightRail();
  });
}
applyPaneCollapse();

$('#auth').addEventListener('click', openAuth);
function applyAuthVisibility() { $('#auth').hidden = currentAgent() !== 'claude'; }
applyAuthVisibility();

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
const dlgRename = $('#dlg-rename');
const dlgSet = $('#dlg-settings');
const newNameEl = $('#new-name');
const newWhereEl = $('#new-where');
const renameNameEl = $('#rename-name');
const setPathEl = $('#set-path');
let newBase = '';
let renamePath = '';

function openDialog(dlg, focusEl) {
  dlgNew.hidden = dlg !== dlgNew;
  dlgRename.hidden = dlg !== dlgRename;
  dlgSet.hidden = dlg !== dlgSet;
  modal.hidden = false;
  focusEl.focus();
  focusEl.select();
}

function closeDialog() {
  modal.hidden = true;
  dlgNew.hidden = true;
  dlgRename.hidden = true;
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

const newDestEl = $('#new-dest');
let newDests = [];

function fillDest(selected) {
  newDestEl.textContent = '';
  for (const d of newDests) {
    const o = el('option', null, d.label);
    o.value = d.path;
    o.title = d.path;
    newDestEl.appendChild(o);
  }
  newDestEl.value = selected;
  if (newDestEl.value !== selected) newDestEl.selectedIndex = 0;
  newBase = newDestEl.value;
}

newDestEl.addEventListener('change', () => { newBase = newDestEl.value; updateWhere(); });

async function showNewDialog() {
  newDests = await window.hub.projectDestinations();
  fillDest(localStorage.getItem('newDest') || '');
  newNameEl.value = '';
  $('#new-error').textContent = '';
  updateWhere();
  openDialog(dlgNew, newNameEl);
}

function showRenameDialog(projectPath, currentName) {
  renamePath = projectPath;
  renameNameEl.value = currentName;
  $('#rename-error').textContent = '';
  openDialog(dlgRename, renameNameEl);
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

const OC_MODE_LABELS = {
  default: t('opencode default (leaves permission unset)'),
  allow: t('allow everything'),
  ask: t('ask before edits and commands'),
  deny: t('deny edits and commands'),
  custom: t('custom (keeps the permission rules already in the file)'),
};
const oc = {
  path: $('#oc-path'), model: $('#oc-model'), mode: $('#oc-mode'),
  note: $('#oc-model-note'), list: $('#oc-model-list'),
  key: $('#oc-deepseek-key'), keyNote: $('#oc-deepseek-note'),
  savedModel: '', currentModel: '', dirty: false,
};
let opencodeState = null;

oc.model.addEventListener('input', () => {
  oc.dirty = true;
  oc.note.textContent = '';
});
$('#oc-deepseek-clear').addEventListener('click', () => {
  oc.key.value = '';
  oc.key.focus();
});
oc.key.addEventListener('input', () => {
  oc.keyNote.textContent = oc.key.value.trim()
    ? t('DeepSeek will be connected when you save.')
    : t('Leave empty and save to disconnect DeepSeek.');
});

function fillOpencode(st) {
  oc.path.textContent = st.path;
  oc.savedModel = st.model || '';
  oc.currentModel = st.currentModel || '';
  oc.dirty = false;
  oc.model.value = oc.savedModel || oc.currentModel;
  oc.key.value = st.deepseekKey || '';
  oc.keyNote.textContent = st.deepseekKey
    ? t('DeepSeek is connected (stored in opencode auth.json).')
    : t('No DeepSeek key set. Paste your key to connect.');
  for (const o of oc.list.querySelectorAll('option[data-current]')) o.remove();
  if (oc.currentModel && ![...oc.list.options].some((o) => o.value === oc.currentModel)) {
    const cur = el('option');
    cur.value = oc.currentModel;
    cur.dataset.current = '1';
    oc.list.prepend(cur);
  }
  oc.note.textContent = !oc.savedModel && oc.currentModel
    ? t('Current opencode model: {model} (saved only if you change it).', { model: oc.currentModel })
    : '';
  const modes = ['default', 'allow', 'ask', 'deny'];
  if (st.permMode === 'custom') modes.push('custom');
  oc.mode.textContent = '';
  for (const m of modes) {
    const opt = el('option', null, OC_MODE_LABELS[m]);
    opt.value = m;
    oc.mode.appendChild(opt);
  }
  oc.mode.value = st.permMode;
}

function collectOpencode() {
  return { model: oc.dirty ? oc.model.value : oc.savedModel, permMode: oc.mode.value, deepseekKey: oc.key.value };
}

function showSettingsTab(name) {
  for (const b of dlgSet.querySelectorAll('.stab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const pane of dlgSet.querySelectorAll('.spane')) pane.hidden = pane.dataset.pane !== name;
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

const setRootsEl = $('#set-roots');

function addRootRow(value = '') {
  const row = el('div', 'rootrow');
  const inp = el('input');
  inp.type = 'text';
  inp.value = value;
  inp.spellcheck = false;
  inp.placeholder = 'e.g. C:/Users/me/Code';
  const browse = el('button', null, t('Browse...'));
  browse.type = 'button';
  browse.addEventListener('click', async () => {
    const picked = await window.hub.chooseFolder(inp.value);
    if (picked) inp.value = picked;
  });
  const rm = el('button', null, '×');
  rm.type = 'button';
  rm.addEventListener('click', () => row.remove());
  row.append(inp, browse, rm);
  setRootsEl.appendChild(row);
}

function fillRoots(roots) {
  setRootsEl.textContent = '';
  for (const r of roots || []) addRootRow(r);
}

function collectRoots() {
  return [...setRootsEl.querySelectorAll('.rootrow input')].map((i) => i.value.trim()).filter(Boolean);
}

$('#set-root-add').addEventListener('click', () => addRootRow());

async function showSettings() {
  const base = await window.hub.getSettings();
  setPathEl.value = base.newProjectsPath;
  fillRoots(base.scanRoots);
  const font = termFontSettings();
  setFontEl.value = font.family;
  setSizeEl.value = font.size;
  $('#set-webgl').checked = localStorage.getItem('termWebgl') === '1';
  $('#set-resume').checked = localStorage.getItem('resumeLast') !== '0';
  $('#set-theme').value = currentTheme();
  $('#set-agent').value = currentAgent();
  $('#set-lang').value = ['en', 'el'].includes(localStorage.getItem('hubLang')) ? localStorage.getItem('hubLang') : 'auto';
  updateSample();
  $('#set-error').textContent = '';
  const st = await window.hub.claudeGet();
  if (st.error) { claudeState = null; $('#set-error').textContent = st.error; } else { claudeState = st; fillClaude(st); }
  const ocs = await window.hub.opencodeGet();
  if (ocs.error) { opencodeState = null; if (!$('#set-error').textContent) $('#set-error').textContent = ocs.error; } else { opencodeState = ocs; fillOpencode(ocs); }
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

async function createProjectFlow(name, base) {
  const res = await window.hub.createProject(name, base);
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
  const r = await createProjectFlow(newNameEl.value, newBase);
  if (r.error) $('#new-error').textContent = r.error;
  else { localStorage.setItem('newDest', newBase); closeDialog(); }
});
dlgRename.addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await window.hub.renameProject(renamePath, renameNameEl.value, lang());
  if (!res.ok) { $('#rename-error').textContent = res.error; return; }
  closeDialog();
  const old = sessions.get(keyOf({ path: renamePath }));
  if (old) closeSession(old);
  await loadProjects();
});
$('#new-change').addEventListener('click', async () => {
  const picked = await window.hub.chooseFolder(newBase);
  if (!picked) return;
  if (!newDests.some((d) => d.path.toLowerCase() === picked.toLowerCase())) newDests.push({ path: picked, label: picked });
  fillDest(newDests.find((d) => d.path.toLowerCase() === picked.toLowerCase()).path);
  updateWhere();
});
$('#new-project').addEventListener('click', showNewDialog);
$('#settings-btn').addEventListener('click', showSettings);
$('#set-browse').addEventListener('click', async () => {
  const picked = await window.hub.chooseFolder(setPathEl.value);
  if (picked) setPathEl.value = picked;
});
dlgSet.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prevAgent = currentAgent();
  const roots = collectRoots();
  const pathCheck = await window.hub.setSettings(setPathEl.value, roots, true);
  if (!pathCheck.ok) { showSettingsTab('general'); $('#set-error').textContent = pathCheck.error; return; }
  if (claudeState) {
    const check = await window.hub.claudeSet({ ...collectClaude(), dryRun: true });
    if (!check.ok) { showSettingsTab('claude'); $('#set-error').textContent = check.error; return; }
  }
  if (opencodeState) {
    const check = await window.hub.opencodeSet({ ...collectOpencode(), dryRun: true });
    if (!check.ok) { showSettingsTab('opencode'); $('#set-error').textContent = check.error; return; }
  }
  const res = await window.hub.setSettings(setPathEl.value, roots);
  if (!res.ok) { showSettingsTab('general'); $('#set-error').textContent = res.error; return; }
  if (claudeState) {
    const saved = await window.hub.claudeSet(collectClaude());
    if (!saved.ok) { showSettingsTab('claude'); $('#set-error').textContent = saved.error; return; }
  }
  if (opencodeState) {
    const saved = await window.hub.opencodeSet(collectOpencode());
    if (!saved.ok) { showSettingsTab('opencode'); $('#set-error').textContent = saved.error; return; }
  }
  const size = Math.min(32, Math.max(8, Math.round(Number(setSizeEl.value)) || DEFAULT_SIZE));
  localStorage.setItem('termFont', setFontEl.value.trim() || DEFAULT_FONT);
  localStorage.setItem('termFontSize', String(size));
  localStorage.setItem('termWebgl', $('#set-webgl').checked ? '1' : '0');
  localStorage.setItem('resumeLast', $('#set-resume').checked ? '1' : '0');
  localStorage.setItem('hubTheme', $('#set-theme').value === 'light' ? 'light' : 'dark');
  const nextAgent = $('#set-agent').value === 'opencode' ? 'opencode' : 'claude';
  localStorage.setItem('hubAgent', nextAgent);
  const langSel = $('#set-lang').value;
  if (langSel === 'en' || langSel === 'el') localStorage.setItem('hubLang', langSel); else localStorage.removeItem('hubLang');
  applyTheme();
  applyAuthVisibility();
  applyTermFont();
  applyWebgl();
  closeDialog();
  if (prevAgent !== nextAgent) restartSessionsForAgent().catch(() => {});
  loadProjects();
});

loadProjects().then(restoreTabs);
