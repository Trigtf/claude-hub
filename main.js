const { app, BrowserWindow, ipcMain, clipboard, shell, Menu, dialog, nativeImage } = require('electron');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('@lydell/node-pty');

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

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 500,
    backgroundColor: '#14161a',
    title: 'Claude Hub',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
  // The window only ever shows index.html: block navigation (e.g. a file dropped outside the drop zone)
  // and new windows, so the UI can never be replaced by other content.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
    await js('refreshMcp()');
    await wait(300);
    report.mcpRows = await js(`document.querySelectorAll('#mcp-list .mcprow').length`);
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
    report.fix4_dry = await js(`window.hub.setSettings('C:/some/where', true)`);
    report.fix4_untouched = fs.readFileSync(CONFIG_FILE, 'utf8') === '{ bad';
    fs.writeFileSync(CONFIG_FILE, cfgBefore);
    report.fix4_pinOk = await js(`window.hub.pinProject('C:/x', 'x', true)`);
    report.fix4_noTmpLeft = !fs.existsSync(`${CONFIG_FILE}.hub-tmp`);

    report.fix5_enterWired = await js(`(() => { const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); document.querySelector('#mcp-name').dispatchEvent(ev); return ev.defaultPrevented; })()`);
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
    await click('claude-hub');
    await wait(8000);
    report.firstTerminal = await dump('claude-hub');
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
      const hub = [...sessions.values()].find((s) => s.project.name.startsWith('claude-hub'));
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

function sessionIndex() {
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

function isProjectDir(dir) {
  try {
    return fs.readdirSync(dir).some((n) => { const l = n.toLowerCase(); return MARKER_FILES.has(l) || MARKER_SUFFIXES.some((s) => l.endsWith(s)); });
  } catch { return false; }
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
      if (isProjectDir(full)) found.push(full);
      else if (level < depth) walk(full, level + 1);
    }
  };
  for (const r of roots) { if (isDir(r)) walk(r, 1); }
  return found;
}

function buildProjects() {
  const cfg = readConfig();
  const sessions = sessionIndex();
  const excludeRes = (cfg.exclude || []).map(globToRegex);
  const isExcluded = (name) => excludeRes.some((re) => re.test(String(name).toLowerCase()));
  const found = new Map();

  const add = (p, name, pinned = false) => {
    if (!isDir(p)) return;
    const key = normKey(p);
    if (found.has(key)) {
      if (pinned) { const it = found.get(key); it.pinned = true; it.name = name; }
      return;
    }
    const sess = sessions.get(key);
    let folderMtime = 0;
    try { folderMtime = fs.statSync(p).mtimeMs / 1000; } catch { /* keep 0 */ }
    found.set(key, { name, path: String(p), pinned, last_session: sess ? sess[1] : null, activity: sess ? sess[1] : folderMtime });
  };

  for (const item of cfg.pinned || []) add(item.path, item.name || path.basename(item.path), true);

  const scanRoots = [...(cfg.scan_roots || [])];
  if (cfg.new_projects_path) scanRoots.push(cfg.new_projects_path);
  for (const root of scanRoots) {
    let kids = [];
    try { kids = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const k of kids) { if (k.isDirectory() && !isExcluded(k.name)) add(path.join(root, k.name), k.name); }
  }

  for (const p of autoScan(cfg, excludeRes)) add(p, path.basename(p));

  for (const [key, [cwd]] of sessions) {
    if (isExcluded(path.basename(cwd))) continue;
    add(cwd, key === normKey(HOME) ? 'Home' : path.basename(cwd));
  }

  const order = new Map((cfg.order || []).map((p, i) => [normKey(p), i]));
  const rank = (x) => (order.has(normKey(x.path)) ? order.get(normKey(x.path)) : order.size);
  return [...found.values()].sort((a, b) => (Number(!a.pinned) - Number(!b.pinned)) || (rank(a) - rank(b)) || (b.activity - a.activity));
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
  'Reset order (recent first)': 'Επαναφορά σειράς (πρόσφατα πρώτα)',
  'No previous session - starting a new one': 'Δεν υπάρχει προηγούμενη συνεδρία - ξεκινάει νέα',
};
const tr = (lang, en) => (lang === 'el' && EL_MAIN[en]) || en;

function spawnPty(id, kind, cwd, resume, cols, rows, lang) {
  const claude = findClaude();
  const args = resume ? ['--continue'] : [];
  let file = claude || 'cmd.exe';
  let fileArgs = claude ? args : ['/c', 'claude', ...args];
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
    env: { ...process.env, ...(kind === 'auth' ? readHubSettings().gcloudEnv : {}), COLORTERM: 'truecolor', TERM: 'xterm-256color' },
  });
  ptys.set(id, p);
  if (kind !== 'auth') startWatch(id, cwd);
  let tail = '';
  p.onData((d) => {
    tail = (tail + d).slice(-2000);
    if (win) win.webContents.send('pty:data', id, d);
  });
  p.onExit((e) => {
    const current = ptys.get(id) === p;
    const noConversation = /No conversation found/i.test(tail);
    if (current && kind !== 'auth' && resume && e.exitCode !== 0 && (noConversation || Date.now() - startedAt < 5000)) {
      ptys.delete(id);
      if (win) win.webContents.send('pty:data', id, `\r\n\x1b[33m[${tr(lang, 'No previous session - starting a new one')}]\x1b[0m\r\n`);
      try { spawnPty(id, kind, cwd, false, p.cols, p.rows, lang); return; } catch { /* report the exit below */ }
    }
    if (current) { ptys.delete(id); stopWatch(id); }
    if (win) win.webContents.send('pty:exit', id, e.exitCode);
  });
}

function onPath(cmd) {
  try { execFileSync('where', [cmd], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; }
}

ipcMain.handle('pty:spawn', (_e, { id, kind, cwd, resume, cols, rows, lang }) => {
  if (ptys.has(id)) return { ok: true };
  if (kind === 'auth' && !process.env.HUB_AUTH_DRYRUN && !onPath('gcloud')) {
    return { ok: false, error: 'Google Cloud CLI (gcloud) was not found. The Auth button is only needed if you use Claude through Google Vertex AI. If you use a Claude subscription or an API key, run "claude" and log in there instead. Otherwise install gcloud: https://cloud.google.com/sdk/docs/install' };
  }
  if (kind !== 'auth' && !findClaude() && !onPath('claude')) {
    return { ok: false, error: 'Claude Code was not found on this computer. Install it from https://claude.com/claude-code (or run: npm install -g @anthropic-ai/claude-code), then reopen this tab. If you have just installed it, restart Claude Hub so it picks up the new PATH.' };
  }
  try {
    spawnPty(id, kind, cwd, resume, cols, rows, lang);
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
  if (p) { ptys.delete(id); try { p.kill(); } catch { /* already gone */ } }
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
  Menu.buildFromTemplate([
    { label: tr(lang, pinned ? 'Unpin' : 'Pin to top'), click: act('pin') },
    { type: 'separator' },
    { label: tr(lang, 'Open folder'), enabled: isDir, click: () => shell.openPath(p) },
    { label: tr(lang, 'Copy path'), click: () => clipboard.writeText(p) },
    { type: 'separator' },
    { label: tr(lang, 'Reset order (recent first)'), click: act('resetOrder') },
  ]).popup({ window: BrowserWindow.fromWebContents(e.sender) });
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
  return { newProjectsPath: cfg.new_projects_path || defaultNewPath(), isDefault: !cfg.new_projects_path };
});

ipcMain.handle('settings:set', (_e, newPath, dryRun) => {
  const p = String(newPath || '').trim();
  if (!p || !path.isAbsolute(p)) return { ok: false, error: 'Enter a full path, e.g. C:/Users/.../Projects' };
  const r = readConfigStrict();
  if (!r.ok) return { ok: false, error: r.error };
  if (dryRun) return { ok: true };
  const cfg = r.cfg;
  cfg.new_projects_path = path.normalize(p);
  try { writeConfig(cfg); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true };
});

ipcMain.handle('dialog:folder', async (e, defaultPath) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

ipcMain.handle('project:create', (_e, rawName) => {
  const name = String(rawName || '').trim();
  if (!name) return { ok: false, error: 'Enter a name.' };
  if (name.length > 100 || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || RESERVED.test(name)) {
    return { ok: false, error: 'Invalid folder name (not allowed: \\ / : * ? " < > | or a trailing dot/space).' };
  }
  const base = newProjectsBase();
  const target = path.join(base, name);
  if (path.relative(base, target).startsWith('..')) return { ok: false, error: 'Invalid name.' };
  if (fs.existsSync(target)) return { ok: false, error: 'A folder with this name already exists.' };
  try { fs.mkdirSync(target, { recursive: true }); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, path: target, name };
});

if (process.argv.includes('--selftest')) {
  const testProfile = path.join(os.tmpdir(), 'claude-hub-selftest');
  if (!process.env.HUB_SELFTEST_RESTORE) { try { fs.rmSync(testProfile, { recursive: true, force: true }); } catch { /* stale profile in use */ } }
  app.setPath('userData', testProfile);
}

app.whenReady().then(() => {
  dragIcon = nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 180), { width: 32, height: 32 });
  createWindow();
});
app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch { /* ignore */ } }
  app.quit();
});
