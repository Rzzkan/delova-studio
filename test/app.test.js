import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const models = JSON.parse(readFileSync(new URL('./fixtures/models.json', import.meta.url), 'utf8'));
let mock, base, app, appBase, calls = [], failNext = false;

before(async () => {
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/models') return res.end(JSON.stringify(models));
      calls.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') });
      if (failNext) { failNext = false; return res.end('   ' + JSON.stringify({ error: { message: 'provider gagal', code: 'upstream_error' } })); }
      let n = 1;
      if (req.url.endsWith('/generations')) n = JSON.parse(Buffer.concat(chunks).toString()).n || 1;
      res.end('  ' + JSON.stringify({ data: Array.from({ length: n }, () => ({ b64_json: PNG.toString('base64') })) }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${mock.address().port}/v1`;
  process.env.KENARI_BASE_URL = base;
  process.env.KENARI_API_KEY = 'kn-test';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tss-'));
  process.env.ACCESS_TOKEN = 'rahasia';
  process.env.MCP_PATH_SECRET = 'rahasia-konektor-0123456789abcdef';
  process.env.ADMIN_USER = 'bos';
  process.env.ADMIN_PASSWORD = 'sandi-panjang-123';
  process.env.PUBLIC_URL = 'https://studio.example.test';
  process.env.RETENTION_DAYS = '7';
  process.env.DAILY_BUDGET_IDR = '2000';
  process.env.APPROVAL_THRESHOLD_IDR = '1000';
  const { createApp } = await import('../src/server.js');
  const store = await import('../src/store.js');
  await store.init();
  app = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  appBase = `http://127.0.0.1:${app.address().port}`;
});
after(() => { mock.closeAllConnections(); mock.close(); app.closeAllConnections(); app.close(); });

const H = { Authorization: 'Bearer rahasia', 'Content-Type': 'application/json' };
const post = (p, b) => fetch(appBase + p, { method: 'POST', headers: H, body: JSON.stringify(b) });

test('API menolak tanpa token', async () => {
  assert.equal((await fetch(appBase + '/api/config')).status, 401);
  assert.equal((await fetch(appBase + '/mcp', { method: 'POST' })).status, 401);
});

test('daftar model dan harga dibaca dari kenari', async () => {
  const m = await (await fetch(appBase + '/api/models', { headers: H })).json();
  assert.equal(m.find((x) => x.id === 'gpt-image-2').pricePerImageIdr, 125);
  assert.equal(m.find((x) => x.id.endsWith(':free')).pricePerImageIdr, 0);
});

test('generate menyimpan file bernama sesuai aturan kantor dan mengirim bearer key', async () => {
  const r = await post('/api/generate', { prompt: 'kucing seller', n: 2, title: 'Kucing Seller', useStyle: false });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.images.length, 2);
  assert.match(body.images[0].file, /^\d{4}-\d{2}-\d{2}_Kenzo_Kucing-Seller_v1_01\.png$/);
  assert.equal(body.costIdr, 250);
  assert.equal(calls.at(-1).auth, 'Bearer kn-test');
  const again = await (await post('/api/generate', { prompt: 'x kucing', title: 'Kucing Seller', useStyle: false })).json();
  assert.match(again.images[0].file, /_v2_01\.png$/);
  const f = await fetch(`${appBase}/files/${body.images[0].file}?token=rahasia`);
  assert.equal(f.status, 200);
  assert.equal((await f.arrayBuffer()).byteLength, PNG.length);
});

test('biaya di atas ambang butuh approved=true', async () => {
  const r = await post('/api/generate', { prompt: 'mahal', model: 'grok-imagine-image-2-0', n: 1 });
  assert.equal(r.status, 200); // Rp900 <= ambang 1000
  const before = calls.length;
  const r2 = await post('/api/generate', { prompt: 'mahal', model: 'grok-imagine-image-2-0', n: 2 });
  assert.equal(r2.status, 402);
  assert.equal(calls.length, before, 'tidak boleh memanggil kenari tanpa persetujuan');
});

test('batas budget harian tidak bisa dilewati walau approved', async () => {
  const r = await post('/api/generate', { prompt: 'banyak', model: 'grok-imagine-image-2-0', n: 3, approved: true });
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /budget harian/i);
});

test('error status-200 dari kenari tidak dihitung biaya', async () => {
  const spent = async () => (await (await fetch(appBase + '/api/config', { headers: H })).json()).spentTodayIdr;
  const s0 = await spent();
  failNext = true;
  const r = await post('/api/generate', { prompt: 'gagal', n: 1 });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /provider gagal/);
  assert.equal(await spent(), s0);
});

test('edit mengirim multipart ke /images/edits', async () => {
  const r = await post('/api/edit', { prompt: 'ubah latar', imageBase64: PNG.toString('base64'), title: 'Edit Tes' });
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1).url, '/v1/images/edits');
  assert.match(calls.at(-1).body, /name="image"/);
});

test('MCP: tools terdaftar dan generate_image jalan', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['generate_image', 'edit_image', 'list_image_models', 'estimate_cost', 'list_gallery', 'get_image']) assert.ok(names.includes(n), n);
  const out = await client.callTool({ name: 'generate_image', arguments: { prompt: 'poster promo', title: 'Poster MCP', model: 'gpt-image-2' } });
  assert.ok(!out.isError, JSON.stringify(out));
  assert.equal(out.content.filter((c) => c.type === 'image').length, 1);
  const blocked = await client.callTool({ name: 'generate_image', arguments: { prompt: 'poster mahal', model: 'grok-imagine-image-2-0', n: 2 } });
  assert.equal(blocked.isError, true);
  await client.close();
});

test('path traversal pada /files ditolak', async () => {
  const r = await fetch(`${appBase}/files/..%2F..%2Fpackage.json?token=rahasia`);
  assert.equal(r.status, 404);
});

test('MCP: URL publik bertanda tangan bisa diambil, dirusak/kedaluwarsa ditolak', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  const gal = (await (await fetch(appBase + '/api/gallery', { headers: H })).json())[0];
  assert.ok(gal.expiresAt, 'entri punya expiresAt');
  const out = await client.callTool({ name: 'get_image_public_url', arguments: { id: gal.id, ttl_minutes: 5 } });
  assert.ok(!out.isError, JSON.stringify(out));
  const url = out.content[0].text.match(/source_url: (\S+)/)[1];
  assert.ok(url.startsWith('https://studio.example.test/p/'));
  const local = url.replace('https://studio.example.test', appBase);
  const ok = await fetch(local); // tanpa token: cukup tanda tangan
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /image\//);
  assert.equal((await fetch(local.replace(/sig=./, 'sig=0'))).status, 403);
  assert.equal((await fetch(local.replace(/exp=\d+/, 'exp=1'))).status, 403);
  await client.close();
});

test('retensi 7 hari: gambar kedaluwarsa disembunyikan lalu dihapus permanen oleh sweep', async () => {
  const store = await import('../src/store.js');
  const { config } = await import('../src/config.js');
  const idx = join(config.dataDir, 'index.json');
  const entries = JSON.parse(readFileSync(idx, 'utf8'));
  const victim = entries[0], survivor = entries.at(-1);
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  victim.createdAt = old; victim.expiresAt = new Date(Date.now() - 86400000).toISOString();
  writeFileSync(idx, JSON.stringify(entries));
  const listed = await (await fetch(appBase + '/api/gallery?limit=200', { headers: H })).json();
  assert.ok(!listed.some((e) => e.id === victim.id), 'kedaluwarsa tidak tampil walau belum di-sweep');
  assert.equal((await fetch(`${appBase}/files/${victim.file}?token=rahasia`)).status, 200, 'file masih di disk sebelum sweep');
  const r = await store.sweep();
  assert.ok(r.deleted >= 1);
  assert.ok(!existsSync(store.imagePath(victim.file)), 'file terhapus permanen');
  assert.ok(existsSync(store.imagePath(survivor.file)), 'gambar baru tetap ada');
  assert.ok(readFileSync(join(config.dataDir, 'deleted.log'), 'utf8').includes(victim.id));
  assert.ok(!JSON.parse(readFileSync(idx, 'utf8')).some((e) => e.id === victim.id));
});

const J = { 'Content-Type': 'application/json' };
const login = (body, ip = '10.0.0.1') => fetch(appBase + '/auth/login', { method: 'POST', headers: { ...J, 'X-Forwarded-For': ip }, body: JSON.stringify(body) });

test('login: halaman utama dialihkan ke /login, password salah ditolak, benar memberi cookie HttpOnly', async () => {
  const home = await fetch(appBase + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/login');
  assert.equal((await fetch(appBase + '/login')).status, 200);
  assert.equal((await login({ user: 'bos', password: 'salah' }, '10.0.0.2')).status, 401);
  assert.equal((await login({ user: 'lain', password: 'sandi-panjang-123' }, '10.0.0.2')).status, 401);
  const ok = await login({ user: 'bos', password: 'sandi-panjang-123' }, '10.0.0.3');
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const c = cookie.split(';')[0];
  assert.equal((await fetch(appBase + '/', { headers: { Cookie: c } })).status, 200);
  const cfgRes = await fetch(appBase + '/api/config', { headers: { Cookie: c } });
  assert.equal(cfgRes.status, 200);
  assert.equal((await cfgRes.json()).user, 'bos');
  const gal = await (await fetch(appBase + '/api/gallery', { headers: H })).json();
  assert.equal((await fetch(`${appBase}/files/${gal[0].file}`, { headers: { Cookie: c } })).status, 200, 'gambar bisa dibuka dengan sesi login');
  // CSRF: cookie + body non-JSON ditolak
  const bad = await fetch(appBase + '/api/style', { method: 'PUT', headers: { Cookie: c, 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(bad.status, 415);
  // cookie TIDAK dipakai untuk /mcp (hanya bearer)
  assert.equal((await fetch(appBase + '/mcp', { method: 'POST', headers: { ...J, Cookie: c }, body: '{}' })).status, 401);
  // cookie palsu / dirusak
  assert.equal((await fetch(appBase + '/api/config', { headers: { Cookie: c.slice(0, -3) + 'abc' } })).status, 401);
  // logout menghapus cookie
  const out = await fetch(appBase + '/auth/logout', { method: 'POST', headers: { ...J, Cookie: c }, body: '{}' });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('login: dikunci 15 menit setelah 5 kali gagal dari IP yang sama', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login({ user: 'bos', password: 'x' + i }, '10.9.9.9')).status, 401);
  const locked = await login({ user: 'bos', password: 'sandi-panjang-123' }, '10.9.9.9');
  assert.equal(locked.status, 429, 'bahkan password benar ditolak saat terkunci');
  assert.equal((await login({ user: 'bos', password: 'sandi-panjang-123' }, '10.8.8.8')).status, 200, 'IP lain tidak terpengaruh');
});

test('pengaturan biaya: validasi, batas harian/mingguan/bulanan benar-benar menahan generate', async () => {
  const put = (b) => fetch(appBase + '/api/settings', { method: 'PUT', headers: H, body: JSON.stringify(b) });
  assert.equal((await put({ dailyBudgetIdr: -5 })).status, 400);
  assert.equal((await put({ maxN: 11 })).status, 400);
  assert.equal((await put({ dailyBudgetIdr: 1.5 })).status, 400);
  const gen = () => post('/api/generate', { prompt: 'uji batas', model: 'gpt-image-2', useStyle: false });
  const before = calls.length;

  assert.equal((await put({ dailyBudgetIdr: 100, weeklyBudgetIdr: 0, monthlyBudgetIdr: 0 })).status, 200);
  let r = await gen();
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /harian/i);

  const cfg0 = await (await fetch(appBase + '/api/config', { headers: H })).json();
  assert.equal(cfg0.dailyBudgetIdr, 100);
  await put({ dailyBudgetIdr: 0, weeklyBudgetIdr: cfg0.spentWeekIdr + 100 });
  r = await gen();
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /mingguan/i);

  await put({ weeklyBudgetIdr: 0, monthlyBudgetIdr: cfg0.spentMonthIdr + 100 });
  r = await gen();
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /bulanan/i);
  assert.equal(calls.length, before, 'kenari tidak dipanggil saat batas terlewati');

  await put({ monthlyBudgetIdr: 0, maxN: 2 }); // tanpa batas: generate lolos, n dipotong ke maxN
  r = await post('/api/generate', { prompt: 'uji maxn', model: 'gpt-image-2', n: 5, useStyle: false });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).images.length, 2);
  await put({ dailyBudgetIdr: 2000, maxN: 5 }); // pulihkan
});

test('ledger: total biaya tidak hilang saat gambar dihapus oleh retensi', async () => {
  const store = await import('../src/store.js');
  const before = await store.usage();
  assert.ok(before.today > 0);
  const { config } = await import('../src/config.js');
  const idx = join(config.dataDir, 'index.json');
  const entries = JSON.parse(readFileSync(idx, 'utf8'));
  for (const e of entries) e.expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(idx, JSON.stringify(entries));
  const r = await store.sweep();
  assert.ok(r.deleted > 0);
  assert.deepEqual(await store.usage(), before, 'pemakaian tetap sama setelah semua gambar dihapus');
});

test('share dari web: butuh gambar ada; PUBLIC_URL https dipakai', async () => {
  const g = await (await post('/api/generate', { prompt: 'untuk share', model: 'gpt-image-2', useStyle: false })).json();
  const r = await post('/api/share', { id: g.images[0].id, ttlMinutes: 10 });
  assert.equal(r.status, 200);
  assert.match((await r.json()).url, /^https:\/\/studio\.example\.test\/p\//);
  assert.equal((await post('/api/share', { id: 'tidakada' })).status, 404);
});

test('weekStartOf: pekan dimulai Senin', async () => {
  const { weekStartOf } = await import('../src/store.js');
  assert.equal(weekStartOf('2026-11-05'), '2026-11-02'); // Kamis -> Senin
  assert.equal(weekStartOf('2026-11-02'), '2026-11-02');
  assert.equal(weekStartOf('2026-11-08'), '2026-11-02'); // Minggu masih pekan yang sama
});

test('URL konektor /mcp/<rahasia>: tools terbuka tanpa header, rahasia salah ditolak, tidak membuka API', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp/rahasia-konektor-0123456789abcdef')));
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('generate_image') && names.includes('get_image_public_url'));
  await client.close();
  assert.equal((await fetch(appBase + '/mcp/salah-salah-salah-salah-salah', { method: 'POST', headers: J, body: '{}' })).status, 404);
  assert.equal((await fetch(appBase + '/mcp/pendek', { method: 'POST', headers: J, body: '{}' })).status, 404);
  assert.equal((await fetch(appBase + '/api/config?x=/mcp/rahasia-konektor-0123456789abcdef')).status, 401, 'rahasia tidak membuka API');
});

test('rahasia konektor hanya ditampilkan ke admin yang login, tidak ke bearer token', async () => {
  const viaToken = await (await fetch(appBase + '/api/config', { headers: H })).json();
  assert.equal(viaToken.mcpPathSecret, null);
  const ok = await login({ user: 'bos', password: 'sandi-panjang-123' }, '10.7.7.7');
  const c = ok.headers.get('set-cookie').split(';')[0];
  const viaSession = await (await fetch(appBase + '/api/config', { headers: { Cookie: c } })).json();
  assert.equal(viaSession.mcpPathSecret, 'rahasia-konektor-0123456789abcdef');
});
