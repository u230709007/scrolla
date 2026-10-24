/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test harness */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

function load(file, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: name => name in dependencies ? dependencies[name] : require(name), console, ...globals });
  return exports;
}

// arrays built inside the vm context aren't deepEqual to this realm's arrays
const ids = videos => Array.from(videos, v => v.id);
const ago = min => new Date(Date.now() - min * 60_000).toISOString();

function setup(dexPairs, poolTrades = {}) {
  const worker = new DatabaseSync(':memory:');
  worker.exec(`CREATE TABLE videos (id TEXT PRIMARY KEY, created_at TEXT, video_path TEXT, thumbnail TEXT, duration REAL,
    token_symbol TEXT, token_name TEXT, chain TEXT, pair_address TEXT, price_usd REAL, change_24h REAL, volume_24h REAL,
    market_cap REAL, narration TEXT, hook TEXT, token_json TEXT, format TEXT, persona TEXT)`);
  const app = new DatabaseSync(':memory:');
  app.exec(`CREATE TABLE uploads (id TEXT PRIMARY KEY, address TEXT, created_at TEXT, video_json TEXT);
    CREATE TABLE likes (video_id TEXT, address TEXT);
    CREATE TABLE comments (video_id TEXT);
    CREATE TABLE trades (video_id TEXT, address TEXT, token_symbol TEXT, token_address TEXT, created_at TEXT)`);
  const addVideo = (id, minAgo, symbol, chain, address, pool = null) => worker
    .prepare(`INSERT INTO videos (id, created_at, video_path, thumbnail, duration, token_symbol, token_name, chain, pair_address, token_json, format)
      VALUES (?, ?, 'videos/x.mp4', 'thumbs/x.jpg', 15, ?, ?, ?, ?, ?, 'classic')`)
    .run(id, ago(minAgo), symbol, symbol, chain, pool, JSON.stringify({ token_address: address }));
  const addTrade = (videoId, symbol, address, minAgo) => app
    .prepare('INSERT INTO trades VALUES (?, ?, ?, ?, ?)').run(videoId, '0xviewer', symbol, address, ago(minAgo));

  const fetched = [];
  const fetch = async url => {
    fetched.push(url);
    const gt = url.match(/geckoterminal\.com\/api\/v2\/networks\/([^/]+)\/pools\/([^/]+)\/trades/);
    if (gt) {
      const data = poolTrades[`${gt[1]}/${gt[2]}`];
      return data ? { ok: true, status: 200, json: async () => ({ data }) } : { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => dexPairs };
  };
  const activity = load('src/lib/server/activity.ts', { 'server-only': {}, './db': { appDb: async () => asDb(app) } }, { fetch, AbortSignal });
  const feed = load('src/lib/server/feed.ts', { 'server-only': {}, './config': { MEDIA_BASE_URL: '' }, './db': { appDb: async () => asDb(app), workerDb: () => asDb(worker) }, './activity': activity });
  return { feed, addVideo, addTrade, fetched };
}

test('first page puts the most recently traded tokens on top, one video per token', async () => {
  const { feed, addVideo, addTrade, fetched } = setup([
    { baseToken: { address: '0xMOE' }, txns: { m5: { buys: 4, sells: 2 }, h1: { buys: 30, sells: 20 } } },
    { baseToken: { address: '0xEMO' }, txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 3, sells: 1 } } },
  ]);
  addVideo('newest-quiet', 1, 'QUIET', 'monad', '0xQUIET');
  addVideo('moe-old', 50, 'MOE', 'monad', '0xMOE');
  addVideo('moe-new', 10, 'MOE', 'monad', '0xMOE');
  addVideo('emo', 20, 'EMO', 'monad', '0xEMO');
  addVideo('chog-testnet', 40, 'CHOG', 'monad-testnet', '0xCHOG');
  addVideo('stale-trade', 30, 'OLD', 'monad-testnet', '0xOLD');
  addTrade('chog-testnet', 'CHOG', '0xchog', 2); // in-app buy 2 min ago beats any market signal
  addTrade('stale-trade', 'OLD', '0xOLD', 120); // outside the live window

  const page = await feed.listLiveFeed({ limit: 4 });
  assert.deepEqual(ids(page.videos), ['chog-testnet', 'moe-new', 'emo', 'newest-quiet']);
  assert.equal(page.videos[0].live.appTrades1h, 1);
  assert.equal(page.videos[1].live.txns5m, 6);
  assert.equal(page.videos[1].live.txns1h, 50);
  // testnet tokens never hit DexScreener
  assert.equal(fetched.length, 1);
  assert.ok(!fetched[0].includes('monad-testnet') && !fetched[0].includes('0xCHOG'));

  // the rest continues chronologically after the last filler video
  const next = await feed.listVideos({ limit: 10, cursor: page.nextCursor });
  assert.deepEqual(ids(next.videos), ['moe-new', 'emo', 'stale-trade', 'chog-testnet', 'moe-old']);
});

test('a live section that fills the whole page hands out the chronological start cursor', async () => {
  const { feed, addVideo } = setup([
    { baseToken: { address: '0xA' }, txns: { m5: { buys: 9 }, h1: { buys: 9 } } },
    { baseToken: { address: '0xB' }, txns: { m5: { buys: 1 }, h1: { buys: 1 } } },
  ]);
  addVideo('a', 5, 'A', 'monad', '0xA');
  addVideo('b', 1, 'B', 'monad', '0xB');
  const page = await feed.listLiveFeed({ limit: 2 });
  assert.deepEqual(ids(page.videos), ['a', 'b']);
  assert.equal(page.nextCursor, feed.CHRONO_START);
  assert.deepEqual(ids((await feed.listVideos({ limit: 5, cursor: page.nextCursor })).videos), ['b', 'a']);
});

test('without any trading the feed is plain newest-first', async () => {
  const { feed, addVideo } = setup([]);
  addVideo('old', 10, 'X', 'monad', null);
  addVideo('new', 1, 'Y', 'monad', null);
  const page = await feed.listLiveFeed({ limit: 5 });
  assert.deepEqual(ids(page.videos), ['new', 'old']);
  assert.equal(page.nextCursor, null);
});

test('GeckoTerminal trade times rank busy market tokens by their freshest on-chain trade', async () => {
  const trade = (minAgo, kind, usd, extra = {}) => ({ attributes: { block_timestamp: ago(minAgo).replace(/\.\d+Z$/, 'Z'), kind, volume_in_usd: String(usd), is_anomalous: false, ...extra } });
  const { feed, addVideo, fetched } = setup(
    [
      { baseToken: { address: '0xBUSY' }, txns: { m5: { buys: 9 }, h1: { buys: 40 } } },
      { baseToken: { address: '0xFRESH' }, txns: { m5: { buys: 1 }, h1: { buys: 5 } } },
      { baseToken: { address: '0xSTALE' }, txns: { m5: { buys: 0 }, h1: { buys: 2 } } },
      { baseToken: { address: '0xNOPOOL' }, txns: { m5: { buys: 0 }, h1: { buys: 1 } } },
    ],
    {
      'eth/0xpoolbusy': [trade(4, 'buy', 20), trade(6, 'buy', 900, { is_anomalous: true })],
      'eth/0xpoolfresh': [trade(1, 'sell', 5), trade(3, 'buy', 120), trade(30, 'buy', 5000)],
      'eth/0xpoolstale': [trade(90, 'buy', 10)],
    },
  );
  addVideo('busy', 3, 'BUSY', 'ethereum', '0xBUSY', '0xpoolbusy');
  addVideo('fresh', 2, 'FRESH', 'ethereum', '0xFRESH', '0xpoolfresh');
  addVideo('stale', 1, 'STALE', 'ethereum', '0xSTALE', '0xpoolstale');
  addVideo('nopool', 4, 'NOPOOL', 'ethereum', '0xNOPOOL');

  const page = await feed.listLiveFeed({ limit: 4 });
  assert.deepEqual(ids(page.videos), ['fresh', 'busy', 'stale', 'nopool']);
  const [fresh, busy, stale] = page.videos.map(v => v.live);
  assert.ok(fresh.lastMarketTradeAt > busy.lastMarketTradeAt);
  assert.equal(fresh.largestBuyUsd15m, 120); // the $5000 buy is older than 15 min
  assert.equal(busy.largestBuyUsd15m, 20); // anomalous trades are ignored
  assert.equal(stale.lastMarketTradeAt, null); // outside the live window
  // chain ids are mapped to GeckoTerminal network ids, tokens without a pool aren't queried
  assert.equal(fetched.filter(u => u.includes('/networks/eth/pools/')).length, 3);
});
