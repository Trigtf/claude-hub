const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-rename-test-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const handlers = new Map();

const electron = {
  app: {
    whenReady: () => new Promise(() => {}),
    on: () => {},
    setPath: () => {},
    getPath: () => tmpHome,
    quit: () => {},
  },
  BrowserWindow: class {
    static fromWebContents() { return null; }
    constructor() {}
  },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
  clipboard: { readText: () => '', writeText: () => {} },
  shell: { openPath: () => {}, trashItem: () => {} },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  dialog: {},
  nativeImage: { createFromBitmap: () => ({}) },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electron;
  if (request === '@lydell/node-pty') return { spawn: () => { throw new Error('pty is not available in tests'); } };
  return originalLoad.call(this, request, ...rest);
};

require(path.join(__dirname, '..', 'main.js'));

const configFile = path.join(tmpHome, '.claude', 'project-launcher', 'config.json');
const projectsDir = path.join(tmpHome, 'projects');
const oldPath = path.join(projectsDir, 'old-project');

const rename = (projectPath, name, lang = 'en') => handlers.get('projects:rename')({}, projectPath, name, lang);

function reset() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(oldPath, { recursive: true });
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    new_projects_path: projectsDir,
    pinned: [{ name: 'old-project', path: oldPath }],
    order: [oldPath],
  }, null, 2), 'utf8');
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configFile, 'utf8'));
}

beforeEach(reset);

after(() => {
  Module._load = originalLoad;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('renames the folder and updates pinned/order references', () => {
  const res = rename(oldPath, 'new-project');

  assert.equal(res.ok, true);
  assert.equal(res.name, 'new-project');
  const newPath = path.join(projectsDir, 'new-project');
  assert.equal(res.path, newPath);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(newPath), true);
  const cfg = readConfig();
  assert.deepEqual(cfg.pinned, [{ name: 'new-project', path: newPath }]);
  assert.deepEqual(cfg.order, [newPath]);
});

test('rejects an invalid folder name', () => {
  const res = rename(oldPath, 'bad/name');
  assert.equal(res.ok, false);
  assert.match(res.error, /Invalid folder name/);
  assert.equal(fs.existsSync(oldPath), true);
});

test('rejects an empty name', () => {
  const res = rename(oldPath, '   ');
  assert.equal(res.ok, false);
  assert.match(res.error, /Enter a name/);
  assert.equal(fs.existsSync(oldPath), true);
});

test('refuses to overwrite an existing folder', () => {
  fs.mkdirSync(path.join(projectsDir, 'taken'), { recursive: true });
  const res = rename(oldPath, 'taken');
  assert.equal(res.ok, false);
  assert.match(res.error, /already exists/);
  assert.equal(fs.existsSync(oldPath), true);
});

test('renaming to the same name is a no-op', () => {
  const res = rename(oldPath, 'old-project');
  assert.deepEqual(res, { ok: true, path: oldPath, name: 'old-project' });
  assert.equal(fs.existsSync(oldPath), true);
});

test('rejects a project that is not in the list', () => {
  const stray = path.join(tmpHome, 'stray');
  fs.mkdirSync(stray, { recursive: true });
  const res = rename(stray, 'renamed-stray');
  assert.equal(res.ok, false);
  assert.match(res.error, /not in the list/);
  assert.equal(fs.existsSync(stray), true);
});
