/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DatabaseSync } = require('node:sqlite');

// The app's Db facade is async (libSQL); wrap node:sqlite for the tests.
const asDb = d => ({
  all: async (sql, ...args) => d.prepare(sql).all(...args),
  get: async (sql, ...args) => d.prepare(sql).get(...args),
  run: async (sql, ...args) => { d.prepare(sql).run(...args); },
});

function load(file, dependencies) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: name => name in dependencies ? dependencies[name] : require(name), URL, Request, Response, File, Buffer, Uint8Array, console, decodeURIComponent, encodeURIComponent });
  return exports;
}

test('uploads enforce auth, origin and file validation, persist ownership, and paginate without a worker', async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'alphascroll-upload-test-'));
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE uploads (id TEXT PRIMARY KEY, address TEXT, created_at TEXT, video_json TEXT);
    CREATE TABLE likes (video_id TEXT, address TEXT);
    CREATE TABLE comments (video_id TEXT);
    CREATE TABLE trades (video_id TEXT);`);
  let address = null;
  const feed = load('src/lib/server/feed.ts', { 'server-only': {}, './config': { MEDIA_BASE_URL: '' }, './db': { appDb: async () => asDb(db), workerDb: () => null }, './activity': {} });
  const route = load('src/app/api/uploads/route.ts', {
    '@/auth': { currentAddress: async () => address },
    '@/lib/server/db': { appDb: async () => asDb(db) },
    '@/lib/server/config': { WORKER_OUTPUT_DIR: output, DIRECT_UPLOADS: null, BLOB_TOKEN: '' },
    '@vercel/blob': {},
    '@/lib/server/feed': feed,
    '@/lib/server/r2': {},
  });
  function request(bytes = Buffer.from([0,0,0,20,...Buffer.from('ftypisom'),0,0,0,0]), caption = 'Test video', origin = 'http://localhost:3000') {
    const form = new FormData();
    form.set('video', new File([bytes], 'test.mp4', { type: 'video/mp4' }));
    form.set('caption', caption);
    return new Request('http://localhost:3000/api/uploads', { method: 'POST', headers: { origin }, body: form });
  }
  try {
    assert.equal((await route.POST(request())).status, 401);
    // without Blob/R2 the presign step answers 404 so the client falls back to multipart
    address = 'test-account-a';
    assert.equal((await route.POST(new Request('http://localhost:3000/api/uploads', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'presign', size: 10, type: 'video/mp4' }) }))).status, 404);
    address = 'test-account-a';
    assert.equal((await route.POST(request(undefined, '', 'https://other.example'))).status, 403);
    assert.equal((await route.POST(request(Buffer.from('not an mp4')))).status, 400);
    assert.equal((await route.POST(request(undefined, 'x'.repeat(301)))).status, 400);
    assert.equal((await route.POST(new Request('http://localhost:3000/api/uploads', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-length': String(60 * 1024 * 1024) }, body: 'x' }))).status, 413);
    const created = await route.POST(request());
    assert.equal(created.status, 201);
    const { video } = await created.json();
    assert.equal(video.creator, address);
    assert.equal(video.source, 'upload');
    assert.ok(fs.existsSync(path.join(output, 'videos', `${video.id}.mp4`)));
    assert.equal((await (await route.GET()).json()).videos.length, 1);
    address = 'test-account-b';
    assert.equal((await (await route.GET()).json()).videos.length, 0);
    assert.equal((await route.POST(request())).status, 201);
    const first = await feed.listVideos({ limit: 1 });
    assert.equal(first.videos.length, 1);
    assert.ok(first.nextCursor);
    const second = await feed.listVideos({ limit: 1, cursor: first.nextCursor });
    assert.equal(second.videos.length, 1);
    assert.notEqual(second.videos[0].id, first.videos[0].id);
    assert.equal(second.nextCursor, null);
    assert.equal(await feed.videoExists(video.id), true);
    assert.equal(await feed.getVideoToken(video.id), null);
  } finally {
    db.close();
    const videos = path.join(output, 'videos');
    if (fs.existsSync(videos)) { for (const file of fs.readdirSync(videos)) fs.unlinkSync(path.join(videos, file)); fs.rmdirSync(videos); }
    fs.rmdirSync(output);
  }
});
