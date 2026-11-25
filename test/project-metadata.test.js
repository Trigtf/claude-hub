const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-meta-test-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;
process.env.HUB_CONFIG = path.join(tmpHome, 'hub-config.json');
process.env.HUB_OPENCODE_DB = path.join(tmpHome, '.local', 'share', 'opencode', 'opencode.db');

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

const projectsDir = path.join(tmpHome, 'projects');
const alphaDir = path.join(projectsDir, 'alpha');
const monorepoDir = path.join(projectsDir, 'monorepo');
const nestedDir = path.join(monorepoDir, 'packages', 'app');
const opencodeDir = path.join(projectsDir, 'oc-only');

function writeFile(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function setupWorld() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  writeFile(path.join(alphaDir, 'package.json'), '{}');
  writeFile(path.join(alphaDir, 'AGENTS.md'), '# agents');

  writeFile(path.join(monorepoDir, 'package.json'), '{}');
  writeFile(path.join(nestedDir, 'package.json'), '{}');

  fs.mkdirSync(opencodeDir, { recursive: true });

  writeFile(
    path.join(tmpHome, '.claude', 'projects', 'sess1', 'chat.jsonl'),
    `${JSON.stringify({ type: 'summary', cwd: nestedDir })}\n`,
  );

  fs.writeFileSync(process.env.HUB_CONFIG, JSON.stringify({
    new_projects_path: projectsDir,
  }, null, 2), 'utf8');
}

function writeOpencodeDb() {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(process.env.HUB_OPENCODE_DB), { recursive: true });
  const db = new DatabaseSync(process.env.HUB_OPENCODE_DB);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER)');
  db.prepare('INSERT INTO session (id, directory, time_updated) VALUES (?, ?, ?)').run('s1', opencodeDir, Date.now());
  db.close();
}

function list() {
  return handlers.get('projects:list')().projects;
}

before(setupWorld);

beforeEach(() => {
  setupWorld();
  writeOpencodeDb();
});

after(() => {
  Module._load = originalLoad;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('marks marker folders as project roots', () => {
  const byName = Object.fromEntries(list().map((p) => [p.name, p]));
  assert.equal(byName.alpha.root, true);
  assert.equal(byName.alpha.nested, false);
  assert.equal(byName.monorepo.root, true);
});

test('detects AI config files without claiming an AI session', () => {
  const byName = Object.fromEntries(list().map((p) => [p.name, p]));
  assert.equal(byName.alpha.aiConfig, true);
  assert.equal(byName.alpha.ai, false);
  assert.deepEqual(byName.alpha.agents, []);
});

test('marks a Claude session cwd as an AI project', () => {
  const app = list().find((p) => p.path === nestedDir);
  assert.ok(app);
  assert.equal(app.ai, true);
  assert.deepEqual(app.agents, ['claude']);
  assert.ok(app.last_session > 0);
});

test('marks a session cwd inside another listed project as nested', () => {
  const app = list().find((p) => p.path === nestedDir);
  assert.equal(app.root, false);
  assert.equal(app.nested, true);
});

test('indexes opencode sessions from the SQLite database', () => {
  const oc = list().find((p) => p.path === opencodeDir);
  assert.ok(oc);
  assert.equal(oc.ai, true);
  assert.ok(oc.agents.includes('opencode'));
  assert.ok(oc.last_session > 0);
});

test('a missing opencode database does not break the list', () => {
  fs.rmSync(process.env.HUB_OPENCODE_DB, { force: true });
  const items = list();
  assert.equal(items.length >= 3, true);
});
