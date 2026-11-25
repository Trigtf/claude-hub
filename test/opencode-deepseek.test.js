const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-'));
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
  shell: {},
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

const configDir = path.join(tmpHome, '.config', 'opencode');
const configFile = path.join(configDir, 'opencode.json');
const authFile = path.join(tmpHome, '.local', 'share', 'opencode', 'auth.json');

const get = () => handlers.get('opencode:get')();
const set = (patch) => handlers.get('opencode:set')({}, patch);

function reset() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(tmpHome, { recursive: true });
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

beforeEach(reset);

after(() => {
  Module._load = originalLoad;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('get works when no opencode config or auth exists', () => {
  const st = get();
  assert.equal(st.error, undefined);
  assert.equal(st.deepseekKey, '');
  assert.equal(st.permMode, 'default');
});

test('set stores the DeepSeek key without touching other providers', () => {
  writeJson(configFile, { model: 'deepseek/deepseek-v4-flash', permission: 'allow' });
  writeJson(authFile, { openai: { type: 'api', key: 'sk-openai' } });

  const res = set({ model: 'deepseek/deepseek-v4-flash', permMode: 'allow', deepseekKey: 'sk-deepseek-test' });
  assert.deepEqual(res, { ok: true });

  assert.deepEqual(readJson(authFile), {
    openai: { type: 'api', key: 'sk-openai' },
    deepseek: { type: 'api', key: 'sk-deepseek-test' },
  });
  assert.equal(readJson(configFile).model, 'deepseek/deepseek-v4-flash');
});

test('get returns the saved DeepSeek key', () => {
  writeJson(authFile, { deepseek: { type: 'api', key: 'sk-deepseek-test' } });
  assert.equal(get().deepseekKey, 'sk-deepseek-test');
});

test('an empty key disconnects DeepSeek but keeps other providers', () => {
  writeJson(authFile, {
    openai: { type: 'api', key: 'sk-openai' },
    deepseek: { type: 'api', key: 'sk-deepseek-test' },
  });

  assert.deepEqual(set({ model: '', permMode: 'default', deepseekKey: '' }), { ok: true });
  assert.deepEqual(readJson(authFile), { openai: { type: 'api', key: 'sk-openai' } });
});

test('dryRun validates without writing anything', () => {
  writeJson(authFile, { deepseek: { type: 'api', key: 'sk-old' } });

  assert.deepEqual(set({ model: '', permMode: 'default', deepseekKey: 'sk-new', dryRun: true }), { ok: true });
  assert.equal(readJson(authFile).deepseek.key, 'sk-old');
});

test('a key with a newline is rejected', () => {
  const res = set({ model: '', permMode: 'default', deepseekKey: 'sk-bad\nkey' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Invalid DeepSeek API key/);
  assert.equal(fs.existsSync(authFile), false);
});

test('invalid auth JSON is reported and never overwritten', () => {
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, '{ bad', 'utf8');

  const st = get();
  assert.match(st.error, /opencode auth is not valid JSON/);

  const res = set({ model: '', permMode: 'default', deepseekKey: 'sk-new' });
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(authFile, 'utf8'), '{ bad');
});

test('omitting deepseekKey leaves the stored key alone', () => {
  writeJson(authFile, { deepseek: { type: 'api', key: 'sk-keep' } });
  assert.deepEqual(set({ model: 'deepseek/deepseek-v4-pro', permMode: 'allow' }), { ok: true });
  assert.equal(readJson(authFile).deepseek.key, 'sk-keep');
});

test('saves create backups of the config and auth files', () => {
  writeJson(configFile, { model: 'deepseek/deepseek-v4-flash' });
  writeJson(authFile, { deepseek: { type: 'api', key: 'sk-old' } });

  set({ model: 'deepseek/deepseek-v4-flash', permMode: 'default', deepseekKey: 'sk-new' });
  assert.equal(fs.existsSync(`${configFile}.hub-backup`), true);
  assert.equal(fs.existsSync(`${authFile}.hub-backup`), true);
});
