const { app, BrowserWindow, ipcMain, clipboard, shell, Menu, dialog, nativeImage, screen } = require('electron');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('@lydell/node-pty');

// Force classic (space-taking) scrollbars instead of Chromium/Windows overlay scrollbars,
// otherwise the terminal scrollbar is hidden until hover and ignores our CSS.
if (app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
  app.commandLine.appendSwitch('disable-features', 'OverlayScrollbar,OverlayScrollbars,FluentOverlayScrollbars,FluentOverlayScrollbar');
}

const HOME = os.homedir();
const INBOX = path.join(HOME, '.claude', 'hub-inbox');
const CONFIG_FILE = process.env.HUB_CONFIG || path.join(HOME, '.claude', 'project-launcher', 'config.json');
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function readConfigStrict() {
  if (!fs.existsSync(CONFIG_FILE)) return { ok: true, cfg: {} };
  try {
    return { ok: true, cfg: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch (e) {
    return { ok: false, error: `config.json cannot be read right now (${e.message}). Try again.` };
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.hub-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

function defaultNewPath() {
  const candidates = [
    path.join(HOME, 'OneDrive', 'Desktop', 'Projects'),
    path.join(HOME, 'Desktop', 'Projects'),
    path.join(HOME, 'Projects'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || candidates[2];
}

function newProjectsBase() {
  return readConfig().new_projects_path || defaultNewPath();
}

let win;
const ptys = new Map();
const ptyCwd = new Map();
const killedPtys = new Set();

const JUNK_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.claude', '__pycache__', 'venv', '.venv', '.cache', '.next', '.idea', '.vscode', '$recycle.bin']);
const JUNK_FILE = /(^~\$)|(\.(tmp|swp|swo|crdownload|part|lnk)$)|(~$)|^(thumbs\.db|desktop\.ini)$/i;
const watchers = new Map();
const produced = new Map();
let dragIcon;

function isShallowDir(dir) {
  const norm = path.normalize(dir).toLowerCase().replace(/[\\/]+$/, '');
  return norm === path.normalize(HOME).toLowerCase() || path.parse(path.normalize(dir)).root.toLowerCase().replace(/[\\/]+$/, '') === norm;
}

function stopWatch(id) {
  const w = watchers.get(id);
  if (!w) return;
  watchers.delete(id);
  for (const t of w.pending.values()) clearTimeout(t);
  try { w.watcher.close(); } catch { /* already closed */ }
}

function reportFile(id, cwd, full, startedAt) {
  let st;
  try { st = fs.statSync(full); } catch { return; }
  if (!st.isFile() || st.size === 0) return;
  if (st.mtimeMs < startedAt || Date.now() - st.mtimeMs > 20000) return;
  produced.set(full.toLowerCase(), full);
  if (win) win.webContents.send('files:new', { id, project: cwd, path: full, name: path.basename(full), size: st.size, mtime: st.mtimeMs });
}

function startWatch(id, cwd) {
  stopWatch(id);
  const startedAt = Date.now() - 2000;
  const pending = new Map();
  let watcher;
  try {
    watcher = fs.watch(cwd, { recursive: !isShallowDir(cwd) }, (_evt, filename) => {
      if (!filename) return;
      const parts = String(filename).split(/[\\/]/);
      const base = parts[parts.length - 1];
      if (!base || base.startsWith('.') || JUNK_FILE.test(base)) return;
      if (parts.slice(0, -1).some((seg) => seg.startsWith('.') || JUNK_DIRS.has(seg.toLowerCase()))) return;
      const full = path.join(cwd, ...parts);
      clearTimeout(pending.get(full));
      pending.set(full, setTimeout(() => { pending.delete(full); reportFile(id, cwd, full, startedAt); }, 1200));
    });
  } catch { return; }
  watcher.on('error', () => stopWatch(id));
  watchers.set(id, { watcher, pending });
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isKnownFile = (p) => produced.has(String(p).toLowerCase());

function findClaude() {
  if (process.env.HUB_FORCE_CMD) return null;
  const candidates = [
    path.join(HOME, '.local', 'bin', 'claude.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
  ];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'claude.exe'));
  }
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

function findOpencode() {
  if (process.env.HUB_FORCE_CMD) return null;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'opencode', 'opencode.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'opencode.exe'),
  ];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'opencode.exe'));
  }
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

const WINDOW_STATE_FILE = path.join(path.dirname(CONFIG_FILE), 'window-state.json');
const trackWindowState = () => !process.argv.includes('--selftest');

function loadWindowState() {
  if (!trackWindowState()) return null;
  try {
    const s = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    const b = s.bounds;
    if (!b || ![b.width, b.height].every((n) => Number.isFinite(n) && n > 0)) return null;
    const bounds = { width: b.width, height: b.height };
    // Only restore the position if the window would still be reachable on a connected display.
    const reachable = Number.isFinite(b.x) && Number.isFinite(b.y) && screen.getAllDisplays().some(({ workArea: w }) =>
      Math.min(b.x + b.width, w.x + w.width) - Math.max(b.x, w.x) >= 100 && Math.min(b.y + b.height, w.y + w.height) - Math.max(b.y, w.y) >= 100);
    if (reachable) { bounds.x = b.x; bounds.y = b.y; }
    return { bounds, maximized: Boolean(s.maximized) };
  } catch { return null; }
}

function saveWindowState() {
  if (!trackWindowState() || !win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    fs.mkdirSync(path.dirname(WINDOW_STATE_FILE), { recursive: true });
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch { /* best effort */ }
}

function createWindow() {
  const savedState = loadWindowState();
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    ...(savedState ? savedState.bounds : {}),
    minWidth: 900,
    minHeight: 500,
    backgroundColor: '#14161a',
    title: 'Agent Hub',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try { win.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'))); } catch { /* icon optional */ }
  win.loadFile('index.html');
  // The window only ever shows index.html: block navigation (e.g. a file dropped outside the drop zone)
  // and new windows, so the UI can never be replaced by other content.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (savedState && savedState.maximized) win.maximize();
  let saveTimer;
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 500); };
  for (const evt of ['resize', 'move', 'maximize', 'unmaximize']) win.on(evt, scheduleSave);
  win.on('close', () => { clearTimeout(saveTimer); saveWindowState(); });
  win.on('closed', () => { win = null; });
  if (process.argv.includes('--selftest')) win.webContents.once('did-finish-load', runSelfTest);
}

async function runSelfTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(__dirname, name), (await win.webContents.capturePage()).toPNG());
  const click = (name) => js(`[...document.querySelectorAll('#list li')].find(l => l.querySelector('.name') && l.querySelector('.name').textContent.startsWith(${JSON.stringify(name)})).click()`);
  const dump = (key) => js(`(() => { const s = [...sessions.values()].find(x => x.project.name.startsWith(${JSON.stringify(key)})); const b = s.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const t = b.getLine(i).translateToString(true).trim(); if (t) out.push(t); } return out.slice(-12).join('\\n'); })()`);
  const report = {};
  if (process.env.HUB_SELFTEST_RESTORE) {
    await wait(9000);
    report.restored = await js(`JSON.stringify({ tabs: [...sessions.values()].map((s) => [s.project.name, s.alive]), active: activeKey, activeTitle: document.querySelector('#drop-proj').textContent })`);
    fs.writeFileSync(path.join(__dirname, 'selftest-restore.json'), JSON.stringify(report, null, 2));
    app.quit();
    return;
  }
  if (process.env.HUB_SELFTEST_BENCH) {
    await wait(1500);
    report.open = await js(`openProject({ name: 'bench', path: ${JSON.stringify(os.tmpdir())}, pinned: false, last_session: null }).then(() => 'ok', (e) => String(e && e.stack || e))`);
    report.env = await js(`JSON.stringify({ webglType: typeof WebglAddon, sessions: sessions.size, keys: [...sessions.keys()] })`);
    await wait(7000);
    const run = (webgl) => js(`(async () => {
      localStorage.setItem('termWebgl', ${webgl ? "'1'" : "'0'"});
      applyWebgl();
      const s = [...sessions.values()].find((x) => x.project.name === 'bench');
      s.term.reset();
      const ESC = String.fromCharCode(27);
      const CRLF = String.fromCharCode(13, 10);
      let data = '';
      for (let i = 0; i < 20000; i++) data += ESC + '[3' + (i % 7 + 1) + 'm' + 'line ' + i + ' lorem ipsum dolor sit amet lorem ipsum dolor sit amet' + ESC + '[0m' + CRLF;
      const t0 = performance.now();
      await new Promise((r) => s.term.write(data, r));
      const t1 = performance.now();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const t2 = performance.now();
      return JSON.stringify({ webglActive: !!s.webgl, broken: webglBroken, parseMs: Math.round(t1 - t0), totalMs: Math.round(t2 - t0), canvases: document.querySelectorAll('.term.active canvas').length });
    })()`);
    report.runs = [];
    try {
      for (const webgl of [false, true, false, true, false, true]) report.runs.push({ webgl, result: JSON.parse(await run(webgl)) });
    } catch (e) { report.error = String(e); }
    await js(`localStorage.removeItem('termWebgl')`);
    fs.writeFileSync(path.join(__dirname, 'selftest-bench.json'), JSON.stringify(report, null, 2));
    app.quit();
    return;
  }
  if (process.env.HUB_SELFTEST_SETTINGS && process.env.HUB_FORCE_CMD) {
    await wait(1500);
    report.guard_amp = await js(`window.hub.mcpAdd({ name: 'cmd-test', transport: 'http', scope: 'user', target: 'https://x/mcp?a=1&b=2', cwd: '' })`);
    report.guard_ok = await js(`window.hub.mcpAdd({ name: 'cmd-test', transport: 'http', scope: 'user', target: 'https://example.com/mcp', cwd: '' })`);
    report.guard_remove = await js(`window.hub.mcpRemove({ name: 'cmd-test', scope: 'user', cwd: '' })`);
    fs.writeFileSync(path.join(__dirname, 'selftest-settings.json'), JSON.stringify(report, null, 2));
    app.quit();
    return;
  }
  if (process.env.HUB_SELFTEST_SETTINGS) {
    const sp = SETTINGS_FILE;
    await wait(1500);
    report.get = await js('window.hub.claudeGet()');
    await js('showSettings()');
    await wait(800);
    report.ui = await js(`JSON.stringify({ model: cl.model.value, mode: cl.mode.value, modes: [...cl.mode.options].map((o) => o.value), allowLines: cl.allow.value.split(String.fromCharCode(10)).length, claudeEnvRows: document.querySelectorAll('#env-claude .envrow').length, bypassOk: cl.bypassOk.checked, warnVisible: !cl.warn.hidden })`);
    await js(`(() => {
      cl.mode.value = 'plan'; cl.mode.dispatchEvent(new Event('change'));
      cl.model.value = 'claude-test-model';
      cl.allow.value = cl.allow.value + String.fromCharCode(10) + 'Bash(npm test)';
      cl.deny.value = 'Bash(rm -rf *)';
      cl.update.checked = false; cl.channel.value = 'stable'; cl.bypassOk.checked = true;
      addEnvRow($('#env-claude'), 'MY_VAR', 'abc');
      addEnvRow($('#env-claude'), 'MY_SECRET_KEY', 'xyz');
      addEnvRow($('#env-gcloud'), 'CLOUDSDK_CORE_PROJECT', 'proj-1');
      dlgSet.requestSubmit();
    })()`);
    await wait(1500);
    const saved = JSON.parse(fs.readFileSync(sp, 'utf8'));
    report.saved = { theme: saved.theme, model: saved.model, env: saved.env, permissions: saved.permissions, channel: saved.autoUpdatesChannel, skip: saved.skipDangerousModePermissionPrompt, other: Object.keys(saved) };
    report.backup = fs.existsSync(`${sp}.hub-backup`);
    report.hubSettings = JSON.parse(fs.readFileSync(HUB_SETTINGS_FILE, 'utf8'));
    report.modalClosed = await js('document.querySelector("#modal").hidden');
    report.masked = await js(`[...document.querySelectorAll('#env-claude .envrow')].map((r) => r.querySelectorAll('input')[1].type).join(',')`);
    const goodPatch = { model: '', defaultMode: 'bypassPermissions', allow: [], deny: [], ask: [], skipBypassPrompt: true, bypassAllowed: true, autoUpdates: true, channel: 'latest', env: {}, gcloudEnv: {} };
    report.bypassOn = await js(`window.hub.claudeSet(${JSON.stringify(goodPatch)})`);
    report.afterBypass = JSON.parse(fs.readFileSync(sp, 'utf8')).permissions;
    report.badMode = await js(`window.hub.claudeSet(${JSON.stringify({ ...goodPatch, defaultMode: 'bogus' })})`);
    report.badEnv = await js(`window.hub.claudeSet(${JSON.stringify({ ...goodPatch, env: { '1bad': 'x' } })})`);
    report.bypassConflict = await js(`window.hub.claudeSet(${JSON.stringify({ ...goodPatch, bypassAllowed: false })})`);
    fs.writeFileSync(sp, '{ not json');
    report.badJson = await js('window.hub.claudeGet()');
    report.mcpAdd = await js(`window.hub.mcpAdd({ name: 'selftest-mcp', transport: 'stdio', scope: 'user', target: 'node -e 1', env: ['A=1'], cwd: '' })`);
    report.mcpAddHttp = await js(`window.hub.mcpAdd({ name: 'selftest-http', transport: 'http', scope: 'user', target: 'https://example.com/mcp', cwd: '' })`);
    report.mcpBadName = await js(`window.hub.mcpAdd({ name: 'bad name!', transport: 'stdio', scope: 'user', target: 'x', cwd: '' })`);
    report.mcpList = await js('window.hub.mcpList("")');
    report.mcpRemove = await js(`Promise.all([window.hub.mcpRemove({ name: 'selftest-mcp', scope: 'user', cwd: '' }), window.hub.mcpRemove({ name: 'selftest-http', scope: 'user', cwd: '' })])`);
    report.mcpListAfter = await js('window.hub.mcpList("")');

    // review fixes
    const patchBase = { model: '', defaultMode: 'default', allow: [], deny: [], ask: [], skipBypassPrompt: false, bypassAllowed: true, autoUpdates: true, channel: 'latest', env: {}, gcloudEnv: {} };
    fs.writeFileSync(sp, JSON.stringify({ permissions: { defaultMode: 'someNewMode' }, env: { 'my-var': '1' } }));
    report.fix3_get = (await js('window.hub.claudeGet()')).modes;
    report.fix3_keepMode = await js(`window.hub.claudeSet(${JSON.stringify({ ...patchBase, defaultMode: 'someNewMode', env: { 'my-var': '1', 'NEW-ONE': '2' } })})`);
    report.fix3_otherUnknown = await js(`window.hub.claudeSet(${JSON.stringify({ ...patchBase, defaultMode: 'otherUnknown' })})`);
    const before = fs.readFileSync(sp, 'utf8');
    report.fix3_dryBad = await js(`window.hub.claudeSet(${JSON.stringify({ ...patchBase, defaultMode: 'otherUnknown', dryRun: true })})`);
    report.fix3_dryGood = await js(`window.hub.claudeSet(${JSON.stringify({ ...patchBase, defaultMode: 'plan', dryRun: true })})`);
    report.fix3_dryDidNotWrite = fs.readFileSync(sp, 'utf8') === before;

    const cfgBefore = fs.readFileSync(CONFIG_FILE, 'utf8');
    fs.writeFileSync(CONFIG_FILE, '{ bad');
    report.fix4_pin = await js(`window.hub.pinProject('C:/x', 'x', true)`);
    report.fix4_order = await js(`window.hub.setOrder(['a'])`);
    report.fix4_dry = await js(`window.hub.setSettings('C:/some/where', [], true)`);
    report.fix4_untouched = fs.readFileSync(CONFIG_FILE, 'utf8') === '{ bad';
    fs.writeFileSync(CONFIG_FILE, cfgBefore);
    report.fix4_pinOk = await js(`window.hub.pinProject('C:/x', 'x', true)`);
    report.fix4_noTmpLeft = !fs.existsSync(`${CONFIG_FILE}.hub-tmp`);

    report.fix6_url = await js(`fileUrl('C:/a/report #1.png?x')`);

    report.fix7_tok = await js(`window.hub.mcpAdd({ name: 'tok-test', transport: 'stdio', scope: 'user', target: 'node --root="C:/my folder" -e 1', env: [], cwd: '' })`);
    const cj = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
    report.fix7_args = (cj.mcpServers && cj.mcpServers['tok-test'] || {}).args;
    report.fix7_unclosed = await js(`window.hub.mcpAdd({ name: 'tok-bad', transport: 'stdio', scope: 'user', target: 'node "abc', env: [], cwd: '' })`);
    await js(`window.hub.mcpRemove({ name: 'tok-test', scope: 'user', cwd: '' })`);

    fs.writeFileSync(sp, JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: 'eu', ANTHROPIC_VERTEX_PROJECT_ID: process.env.ANTHROPIC_VERTEX_PROJECT_ID || '' } }));
    const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-resume-'));
    const cjTrust = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
    cjTrust.projects = { ...(cjTrust.projects || {}), [resumeDir.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true, allowedTools: [] } };
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify(cjTrust));
    await js(`openProject({ name: 'resume-test', path: ${JSON.stringify(resumeDir)}, pinned: false, last_session: 123 })`);
    await wait(10000);
    report.fix1_resume = await js(`(() => { const s = [...sessions.values()].find((x) => x.project.name === 'resume-test'); const b = s.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const t = b.getLine(i).translateToString(true).trim(); if (t) out.push(t); } return JSON.stringify({ alive: s.alive, lines: out.slice(0, 14) }); })()`);
    await js(`(() => { const s = [...sessions.values()].find((x) => x.project.name === 'resume-test'); window.hub.kill(s.id); })()`);
    await wait(1500);
    try { fs.rmSync(resumeDir, { recursive: true, force: true }); } catch { /* folder still locked by the dying process */ }
    fs.writeFileSync(path.join(__dirname, 'selftest-settings.json'), JSON.stringify(report, null, 2));
    app.quit();
    return;
  }
  try {
    await wait(1500);
    report.listTest = await js(`(async () => {
      const out = {};
      const unpinned = () => projects.filter((p) => !p.pinned).map((p) => p.name);
      const pinnedNames = () => projects.filter((p) => p.pinned).map((p) => p.name);
      out.pinnedBefore = pinnedNames();
      await togglePin(projects.find((p) => p.name === 'quote'));
      out.pinnedAfterPin = pinnedNames();
      out.unpinnedBefore = unpinned().slice(0, 3);
      const dt = new DataTransfer();
      const fire = (node, type, y) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
      const rows = [...document.querySelectorAll('#list li')];
      const unpinnedRows = rows.filter((r) => !r.classList.contains('pinned'));
      const src = unpinnedRows[unpinnedRows.length - 1];
      const dst = unpinnedRows[0];
      out.dragged = src.querySelector('.name').textContent;
      fire(src, 'dragstart', 0);
      const r = dst.getBoundingClientRect();
      fire(dst, 'dragover', r.top + 2);
      out.markShown = dst.classList.contains('drop-before');
      fire(dst, 'drop', r.top + 2);
      fire(src, 'dragend', 0);
      await new Promise((res) => setTimeout(res, 600));
      out.unpinnedAfterDrag = unpinned().slice(0, 3);
      await loadProjects();
      out.unpinnedAfterReload = unpinned().slice(0, 3);
      const pinnedRow = [...document.querySelectorAll('#list li.pinned')][0];
      fire(src, 'dragstart', 0);
      fire(pinnedRow, 'dragover', 0);
      out.crossGroupMarked = pinnedRow.classList.contains('drop-before') || pinnedRow.classList.contains('drop-after');
      fire(pinnedRow, 'drop', 0);
      fire(src, 'dragend', 0);
      await new Promise((res) => setTimeout(res, 300));
      out.crossGroupIgnored = pinnedNames().length === out.pinnedAfterPin.length && unpinned()[0] === out.dragged;
      await window.hub.setOrder(null);
      await loadProjects();
      out.unpinnedAfterReset = unpinned().slice(0, 3);
      await togglePin(projects.find((p) => p.name === 'quote'));
      out.pinnedAfterUnpin = pinnedNames();
      return out;
    })()`);
    await shot('selftest-list.png');
    await click('agent-hub');
    await wait(8000);
    report.firstTerminal = await dump('agent-hub');
    await js('openAuth()');
    await wait(5000);
    report.authTab = await dump('gcloud auth');
    const base = process.env.HUB_TEST_BASE;
    report.settings = await js(`window.hub.setSettings(${JSON.stringify(base)})`);
    report.badName = await js(`window.hub.createProject('a/b')`);
    report.created = await js(`createProjectFlow('selftest-newproj')`);
    report.dupe = await js(`window.hub.createProject('selftest-newproj')`);
    await wait(7000);
    report.folderExists = fs.existsSync(path.join(base, 'selftest-newproj'));
    report.activeAfterCreate = await js('activeKey');
    report.newTab = await dump('selftest-newproj');
    const proj = path.join(base, 'selftest-newproj');
    fs.writeFileSync(path.join(proj, 'report.csv'), 'name,qty\nbolt,3\nnut,9\n');
    fs.writeFileSync(path.join(proj, 'chart.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    fs.writeFileSync(path.join(proj, 'helper.js'), 'console.log(1)\n');
    fs.mkdirSync(path.join(proj, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'node_modules', 'x.txt'), 'junk');
    await wait(3500);
    report.outputs = await js(`(async () => JSON.stringify({ all: outputs.map((o) => o.name), shownCards: document.querySelectorAll('#outputs-list li.out').length, textPreview: (outputs.find((o) => o.name === 'report.csv') || {}).text, imgLoaded: !!document.querySelector('#outputs-list img.oprev'), guard: await window.hub.previewFile('C:/Windows/win.ini') }))()`);
    await shot('selftest-out.png');
    report.font = await js(`(() => {
      localStorage.setItem('termFont', 'Consolas'); localStorage.setItem('termFontSize', '20');
      applyTermFont();
      const after = [...sessions.values()].map((s) => [s.term.options.fontSize, s.term.options.fontFamily.slice(0, 12)]);
      localStorage.removeItem('termFont'); localStorage.removeItem('termFontSize');
      applyTermFont();
      const reset = [...sessions.values()].map((s) => s.term.options.fontSize);
      return JSON.stringify({ after, reset });
    })()`);
    report.perProject = await js(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const count = (sel) => document.querySelectorAll(sel).length;
      const out = {};
      const newp = [...sessions.values()].find((s) => s.project.name.startsWith('selftest-newproj'));
      const hub = [...sessions.values()].find((s) => s.project.name.startsWith('agent-hub'));
      activate(newp.key);
      const c = document.createElement('canvas'); c.width = 400; c.height = 240;
      const g = c.getContext('2d'); g.fillStyle = '#2b6cb0'; g.fillRect(0, 0, 400, 240);
      g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText('preview test', 60, 130);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const saved = await window.hub.saveImage(await blob.arrayBuffer(), 'png');
      addItems([{ path: saved, isImage: true }], false);
      out.newp = { title: document.querySelector('#drop-proj').textContent, chips: count('#chips li'), previews: count('#chips img.preview'), previewWidth: document.querySelector('#chips img.preview').naturalWidth, outputs: count('#outputs-list li.out') };
      activate(hub.key);
      await wait(300);
      out.hub = { title: document.querySelector('#out-proj').textContent, chips: count('#chips li'), outputs: count('#outputs-list li.out') };
      activate(newp.key);
      await wait(300);
      out.backAgain = { chips: count('#chips li'), outputs: count('#outputs-list li.out') };
      out.saved = JSON.parse(localStorage.getItem('openTabs'));
      return JSON.stringify(out);
    })()`);
    await shot('selftest.png');
    report.counts = await js(`JSON.stringify({ tabs: document.querySelectorAll('.tab').length, rightbarWidth: document.querySelector('#rightbar').offsetWidth })`);
  } catch (e) {
    report.error = String(e);
  }
  fs.writeFileSync(path.join(__dirname, 'selftest.json'), JSON.stringify(report, null, 2));
  app.quit();
}

// ---------- project discovery (built in: no Python / external launcher needed) ----------
const SESSIONS_DIR = path.join(HOME, '.claude', 'projects');
const DEFAULT_AUTO_ROOTS = ['Desktop', 'OneDrive/Desktop', 'Documents', 'OneDrive/Documents', 'source/repos', 'repos', 'dev', 'code', 'src', 'projects', 'Projects', 'github', 'GitHub'];
const MARKER_FILES = new Set(['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'claude.md']);
const MARKER_SUFFIXES = ['.sln', '.csproj'];
const AI_MARKER_FILES = new Set(['claude.md', 'agents.md', 'opencode.json', 'opencode.jsonc', '.claude', '.opencode', '.cursorrules', '.cursor', '.windsurfrules', '.aider.conf.yml']);
const OPENCODE_DB = process.env.HUB_OPENCODE_DB || path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
const SKIP_DIRS = new Set(['node_modules', 'venv', 'env', '__pycache__', 'dist', 'build', 'appdata', 'site-packages']);
const SCAN_BUDGET = 4000;

function normKey(p) {
  let n = path.normalize(String(p));
  if (n.length > 3) n = n.replace(/[\\/]+$/, '');
  return n.toLowerCase();
}

function globToRegex(glob) {
  const body = String(glob).toLowerCase().replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

function readSessionCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n').slice(0, 51)) {
      const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { /* malformed escape: keep looking */ } }
    }
  } catch { /* unreadable transcript */ } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
  return null;
}

function claudeSessionIndex() {
  const idx = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return idx; }
  for (const d of dirs) {
    const dir = path.join(SESSIONS_DIR, d.name);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs / 1000 }))
        .sort((a, b) => b.t - a.t);
    } catch { continue; }
    for (const { f } of files.slice(0, 3)) {
      const cwd = readSessionCwd(f);
      if (cwd) { idx.set(normKey(cwd), [cwd, files[0].t]); break; }
    }
  }
  return idx;
}

// opencode keeps its sessions in a SQLite database. Read it best-effort: a missing
// database, an old schema, or a strict read-only lock simply yields no opencode hits.
function opencodeSessionIndex() {
  const idx = new Map();
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return idx; }
  let db;
  try {
    db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
    const rows = db.prepare('select directory, max(time_updated) as t from session group by directory').all();
    for (const row of rows) {
      if (!row.directory) continue;
      const ms = Number(row.t) || 0;
      idx.set(normKey(row.directory), [row.directory, ms > 1e12 ? ms / 1000 : ms]);
    }
  } catch { /* database missing, locked or schema changed */ } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }
  return idx;
}

function agentSessionIndex() {
  const idx = new Map();
  const addHit = (cwd, t, agent) => {
    if (!cwd) return;
    const key = normKey(cwd);
    const cur = idx.get(key);
    if (!cur) idx.set(key, { cwd: String(cwd), time: t || 0, agents: new Set([agent]) });
    else { cur.time = Math.max(cur.time, t || 0); cur.agents.add(agent); }
  };
  for (const [, [cwd, t]] of claudeSessionIndex()) addHit(cwd, t, 'claude');
  for (const [, [cwd, t]] of opencodeSessionIndex()) addHit(cwd, t, 'opencode');
  return idx;
}

function dirInfo(dir) {
  try {
    const names = fs.readdirSync(dir);
    let root = false;
    let aiConfig = false;
    for (const n of names) {
      const l = n.toLowerCase();
      if (MARKER_FILES.has(l) || MARKER_SUFFIXES.some((s) => l.endsWith(s))) root = true;
      if (AI_MARKER_FILES.has(l)) aiConfig = true;
    }
    return { root, aiConfig };
  } catch { return { root: false, aiConfig: false }; }
}

function childDirs(dir, isExcluded) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase()) && !isExcluded(e.name))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

function autoScan(cfg, excludeRes) {
  const roots = Array.isArray(cfg.auto_scan) ? cfg.auto_scan : DEFAULT_AUTO_ROOTS.map((r) => path.join(HOME, r));
  const depth = Number.isInteger(cfg.auto_scan_depth) ? cfg.auto_scan_depth : 2;
  let budget = SCAN_BUDGET;
  const found = [];
  const walk = (dir, level) => {
    let subdirs = [];
    try { subdirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return; }
    for (const e of subdirs) {
      if (--budget < 0) return;
      const n = e.name.toLowerCase();
      if (n.startsWith('.') || SKIP_DIRS.has(n) || excludeRes.some((re) => re.test(n))) continue;
      const full = path.join(dir, e.name);
      const info = dirInfo(full);
      if (info.root) found.push({ path: full, aiConfig: info.aiConfig });
      else if (level < depth) walk(full, level + 1);
    }
  };
  for (const r of roots) { if (isDir(r)) walk(r, 1); }
  return found;
}

function hasListedAncestor(p, found) {
  let dir = path.dirname(path.normalize(String(p)));
  while (true) {
    if (found.has(normKey(dir))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function buildProjects() {
  const cfg = readConfig();
  const sessions = agentSessionIndex();
  const excludeRes = (cfg.exclude || []).map(globToRegex);
  const isExcluded = (name) => excludeRes.some((re) => re.test(String(name).toLowerCase()));
  const found = new Map();
  const containers = new Set();

  const hidden = new Set((cfg.hidden || []).map(normKey));
  const add = (p, name, opts = {}) => {
    if (!isDir(p)) return;
    const key = normKey(p);
    if (hidden.has(key)) return;
    const cur = found.get(key);
    if (cur) {
      if (opts.pinned) { cur.pinned = true; cur.name = name; }
      if (opts.root) cur.root = true;
      if (opts.aiConfig) cur.aiConfig = true;
      for (const a of opts.agents || []) cur.agents.add(a);
      return;
    }
    const sess = sessions.get(key);
    let folderMtime = 0;
    try { folderMtime = fs.statSync(p).mtimeMs / 1000; } catch { /* keep 0 */ }
    found.set(key, {
      name,
      path: String(p),
      pinned: Boolean(opts.pinned),
      last_session: sess ? sess.time : null,
      activity: sess ? sess.time : folderMtime,
      root: Boolean(opts.root),
      aiConfig: Boolean(opts.aiConfig),
      group: opts.group || null,
      agents: new Set([...(opts.agents || []), ...(sess ? sess.agents : [])]),
    });
  };

  for (const item of cfg.pinned || []) add(item.path, item.name || path.basename(item.path), { pinned: true, root: true });

  const scanRoots = [...(cfg.scan_roots || [])];
  if (cfg.new_projects_path) scanRoots.push(cfg.new_projects_path);
  for (const root of scanRoots) {
    let kids = [];
    try { kids = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const k of kids) {
      if (!k.isDirectory() || k.name.startsWith('.') || SKIP_DIRS.has(k.name.toLowerCase()) || isExcluded(k.name)) continue;
      const full = path.join(root, k.name);
      const info = dirInfo(full);
      // A folder with no project marker that only groups subfolders (e.g. EDO, EDW) is not a project itself: list its subfolders instead.
      const subs = info.root ? [] : childDirs(full, isExcluded);
      if (subs.length) {
        containers.add(normKey(full));
        for (const s of subs) add(s, path.basename(s), { root: true, aiConfig: dirInfo(s).aiConfig, group: full });
      } else add(full, k.name, { root: true, aiConfig: info.aiConfig });
    }
  }

  for (const hit of autoScan(cfg, excludeRes)) add(hit.path, path.basename(hit.path), { root: true, aiConfig: hit.aiConfig });

  for (const [key, hit] of sessions) {
    if (containers.has(key) || isExcluded(path.basename(hit.cwd))) continue;
    add(hit.cwd, key === normKey(HOME) ? 'Home' : path.basename(hit.cwd), { agents: hit.agents });
  }

  // Anything that did not come from a marker/pin/scan root is a root only when it
  // is not nested inside another listed project (e.g. an agent's cwd subfolder).
  for (const item of found.values()) {
    if (!item.root && !hasListedAncestor(item.path, found)) item.root = true;
  }

  const order = new Map((cfg.order || []).map((p, i) => [normKey(p), i]));
  const rank = (x) => (order.has(normKey(x.path)) ? order.get(normKey(x.path)) : order.size);
  const list = [...found.values()].map((x) => ({
    name: x.name,
    path: x.path,
    pinned: x.pinned,
    last_session: x.last_session,
    activity: x.activity,
    root: x.root,
    nested: !x.root,
    ai: x.agents.size > 0,
    aiConfig: x.aiConfig,
    group: x.pinned ? null : x.group,
    groupName: x.pinned || !x.group ? null : path.basename(x.group),
    agents: [...x.agents],
  }));
  return list.sort((a, b) => (Number(!a.pinned) - Number(!b.pinned)) || (rank(a) - rank(b)) || (b.activity - a.activity));
}

ipcMain.handle('projects:list', () => {
  try { return { projects: buildProjects() }; } catch (e) { return { error: `Failed to read projects: ${e.message}` }; }
});

// Minimal Greek strings for the few main-process texts that are translated (the renderer sends its language).
const EL_MAIN = {
  'Unpin': 'Ξεκαρφίτσωμα',
  'Pin to top': 'Καρφίτσωμα (πάνω-πάνω)',
  'Open folder': 'Άνοιγμα φακέλου',
  'Copy path': 'Αντιγραφή διαδρομής',
  'Rename...': 'Μετονομασία...',
  'Reset order (recent first)': 'Επαναφορά σειράς (πρόσφατα πρώτα)',
  'No previous session - starting a new one': 'Δεν υπάρχει προηγούμενη συνεδρία - ξεκινάει νέα',
};
Object.assign(EL_MAIN, {
  'Hide from list': 'Απόκρυψη από τη λίστα',
  'Delete project...': 'Διαγραφή project...',
  'Restore hidden projects ({n})': 'Επαναφορά κρυμμένων projects ({n})',
  'Move to Recycle Bin': 'Μεταφορά στον Κάδο Ανακύκλωσης',
  'Cancel': 'Άκυρο',
  'Delete project "{name}"?': 'Διαγραφή του project "{name}";',
  'The whole folder will be moved to the Recycle Bin, so you can still restore it from there:': 'Ολόκληρος ο φάκελος θα μεταφερθεί στον Κάδο Ανακύκλωσης, οπότε μπορείς να τον επαναφέρεις από εκεί:',
  'This folder cannot be deleted from here.': 'Αυτός ο φάκελος δεν μπορεί να διαγραφεί από εδώ.',
  'Project is not in the list.': 'Το project δεν υπάρχει στη λίστα.',
  'Could not move the folder to the Recycle Bin: {error}': 'Δεν ήταν δυνατή η μεταφορά του φακέλου στον Κάδο Ανακύκλωσης: {error}',
  'Enter a name.': 'Βάλε όνομα.',
  'Invalid folder name (not allowed: \\ / : * ? " < > | or a trailing dot/space).': 'Μη έγκυρο όνομα φακέλου (δεν επιτρέπονται: \\ / : * ? " < > | ή τελεία/κενό στο τέλος).',
  'This folder cannot be renamed from here.': 'Αυτός ο φάκελος δεν μπορεί να μετονομαστεί από εδώ.',
  'A folder with this name already exists.': 'Υπάρχει ήδη φάκελος με αυτό το όνομα.',
  "Close this project's terminal first, then rename it.": 'Κλείσε πρώτα το terminal αυτού του project και μετά μετονόμασέ το.',
  'Could not rename the folder: {error}': 'Δεν ήταν δυνατή η μετονομασία του φακέλου: {error}',
});
const tr = (lang, en) => (lang === 'el' && EL_MAIN[en]) || en;
const tf = (lang, en, vars = {}) => tr(lang, en).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

function spawnPty(id, kind, cwd, resume, cols, rows, lang, agent = 'claude') {
  const exe = agent === 'opencode' ? findOpencode() : findClaude();
  const args = resume ? ['--continue'] : [];
  let file = exe || 'cmd.exe';
  let fileArgs = exe ? args : ['/c', agent === 'opencode' ? 'opencode' : 'claude', ...args];
  if (kind === 'auth') {
    file = 'cmd.exe';
    fileArgs = process.env.HUB_AUTH_DRYRUN ? ['/c', 'gcloud', 'version'] : ['/c', 'gcloud', 'auth', 'application-default', 'login'];
  }
  const startedAt = Date.now();
  const p = pty.spawn(file, fileArgs, {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 30,
    cwd,
    env: {
      // Classic renderer: Claude Code writes into the terminal's native scrollback, so the xterm scrollbar works.
      ...(agent === 'claude' && kind !== 'auth' ? { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' } : {}),
      ...process.env,
      ...(kind === 'auth' ? readHubSettings().gcloudEnv : {}),
      COLORTERM: 'truecolor',
      TERM: 'xterm-256color',
    },
  });
  ptys.set(id, p);
  ptyCwd.set(id, cwd);
  if (kind !== 'auth') startWatch(id, cwd);
  let tail = '';
  p.onData((d) => {
    tail = (tail + d).slice(-2000);
    if (win) win.webContents.send('pty:data', id, d);
  });
  p.onExit((e) => {
    // A deliberate kill (e.g. restarting the tab to switch agents) should not surface an "exited" notice.
    if (killedPtys.delete(id)) return;
    const current = ptys.get(id) === p;
    const noConversation = /No conversation found/i.test(tail);
    if (current && kind !== 'auth' && resume && e.exitCode !== 0 && (noConversation || Date.now() - startedAt < 5000)) {
      ptys.delete(id);
      if (win) win.webContents.send('pty:data', id, `\r\n\x1b[33m[${tr(lang, 'No previous session - starting a new one')}]\x1b[0m\r\n`);
      try { spawnPty(id, kind, cwd, false, p.cols, p.rows, lang, agent); return; } catch { /* report the exit below */ }
    }
    if (current) { ptys.delete(id); stopWatch(id); }
    if (win) win.webContents.send('pty:exit', id, e.exitCode);
  });
}

function onPath(cmd) {
  try { execFileSync('where', [cmd], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; }
}

ipcMain.handle('pty:spawn', (_e, { id, kind, cwd, resume, cols, rows, lang, agent: rawAgent }) => {
  if (ptys.has(id)) return { ok: true };
  const agent = rawAgent === 'opencode' ? 'opencode' : 'claude';
  if (kind === 'auth' && !process.env.HUB_AUTH_DRYRUN && !onPath('gcloud')) {
    return { ok: false, error: 'Google Cloud CLI (gcloud) was not found. The Auth button is only needed if you use Claude through Google Vertex AI. If you use a Claude subscription or an API key, run "claude" and log in there instead. Otherwise install gcloud: https://cloud.google.com/sdk/docs/install' };
  }
  if (kind !== 'auth') {
    const available = agent === 'opencode' ? Boolean(findOpencode() || onPath('opencode')) : Boolean(findClaude() || onPath('claude'));
    if (!available) {
      return {
        ok: false,
        error: agent === 'opencode'
          ? 'opencode was not found on this computer. Install it from https://opencode.ai (or run: npm install -g opencode-ai), then reopen this tab. If you have just installed it, restart Agent Hub so it picks up the new PATH.'
          : 'Claude Code was not found on this computer. Install it from https://claude.com/claude-code (or run: npm install -g @anthropic-ai/claude-code), then reopen this tab. If you have just installed it, restart Agent Hub so it picks up the new PATH.',
      };
    }
  }
  try {
    spawnPty(id, kind, cwd, resume, cols, rows, lang, agent);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('paths:exist', (_e, paths) => (Array.isArray(paths) ? paths.map((p) => isDir(String(p))) : []));

ipcMain.on('pty:write', (_e, id, data) => { const p = ptys.get(id); if (p) p.write(data); });
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  const p = ptys.get(id);
  if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch { /* pty already closed */ } }
});
ipcMain.on('pty:kill', (_e, id) => {
  const p = ptys.get(id);
  stopWatch(id);
  if (p) { killedPtys.add(id); ptys.delete(id); try { p.kill(); } catch { /* already gone */ } }
});

ipcMain.handle('file:preview', (_e, p) => {
  if (!isKnownFile(p)) return null;
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const slice = buf.subarray(0, n);
    return slice.includes(0) ? null : slice.toString('utf8');
  } catch { return null; }
});

ipcMain.handle('file:save', async (e, p) => {
  if (!isKnownFile(p)) return { saved: null };
  const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: path.join(app.getPath('downloads'), path.basename(p)),
  });
  if (res.canceled || !res.filePath) return { saved: null };
  try { fs.copyFileSync(p, res.filePath); } catch (err) { return { saved: null, error: err.message }; }
  return { saved: res.filePath };
});

ipcMain.handle('url:open', (_e, raw) => {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  shell.openExternal(u.href);
  return true;
});
ipcMain.handle('file:open', (_e, p) => (isKnownFile(p) ? shell.openPath(p) : ''));
ipcMain.on('file:reveal', (_e, p) => { if (isKnownFile(p)) shell.showItemInFolder(p); });
ipcMain.on('file:drag', (e, p) => { if (isKnownFile(p)) e.sender.startDrag({ file: p, icon: dragIcon }); });

function stamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}-${Math.floor(Math.random() * 1000)}`;
}

function saveToInbox(prefix, ext, data) {
  fs.mkdirSync(INBOX, { recursive: true });
  const file = path.join(INBOX, `${prefix}-${stamp()}.${ext}`);
  fs.writeFileSync(file, data);
  return file;
}

ipcMain.handle('inbox:saveImage', (_e, buffer, ext) => saveToInbox('image', String(ext || 'png').replace(/[^a-z0-9]/gi, ''), Buffer.from(buffer)));
ipcMain.handle('inbox:saveText', (_e, text) => saveToInbox('text', 'txt', String(text)));
ipcMain.handle('inbox:open', () => { fs.mkdirSync(INBOX, { recursive: true }); return shell.openPath(INBOX); });

ipcMain.handle('clipboard:read', async () => {
  // Fallback only: the renderer reads the clipboard itself. Electron 45's clipboard is async and has no readImage.
  const text = await clipboard.readText();
  return text ? { type: 'text', text } : { type: 'empty' };
});

ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

ipcMain.on('project:menu', (e, { path: projectPath, pinned, lang }) => {
  const p = String(projectPath);
  let isDir = false;
  try { isDir = fs.statSync(p).isDirectory(); } catch { /* missing folder */ }
  const act = (action) => () => e.sender.send('project:action', { action, path: p });
  const hiddenCount = (readConfig().hidden || []).length;
  Menu.buildFromTemplate([
    { label: tr(lang, pinned ? 'Unpin' : 'Pin to top'), click: act('pin') },
    { type: 'separator' },
    { label: tr(lang, 'Open folder'), enabled: isDir, click: () => shell.openPath(p) },
    { label: tr(lang, 'Copy path'), click: () => clipboard.writeText(p) },
    { label: tr(lang, 'Rename...'), enabled: isDir, click: act('rename') },
    { type: 'separator' },
    { label: tr(lang, 'Reset order (recent first)'), click: act('resetOrder') },
    { type: 'separator' },
    { label: tr(lang, 'Hide from list'), click: act('hide') },
    ...(hiddenCount ? [{ label: tf(lang, 'Restore hidden projects ({n})', { n: hiddenCount }), click: act('unhideAll') }] : []),
    { label: tr(lang, 'Delete project...'), click: act('delete') },
  ]).popup({ window: BrowserWindow.fromWebContents(e.sender) });
});

// Hide = just stop listing it (nothing is touched on disk). Stored in config.json as "hidden".
ipcMain.handle('projects:hide', (_e, projectPath) => {
  const r = readConfigStrict();
  if (!r.ok) return { ok: false, error: r.error };
  const cfg = r.cfg;
  cfg.hidden = [...(cfg.hidden || []).filter((x) => !sameDir(x, projectPath)), String(projectPath)];
  cfg.pinned = (cfg.pinned || []).filter((x) => !sameDir(x.path, projectPath));
  if (cfg.order) cfg.order = cfg.order.filter((x) => !sameDir(x, projectPath));
  try { writeConfig(cfg); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true };
});

ipcMain.handle('projects:unhideAll', () => {
  const r = readConfigStrict();
  if (!r.ok) return { ok: false, error: r.error };
  delete r.cfg.hidden;
  try { writeConfig(r.cfg); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true };
});

// Delete = confirm, close that project's terminals, then move the folder to the Recycle Bin (restorable).
ipcMain.handle('projects:delete', async (e, projectPath, lang) => {
  const p = String(projectPath);
  const T = (en, vars) => tf(lang, en, vars);
  if (!isDir(p) || isShallowDir(p)) return { ok: false, error: T('This folder cannot be deleted from here.') };
  if (!buildProjects().some((x) => sameDir(x.path, p))) return { ok: false, error: T('Project is not in the list.') };
  const ans = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
    type: 'warning',
    buttons: [T('Cancel'), T('Move to Recycle Bin')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: T('Delete project "{name}"?', { name: path.basename(p) }),
    detail: `${T('The whole folder will be moved to the Recycle Bin, so you can still restore it from there:')}\n\n${p}`,
  });
  if (ans.response !== 1) return { ok: false, cancelled: true };
  for (const [id, cwd] of [...ptyCwd]) {
    if (!sameDir(cwd, p)) continue;
    const proc = ptys.get(id);
    stopWatch(id);
    ptys.delete(id);
    ptyCwd.delete(id);
    if (proc) { try { proc.kill(); } catch { /* already gone */ } }
  }
  let lastErr;
  for (let i = 0; i < 5; i += 1) { // the folder may stay locked for a moment after the terminal closes
    try { await shell.trashItem(p); lastErr = null; break; } catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 600)); }
  }
  if (lastErr) return { ok: false, error: T('Could not move the folder to the Recycle Bin: {error}', { error: lastErr.message }) };
  const r = readConfigStrict();
  if (r.ok) {
    const cfg = r.cfg;
    cfg.pinned = (cfg.pinned || []).filter((x) => !sameDir(x.path, p));
    if (cfg.order) cfg.order = cfg.order.filter((x) => !sameDir(x, p));
    try { writeConfig(cfg); } catch { /* the folder is gone anyway; the list simply skips missing folders */ }
  }
  return { ok: true };
});

// Rename = rename the folder on disk and keep config references in sync.
ipcMain.handle('projects:rename', (_e, projectPath, rawName, lang) => {
  const p = String(projectPath);
  const T = (en, vars) => tf(lang, en, vars);
  const name = String(rawName || '').trim();
  if (!name) return { ok: false, error: T('Enter a name.') };
  if (name.length > 100 || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || RESERVED.test(name)) {
    return { ok: false, error: T('Invalid folder name (not allowed: \\ / : * ? " < > | or a trailing dot/space).') };
  }
  if (!isDir(p) || isShallowDir(p)) return { ok: false, error: T('This folder cannot be renamed from here.') };
  if (!buildProjects().some((x) => sameDir(x.path, p))) return { ok: false, error: T('Project is not in the list.') };
  const target = path.join(path.dirname(p), name);
  if (target === p) return { ok: true, path: p, name };
  if (!sameDir(target, p) && fs.existsSync(target)) return { ok: false, error: T('A folder with this name already exists.') };
  for (const cwd of ptyCwd.values()) {
    if (sameDir(cwd, p)) return { ok: false, error: T("Close this project's terminal first, then rename it.") };
  }
  try { fs.renameSync(p, target); } catch (err) { return { ok: false, error: T('Could not rename the folder: {error}', { error: err.message }) }; }
  const r = readConfigStrict();
  if (r.ok) {
    const cfg = r.cfg;
    cfg.pinned = (cfg.pinned || []).map((x) => (sameDir(x.path, p) ? { ...x, name, path: target } : x));
    if (cfg.order) cfg.order = cfg.order.map((x) => (sameDir(x, p) ? target : x));
    if (cfg.hidden) cfg.hidden = cfg.hidden.map((x) => (sameDir(x, p) ? target : x));
    try { writeConfig(cfg); } catch { /* the folder is renamed; the list picks it up from disk */ }
  }
  return { ok: true, path: target, name };
});

const sameDir = (a, b) => path.normalize(String(a)).toLowerCase() === path.normalize(String(b)).toLowerCase();

ipcMain.handle('projects:pin', (_e, projectPath, name, pinned) => {
  const r = readConfigStrict();
  if (!r.ok) return { ok: false, error: r.error };
  const cfg = r.cfg;
  const rest = (cfg.pinned || []).filter((x) => !sameDir(x.path, projectPath));
  cfg.pinned = pinned ? [...rest, { name: String(name), path: String(projectPath) }] : rest;
  try { writeConfig(cfg); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true };
});

ipcMain.handle('projects:order', (_e, paths) => {
  const r = readConfigStrict();
  if (!r.ok) return { ok: false, error: r.error };
  const cfg = r.cfg;
  if (paths === null) delete cfg.order;
  else if (Array.isArray(paths)) cfg.order = paths.map(String);
  try { writeConfig(cfg); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true };
});

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const SETTINGS_FILE = path.join(CLAUDE_HOME, 'settings.json');
const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR ? path.join(CLAUDE_HOME, '.claude.json') : path.join(HOME, '.claude.json');
const HUB_SETTINGS_FILE = process.env.HUB_SETTINGS || path.join(HOME, '.claude', 'hub-settings.json');
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'];
const VALID_MODES = new Set(PERMISSION_MODES);
const MANAGED_ENV = new Set(['ANTHROPIC_MODEL', 'DISABLE_AUTOUPDATER']);
const ENV_NAME = /^[^\s=\u0000]+$/;
const MCP_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function readJsonFile(file) {
  if (!fs.existsSync(file)) return { ok: true, data: {}, exists: false };
  try { return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')), exists: true }; } catch (e) { return { ok: false, error: e.message }; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.hub-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readHubSettings() {
  const r = readJsonFile(HUB_SETTINGS_FILE);
  return { gcloudEnv: {}, ...(r.ok ? r.data : {}) };
}

function cleanEnvMap(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!ENV_NAME.test(k)) throw new Error(`Invalid variable name: ${k}`);
    out[k] = String(v).replace(/[\r\n]+/g, ' ');
  }
  return out;
}

ipcMain.handle('claude:get', () => {
  const r = readJsonFile(SETTINGS_FILE);
  if (!r.ok) return { error: `settings.json is not valid JSON: ${r.error}`, path: SETTINGS_FILE };
  const s = r.data;
  const env = s.env || {};
  const perms = s.permissions || {};
  const noUpdate = env.DISABLE_AUTOUPDATER !== undefined && !['', '0', 'false'].includes(String(env.DISABLE_AUTOUPDATER).toLowerCase());
  return {
    path: SETTINGS_FILE,
    model: env.ANTHROPIC_MODEL !== undefined ? String(env.ANTHROPIC_MODEL) : (s.model || ''),
    modelSource: env.ANTHROPIC_MODEL !== undefined ? 'env' : 'settings',
    defaultMode: perms.defaultMode || 'default',
    bypassAllowed: perms.disableBypassPermissionsMode !== 'disable',
    allow: perms.allow || [],
    deny: perms.deny || [],
    ask: perms.ask || [],
    skipBypassPrompt: Boolean(s.skipDangerousModePermissionPrompt),
    autoUpdates: !noUpdate,
    channel: s.autoUpdatesChannel || 'latest',
    env: Object.fromEntries(Object.entries(env).filter(([k]) => !MANAGED_ENV.has(k))),
    gcloudEnv: readHubSettings().gcloudEnv || {},
    modes: PERMISSION_MODES.includes(perms.defaultMode) || !perms.defaultMode ? PERMISSION_MODES : [...PERMISSION_MODES, perms.defaultMode],
  };
});

ipcMain.handle('claude:set', (_e, patch) => {
  try {
    const r = readJsonFile(SETTINGS_FILE);
    if (!r.ok) throw new Error(`settings.json is not valid JSON: ${r.error}`);
    const s = r.data;
    if (!VALID_MODES.has(patch.defaultMode) && patch.defaultMode !== (s.permissions || {}).defaultMode) throw new Error('Invalid permission mode.');
    if (patch.defaultMode === 'bypassPermissions' && patch.bypassAllowed === false) throw new Error('Bypass mode is disabled. Check "Allow bypass mode" or pick another mode.');
    if (!['latest', 'stable'].includes(patch.channel)) throw new Error('Invalid update channel.');
    const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
    const env = cleanEnvMap(patch.env);
    const gcloudEnv = cleanEnvMap(patch.gcloudEnv);
    for (const k of MANAGED_ENV) delete env[k];

    const model = String(patch.model || '').trim();
    const envHadModel = (s.env || {}).ANTHROPIC_MODEL !== undefined;
    if (envHadModel) { if (model) env.ANTHROPIC_MODEL = model; } else if (model) s.model = model; else delete s.model;
    if (patch.autoUpdates === false) env.DISABLE_AUTOUPDATER = '1';
    if (Object.keys(env).length) s.env = env; else delete s.env;
    if (patch.channel === 'latest') delete s.autoUpdatesChannel; else s.autoUpdatesChannel = patch.channel;

    s.permissions = s.permissions || {};
    s.permissions.defaultMode = patch.defaultMode;
    if (patch.bypassAllowed === false) s.permissions.disableBypassPermissionsMode = 'disable'; else delete s.permissions.disableBypassPermissionsMode;
    for (const k of ['allow', 'deny', 'ask']) {
      const items = list(patch[k]);
      if (items.length) s.permissions[k] = items; else delete s.permissions[k];
    }
    if (patch.skipBypassPrompt) s.skipDangerousModePermissionPrompt = true; else delete s.skipDangerousModePermissionPrompt;

    if (patch.dryRun) return { ok: true };
    if (r.exists) fs.copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.hub-backup`);
    writeJsonAtomic(SETTINGS_FILE, s);
    const hub = readHubSettings();
    hub.gcloudEnv = gcloudEnv;
    writeJsonAtomic(HUB_SETTINGS_FILE, hub);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const OPENCODE_DIR = path.join(HOME, '.config', 'opencode');
const OPENCODE_STATE_FILE = path.join(HOME, '.local', 'state', 'opencode', 'model.json');
const OPENCODE_AUTH_FILE = path.join(HOME, '.local', 'share', 'opencode', 'auth.json');
const OPENCODE_PERM_PRESETS = {
  ask: { edit: 'ask', bash: 'ask' },
  deny: { edit: 'deny', bash: 'deny' },
};

function opencodeConfigFile() {
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const file = path.join(OPENCODE_DIR, name);
    if (fs.existsSync(file)) return file;
  }
  return path.join(OPENCODE_DIR, 'opencode.json');
}

function stripJsonComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '"') {
      out += c;
      for (i++; i < text.length; i++) {
        out += text[i];
        if (text[i] === '\\') { out += text[i + 1] || ''; i++; continue; }
        if (text[i] === '"') break;
      }
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      if (i < text.length) out += '\n';
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function stripTrailingCommas(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      out += c;
      for (i++; i < text.length; i++) {
        out += text[i];
        if (text[i] === '\\') { out += text[i + 1] || ''; i++; continue; }
        if (text[i] === '"') break;
      }
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

function readOpencodeConfig(file) {
  if (!fs.existsSync(file)) return { ok: true, data: {}, exists: false };
  try { return { ok: true, data: parseJsonc(fs.readFileSync(file, 'utf8')), exists: true }; } catch (e) { return { ok: false, error: e.message }; }
}

function readOpencodeCurrentModel() {
  const r = readJsonFile(OPENCODE_STATE_FILE);
  if (!r.ok) return '';
  const recent = Array.isArray(r.data && r.data.recent) ? r.data.recent : [];
  const m = recent[0];
  return m && m.providerID && m.modelID ? `${m.providerID}/${m.modelID}` : '';
}

function classifyOpencodePermission(perm) {
  if (perm === undefined || perm === null) return 'default';
  if (perm === 'allow' || perm === 'ask' || perm === 'deny') return perm;
  if (typeof perm === 'object' && !Array.isArray(perm)) {
    for (const mode of ['ask', 'deny']) {
      const preset = OPENCODE_PERM_PRESETS[mode];
      const keys = Object.keys(preset);
      if (keys.length === Object.keys(perm).length && keys.every((k) => perm[k] === preset[k])) return mode;
    }
  }
  return 'custom';
}

ipcMain.handle('opencode:get', () => {
  const file = opencodeConfigFile();
  const r = readOpencodeConfig(file);
  if (!r.ok) return { error: `opencode config is not valid JSON: ${r.error}`, path: file };
  const auth = readJsonFile(OPENCODE_AUTH_FILE);
  if (!auth.ok) return { error: `opencode auth is not valid JSON: ${auth.error}`, path: OPENCODE_AUTH_FILE };
  const s = r.data || {};
  const deepseek = auth.data && auth.data.deepseek;
  return {
    path: file,
    model: typeof s.model === 'string' ? s.model : '',
    currentModel: readOpencodeCurrentModel(),
    permMode: classifyOpencodePermission(s.permission),
    deepseekKey: deepseek && typeof deepseek.key === 'string' ? deepseek.key : '',
  };
});

ipcMain.handle('opencode:set', (_e, patch) => {
  try {
    const file = opencodeConfigFile();
    const r = readOpencodeConfig(file);
    if (!r.ok) throw new Error(`opencode config is not valid JSON: ${r.error}`);
    let s = r.data || {};
    const model = String(patch.model || '').trim();
    if (!r.exists && patch.permMode === 'default' && !model && patch.deepseekKey === undefined) return { ok: true };
    switch (patch.permMode) {
      case 'default': delete s.permission; break;
      case 'allow': s.permission = 'allow'; break;
      case 'ask': s.permission = { ...OPENCODE_PERM_PRESETS.ask }; break;
      case 'deny': s.permission = { ...OPENCODE_PERM_PRESETS.deny }; break;
      case 'custom': break;
      default: throw new Error('Invalid permission mode.');
    }
    if (model) s.model = model; else delete s.model;
    if (!s.$schema) s = { $schema: 'https://opencode.ai/config.json', ...s };

    const auth = readJsonFile(OPENCODE_AUTH_FILE);
    if (!auth.ok) throw new Error(`opencode auth is not valid JSON: ${auth.error}`);
    let authData = auth.data || {};
    if (patch.deepseekKey !== undefined) {
      const key = String(patch.deepseekKey || '').trim();
      if (/[\r\n]/.test(key)) throw new Error('Invalid DeepSeek API key.');
      if (key) authData.deepseek = { ...(authData.deepseek || {}), type: 'api', key };
      else delete authData.deepseek;
    }

    if (patch.dryRun) return { ok: true };
    if (r.exists) fs.copyFileSync(file, `${file}.hub-backup`);
    writeJsonAtomic(file, s);
    if (patch.deepseekKey !== undefined) {
      if (auth.exists) fs.copyFileSync(OPENCODE_AUTH_FILE, `${OPENCODE_AUTH_FILE}.hub-backup`);
      writeJsonAtomic(OPENCODE_AUTH_FILE, authData);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function describeMcp(name, v, scope, where) {
  const type = v.type || (v.url ? 'http' : 'stdio');
  return { name, scope, where, type, target: v.url || [v.command, ...(v.args || [])].filter(Boolean).join(' ') };
}

function claudeCli(args, opts, cb) {
  const claude = findClaude();
  if (!claude && args.some((a) => /[&|<>^%"\r\n]/.test(a))) {
    const msg = 'Refusing to run: claude.exe was not found and the arguments contain special cmd characters (& | < > ^ % ").';
    cb(new Error(msg), '', msg);
    return;
  }
  const file = claude || 'cmd.exe';
  const fileArgs = claude ? args : ['/c', 'claude', ...args];
  execFile(file, fileArgs, { encoding: 'utf8', timeout: 60000, windowsHide: true, ...opts }, cb);
}


ipcMain.handle('mcp:list', (_e, cwd) => {
  const out = [];
  const j = readJsonFile(CLAUDE_JSON);
  if (j.ok) {
    for (const [n, v] of Object.entries(j.data.mcpServers || {})) out.push(describeMcp(n, v, 'user', ''));
    for (const [p, pv] of Object.entries(j.data.projects || {})) {
      for (const [n, v] of Object.entries(pv.mcpServers || {})) out.push(describeMcp(n, v, 'local', p));
    }
  }
  if (cwd && isDir(cwd)) {
    const m = readJsonFile(path.join(cwd, '.mcp.json'));
    if (m.ok) for (const [n, v] of Object.entries(m.data.mcpServers || {})) out.push(describeMcp(n, v, 'project', cwd));
  }
  return out;
});

ipcMain.handle('mcp:check', (_e, cwd) => new Promise((resolve) => {
  claudeCli(['mcp', 'list'], { cwd: cwd && isDir(cwd) ? cwd : HOME }, (err, stdout, stderr) => {
    const text = `${stdout || ''}${stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, '').trim();
    resolve(text || (err ? err.message : 'No output.'));
  });
}));

function tokenize(line) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) { tokens.push(cur); cur = ''; started = false; }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return { tokens, error: 'Unclosed quote in the command.' };
  if (started) tokens.push(cur);
  return { tokens };
}

ipcMain.handle('mcp:add', (_e, o) => new Promise((resolve) => {
  const name = String(o.name || '');
  const scope = ['user', 'local', 'project'].includes(o.scope) ? o.scope : 'user';
  const transport = ['stdio', 'http', 'sse'].includes(o.transport) ? o.transport : 'stdio';
  const target = String(o.target || '').trim();
  if (!MCP_NAME.test(name)) { resolve({ ok: false, error: 'The name may only contain letters, numbers, - _ .' }); return; }
  if (!target) { resolve({ ok: false, error: transport === 'stdio' ? 'Enter the command.' : 'Enter the URL.' }); return; }
  let args;
  if (transport === 'stdio') {
    const envArgs = [];
    for (const pair of o.env || []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(pair)) { resolve({ ok: false, error: `Invalid env: ${pair}` }); return; }
      envArgs.push('-e', pair);
    }
    const parsed = tokenize(target);
    if (parsed.error || !parsed.tokens.length) { resolve({ ok: false, error: parsed.error || 'Enter the command.' }); return; }
    args = ['mcp', 'add', '--scope', scope, name, ...envArgs, '--', ...parsed.tokens];
  } else {
    args = ['mcp', 'add', '--transport', transport, '--scope', scope, name, target];
  }
  claudeCli(args, { cwd: o.cwd && isDir(o.cwd) ? o.cwd : HOME }, (err, stdout, stderr) => {
    resolve(err ? { ok: false, error: `${stderr || err.message}`.trim() } : { ok: true, message: String(stdout).trim() });
  });
}));

ipcMain.handle('mcp:remove', (_e, o) => new Promise((resolve) => {
  const name = String(o.name || '');
  const scope = ['user', 'local', 'project'].includes(o.scope) ? o.scope : 'user';
  if (!MCP_NAME.test(name)) { resolve({ ok: false, error: 'Invalid name.' }); return; }
  claudeCli(['mcp', 'remove', name, '--scope', scope], { cwd: o.cwd && isDir(o.cwd) ? o.cwd : HOME }, (err, stdout, stderr) => {
    resolve(err ? { ok: false, error: `${stderr || err.message}`.trim() } : { ok: true });
  });
}));

ipcMain.handle('settings:get', () => {
  const cfg = readConfig();
  return {
    newProjectsPath: cfg.new_projects_path || defaultNewPath(),
    isDefault: !cfg.new_projects_path,
    scanRoots: (Array.isArray(cfg.scan_roots) ? cfg.scan_roots : []).filter((p) => typeof p === 'string'),
    agent: cfg.agent === 'opencode' || cfg.agent === 'claude' ? cfg.agent : null,
  };
});

ipcMain.handle('settings:set', (_e, newPath, scanRoots, dryRun, agent) => {
  const p = String(newPath || '').trim();
  if (!p || !path.isAbsolute(p)) return { ok: false, error: 'Enter a full path, e.g. C:/Users/.../Projects' };
  if (agent !== undefined && agent !== 'claude' && agent !== 'opencode') return { ok: false, error: 'Invalid agent.' };
  const roots = [];
  for (const raw of Array.isArray(scanRoots) ? scanRoots : []) {
    const r = String(raw || '').trim();
    if (!r) continue;
    if (!path.isAbsolute(r)) return { ok: false, error: `Enter a full path: ${r}` };
    roots.push(path.normalize(r));
  }
  const r = readConfigStrict();
  if (!r.ok) return { ok: false, error: r.error };
  if (dryRun) return { ok: true };
  const cfg = r.cfg;
  cfg.new_projects_path = path.normalize(p);
  if (roots.length) cfg.scan_roots = roots; else delete cfg.scan_roots;
  if (agent) cfg.agent = agent;
  try { writeConfig(cfg); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true };
});

ipcMain.handle('settings:agent', (_e, agent) => {
  if (agent !== 'claude' && agent !== 'opencode') return { ok: false, error: 'Invalid agent.' };
  const r = readConfigStrict();
  if (!r.ok) return { ok: false, error: r.error };
  r.cfg.agent = agent;
  try { writeConfig(r.cfg); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true };
});

ipcMain.handle('dialog:folder', async (e, defaultPath) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

ipcMain.handle('project:destinations', () => {
  const cfg = readConfig();
  const excludeRes = (cfg.exclude || []).map(globToRegex);
  const isExcluded = (n) => excludeRes.some((re) => re.test(String(n).toLowerCase()));
  const out = [];
  const seen = new Set();
  const push = (p, label, force) => {
    const k = normKey(p);
    if (seen.has(k) || (!force && !isDir(p))) return;
    seen.add(k);
    out.push({ path: p, label });
  };
  const base = newProjectsBase();
  push(base, path.basename(base) || base, true);
  for (const r of [base, ...(cfg.scan_roots || []).filter((x) => typeof x === 'string')]) {
    push(r, path.basename(r) || r);
    for (const c of childDirs(r, isExcluded)) {
      if (!dirInfo(c).root && childDirs(c, isExcluded).length) push(c, `${path.basename(r)} / ${path.basename(c)}`);
    }
  }
  return out;
});

ipcMain.handle('project:create', (_e, rawName, baseDir) => {
  const name = String(rawName || '').trim();
  if (!name) return { ok: false, error: 'Enter a name.' };
  if (name.length > 100 || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || RESERVED.test(name)) {
    return { ok: false, error: 'Invalid folder name (not allowed: \\ / : * ? " < > | or a trailing dot/space).' };
  }
  let base = newProjectsBase();
  if (baseDir) {
    if (!path.isAbsolute(String(baseDir)) || !isDir(baseDir)) return { ok: false, error: 'Choose an existing folder.' };
    base = path.normalize(String(baseDir));
  }
  const target = path.join(base, name);
  if (path.relative(base, target).startsWith('..')) return { ok: false, error: 'Invalid name.' };
  if (fs.existsSync(target)) return { ok: false, error: 'A folder with this name already exists.' };
  try { fs.mkdirSync(target, { recursive: true }); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, path: target, name };
});

if (process.argv.includes('--selftest')) {
  const testProfile = path.join(os.tmpdir(), 'agent-hub-selftest');
  if (!process.env.HUB_SELFTEST_RESTORE) { try { fs.rmSync(testProfile, { recursive: true, force: true }); } catch { /* stale profile in use */ } }
  app.setPath('userData', testProfile);
}

app.whenReady().then(() => {
  app.setAppUserModelId('io.github.trigtf.agenthub');
  dragIcon = nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 180), { width: 32, height: 32 });
  createWindow();
});
app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch { /* ignore */ } }
  app.quit();
});
