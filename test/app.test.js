import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const models = JSON.parse(readFileSync(new URL('./fixtures/models.json', import.meta.url), 'utf8'));
let mock, base, app, appBase, calls = [], failNext = false, failModels = new Set();
let kieMock, kieBase, kieCalls = [], kieFail = null, kieBalance = 1000, kiePolls = new Map();
const KIE_CREDITS_PER_TASK = 4;
// Halaman docs model kie.ai (potongan OpenAPI) dengan indentasi seperti aslinya.
const kiePage = (id, inputLines) => `# T\n\n\`\`\`yaml\n            schema:\n              type: object\n              properties:\n                model:\n                  default: ${id}\n                  enum:\n                    - ${id}\n            example:\n              model: ${id}\n              callBackUrl: https://x/cb\n              input:\n${inputLines.map((l) => ' '.repeat(16) + l).join('\n')}\n      responses:\n        '200':\n`;

before(async () => {
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/models') return res.end(JSON.stringify(models));
      if (req.url === '/v1/account/balance') {
        const k = req.headers.authorization || '';
        if (k.endsWith('kn-ditolak0001')) { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'Invalid API key', code: 'invalid_api_key' } })); }
        if (k.endsWith('kn-terbatas001')) { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: 'restricted', code: 'restricted_key_not_allowed' } })); }
        return res.end(JSON.stringify({ object: 'account.balance', balance_micro_idr: 25000000000, reserved_micro_idr: 1500000, available_micro_idr: 24998500000, currency: 'IDR' }));
      }
      calls.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') });
      if (req.url.endsWith('/generations') && failModels.has(JSON.parse(Buffer.concat(chunks).toString()).model)) { res.statusCode = 503; return res.end(JSON.stringify({ error: { message: 'model sedang down', code: 'upstream_unavailable' } })); }
      if (failNext) { failNext = false; return res.end('   ' + JSON.stringify({ error: { message: 'provider gagal', code: 'upstream_error' } })); }
      let n = 1;
      if (req.url.endsWith('/generations')) n = JSON.parse(Buffer.concat(chunks).toString()).n || 1;
      res.end('  ' + JSON.stringify({ data: Array.from({ length: n }, () => ({ b64_json: PNG.toString('base64') })) }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${mock.address().port}/v1`;
  // Tiruan kie.ai: createTask -> recordInfo (generating lalu success) -> unduh file; kredit; unggah base64. Galat datang sebagai HTTP 200 + code.
  kieMock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const body = Buffer.concat(chunks).toString();
      const auth = req.headers.authorization || '';
      const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      if (u.pathname === '/llms.txt') {
        res.setHeader('Content-Type', 'text/plain');
        return res.end([
          `- Image    Models > Google [Google - Nano Banana](${kieBase}/market/google/nano-banana.md): x`,
          `- Image    Models > Vendor [Vendor - Edit X](${kieBase}/market/vendor/edit-x.md): x`,
          `- Image    Models > Vendor [Vendor - Upscale](${kieBase}/market/vendor/image-upscale.md): x`,
          `- Image    Models > Vendor [Terjemahan](${kieBase}/cn/market/vendor/edit-x.md): x`,
          `- Video    Models > Vendor [Video](${kieBase}/market/vendor/video.md): x`,
        ].join('\n'));
      }
      if (u.pathname === '/market/google/nano-banana.md') return res.end(kiePage('google/nano-banana', ['prompt: a', 'output_format: png', "aspect_ratio: '1:1'"]));
      if (u.pathname === '/market/vendor/edit-x.md') return res.end(kiePage('vendor/edit-x', ['prompt: a', 'image_url: https://x/y.png', "aspect_ratio: '1:1'"]));
      if (u.pathname === '/files/hasil.png') { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
      if (auth.endsWith('kie-kunci-salah-0123456789')) return json({ code: 401, msg: 'You do not have access permissions' });
      if (u.pathname === '/api/v1/chat/credit') return json({ code: 200, msg: 'success', data: kieBalance });
      if (u.pathname === '/api/file-base64-upload') { kieCalls.push({ path: u.pathname, body: JSON.parse(body) }); return json({ success: true, code: 200, data: { downloadUrl: `${kieBase}/files/hasil.png` } }); }
      if (u.pathname === '/api/v1/jobs/createTask') {
        kieCalls.push({ path: u.pathname, auth, body: JSON.parse(body) });
        if (kieFail) return json(kieFail);
        const id = `task${kieCalls.length}`;
        kiePolls.set(id, 0);
        return json({ code: 200, msg: 'success', data: { taskId: id } });
      }
      if (u.pathname === '/api/v1/jobs/recordInfo') {
        const id = u.searchParams.get('taskId');
        const n = (kiePolls.get(id) || 0) + 1;
        kiePolls.set(id, n);
        if (n < 2) return json({ code: 200, msg: 'success', data: { taskId: id, state: 'generating' } });
        return json({ code: 200, msg: 'success', data: { taskId: id, state: 'success', resultJson: JSON.stringify({ resultUrls: [`${kieBase}/files/hasil.png`] }), creditsConsumed: KIE_CREDITS_PER_TASK } });
      }
      res.statusCode = 404; json({ code: 404, msg: 'not found' });
    });
  });
  await new Promise((r) => kieMock.listen(0, '127.0.0.1', r));
  kieBase = `http://127.0.0.1:${kieMock.address().port}`;
  process.env.KIE_BASE_URL = kieBase;
  process.env.KIE_UPLOAD_URL = kieBase;
  process.env.KIE_POLL_MS = '10';
  process.env.KIE_DOCS_URL = kieBase;
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
after(() => { kieMock.closeAllConnections(); kieMock.close(); mock.closeAllConnections(); mock.close(); app.closeAllConnections(); app.close(); });

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
  assert.equal((await fetch(local.replace(/sig=(.)/, (_m, c) => `sig=${c === '0' ? '1' : '0'}`))).status, 403);
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
  const bad = await fetch(appBase + '/api/styles', { method: 'POST', headers: { Cookie: c, 'Content-Type': 'text/plain' }, body: 'x' });
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

test('konfigurasi API key: hanya admin web, dicek ke kenari, tersamarkan, langsung dipakai, bisa dihapus', async () => {
  const { statSync } = await import('node:fs');
  const key = (b, headers) => fetch(appBase + '/api/kenari/key', { method: 'PUT', headers, body: JSON.stringify(b) });
  // token mesin (Claude) tidak boleh mengubah key
  assert.equal((await key({ apiKey: 'kn-baru-abcdef123456' }, H)).status, 403);
  assert.equal((await fetch(appBase + '/api/kenari/key', { method: 'DELETE', headers: H })).status, 403);
  assert.equal((await fetch(appBase + '/api/kenari/test', { method: 'POST', headers: H, body: '{}' })).status, 403);

  const c = (await login({ user: 'bos', password: 'sandi-panjang-123' }, '10.6.6.6')).headers.get('set-cookie').split(';')[0];
  const S = { Cookie: c, 'Content-Type': 'application/json' };
  assert.equal((await key({ apiKey: 'bukan-key' }, S)).status, 400, 'format salah');
  const rej = await key({ apiKey: 'kn-ditolak0001' }, S);
  assert.equal(rej.status, 400, 'ditolak kenari -> tidak disimpan');
  assert.equal((await (await fetch(appBase + '/api/config', { headers: S })).json()).apiKeySource, 'env');

  const t = await (await fetch(appBase + '/api/kenari/test', { method: 'POST', headers: S, body: '{}' })).json();
  assert.equal(t.state, 'valid');
  assert.equal(t.balanceIdr, 25000);
  assert.equal(t.availableIdr, 24998.5);

  const restricted = await key({ apiKey: 'kn-terbatas001' }, S);
  assert.equal(restricted.status, 200);
  assert.equal((await restricted.json()).check.state, 'restricted');

  const full = 'kn-baru-abcdef123456';
  const okRes = await key({ apiKey: full }, S);
  assert.equal(okRes.status, 200);
  const okBody = await okRes.text();
  assert.ok(!okBody.includes(full), 'key penuh tidak boleh dikirim balik');
  const cfg = await (await fetch(appBase + '/api/config', { headers: S })).json();
  assert.equal(cfg.apiKeySource, 'dashboard');
  assert.equal(cfg.apiKeyMasked, 'kn-••••3456');
  assert.ok(!JSON.stringify(cfg).includes(full));
  assert.equal(statSync(join(process.env.DATA_DIR, 'secrets.json')).mode & 0o077, 0, 'berkas rahasia hanya bisa dibaca pemilik');

  const free = models.data.find((m) => m.id.endsWith(':free') && m.endpoints.includes('images')).id; // gratis: tidak tersangkut batas harian
  const r = await post('/api/generate', { prompt: 'pakai key baru', useStyle: false, model: free });
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1).auth, `Bearer ${full}`, 'key dashboard langsung dipakai tanpa restart');

  const del = await fetch(appBase + '/api/kenari/key', { method: 'DELETE', headers: S });
  assert.equal((await del.json()).source, 'env');
  await post('/api/generate', { prompt: 'kembali ke env', useStyle: false, model: free });
  assert.equal(calls.at(-1).auth, 'Bearer kn-test');
});

test('model default dari dashboard: divalidasi dan dipakai generate tanpa parameter model', async () => {
  const put = (b) => fetch(appBase + '/api/settings', { method: 'PUT', headers: H, body: JSON.stringify(b) });
  assert.equal((await put({ defaultModel: 'model-ngawur' })).status, 400);
  assert.equal((await put({ defaultModel: 'a b;c' })).status, 400);
  const free = models.data.find((m) => m.id.endsWith(':free') && m.endpoints.includes('images')).id;
  assert.equal((await put({ defaultModel: free })).status, 200);
  const cfg = await (await fetch(appBase + '/api/config', { headers: H })).json();
  assert.equal(cfg.defaultModel, free);
  const r = await post('/api/generate', { prompt: 'tanpa model', useStyle: false });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).estimate.model, free);
  assert.match(calls.at(-1).body, new RegExp(free.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await put({ defaultModel: 'gpt-image-2' }); // pulihkan
});

test('model cadangan: model utama gagal -> pindah ke cadangan, tercatat di log, biaya mengikuti model yang dipakai', async () => {
  const put = (b) => fetch(appBase + '/api/settings', { method: 'PUT', headers: H, body: JSON.stringify(b) });
  const free = models.data.filter((m) => m.id.endsWith(':free') && m.endpoints.includes('images')).map((m) => m.id);
  assert.equal((await put({ fallbackModels: ['model-ngawur'] })).status, 400, 'harus ada di daftar kenari');
  assert.equal((await put({ fallbackModels: ['a', 'b', 'c', 'd', 'e', 'f'] })).status, 400, 'maksimal 5');
  assert.equal((await put({ defaultModel: free[0], fallbackModels: [free[0], free[1], 'gpt-image-2'], dailyBudgetIdr: 100000 })).status, 200);

  failModels = new Set([free[0]]);
  let r = await post('/api/generate', { prompt: 'uji cadangan', useStyle: false });
  assert.equal(r.status, 200);
  let b = await r.json();
  assert.equal(b.modelUsed, free[1]);
  assert.equal(b.fallbackFrom, free[0]);
  assert.equal(b.costIdr, 0);
  assert.equal(b.images[0].model, free[1]);

  // semua gratis gagal -> cadangan berbayar (Rp125 <= ambang) dipakai dan dihitung biayanya
  failModels = new Set([free[0], free[1]]);
  r = await post('/api/generate', { prompt: 'uji cadangan 2', useStyle: false });
  b = await r.json();
  assert.equal(b.modelUsed, 'gpt-image-2');
  assert.equal(b.costIdr, 125);

  // semua gagal -> galat gabungan, tidak ada biaya
  failModels = new Set([free[0], free[1], 'gpt-image-2']);
  r = await post('/api/generate', { prompt: 'uji cadangan 3', useStyle: false });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /Semua model gagal/);

  // cadangan yang lebih mahal dari yang disetujui dilewati (butuh persetujuan baru)
  await put({ fallbackModels: ['grok-imagine-image-2-0'], approvalThresholdIdr: 100 });
  failModels = new Set([free[0]]);
  r = await post('/api/generate', { prompt: 'uji cadangan 4', useStyle: false, approved: true });
  assert.equal(r.status, 502, 'cadangan dilewati -> tidak ada model yang bisa dipakai');
  const logs = await (await fetch(appBase + '/api/logs?limit=50', { headers: H })).json();
  assert.ok(logs.some((l) => l.status === 'skipped' && l.model === 'grok-imagine-image-2-0'), 'cadangan mahal dicatat dilewati');
  assert.ok(logs.some((l) => l.status === 'error' && l.model === free[0] && l.httpStatus === 503));
  assert.ok(logs.some((l) => l.status === 'ok' && l.fallbackFrom === free[0]));
  assert.ok(!JSON.stringify(logs).includes('uji cadangan'), 'log tidak memuat prompt');
  assert.equal((await (await fetch(appBase + '/api/logs?issues=1', { headers: H })).json()).every((l) => l.status !== 'ok' || l.fallbackFrom), true);

  failModels = new Set();
  await put({ defaultModel: 'gpt-image-2', fallbackModels: [], approvalThresholdIdr: 1000, dailyBudgetIdr: 2000 }); // pulihkan
});

test('Style Guide jamak: dasar + per pilar, tambah/ubah/hapus, dipakai di prompt, MCP bisa memilih', async () => {
  const free = models.data.find((m) => m.id.endsWith(':free') && m.endpoints.includes('images')).id;
  const api = (m, p, b) => fetch(appBase + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  assert.equal((await api('POST', '/api/styles', { name: '  ' })).status, 400);
  const base = await (await api('POST', '/api/styles', { name: 'Gaya dasar', text: 'TEKS-DASAR', base: true })).json();
  const ngopi = await (await api('POST', '/api/styles', { name: 'Ngopi Dulu', pillar: 'Ngopi Dulu', text: 'TEKS-NGOPI' })).json();
  assert.equal((await api('POST', '/api/styles', { name: 'ngopi dulu' })).status, 400, 'nama kembar (tak peka huruf besar)');
  assert.equal(base.base, true);

  const gen = (b) => post('/api/generate', { prompt: 'uji style', model: free, ...b });
  let r = await gen({ style: 'Ngopi Dulu' });
  assert.equal(r.status, 200);
  assert.match(calls.at(-1).body, /TEKS-DASAR/);
  assert.match(calls.at(-1).body, /TEKS-NGOPI/);
  assert.equal((await r.json()).images[0].style, 'Gaya dasar + Ngopi Dulu');
  await gen({});
  assert.match(calls.at(-1).body, /TEKS-DASAR/);
  assert.doesNotMatch(calls.at(-1).body, /TEKS-NGOPI/, 'tanpa pilihan: hanya gaya dasar');
  await gen({ useStyle: false, style: 'Ngopi Dulu' });
  assert.doesNotMatch(calls.at(-1).body, /TEKS-/, 'useStyle=false mematikan semuanya');
  const before = calls.length;
  r = await gen({ style: 'tidak-ada' });
  assert.equal(r.status, 400);
  assert.equal(calls.length, before, 'style tak dikenal tidak memanggil kenari');

  // hanya satu gaya dasar
  await api('PUT', `/api/styles/${ngopi.id}`, { base: true });
  const all = (await (await api('GET', '/api/styles')).json()).styles;
  assert.deepEqual(all.filter((x) => x.base).map((x) => x.name), ['Ngopi Dulu']);
  await api('PUT', `/api/styles/${base.id}`, { base: true });

  // seed 7 pilar (tidak menimpa yang ada)
  const seed = await (await api('POST', '/api/styles/seed-pillars')).json();
  assert.equal(seed.added.length, 6, 'Ngopi Dulu sudah ada');
  assert.equal((await (await api('POST', '/api/styles/seed-pillars')).json()).added.length, 0);
  assert.equal((await (await api('GET', '/api/styles')).json()).styles.find((x) => x.name === 'Ngopi Dulu').text, 'TEKS-NGOPI');

  // MCP: list / set (upsert) / pilih style
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  const list = await client.callTool({ name: 'list_style_guides', arguments: {} });
  assert.match(list.content[0].text, /\[DASAR\] Gaya dasar/);
  assert.match(list.content[0].text, /Satu Langkah Kecil/);
  await client.callTool({ name: 'set_style_guide', arguments: { name: 'Pilar Uji', text: 'TEKS-UJI', pillar: 'Uji' } });
  const got = await client.callTool({ name: 'get_style_guide', arguments: { name: 'pilar uji' } });
  assert.match(got.content[0].text, /TEKS-UJI/);
  const out = await client.callTool({ name: 'generate_image', arguments: { prompt: 'via mcp', model: free, style: 'Pilar Uji' } });
  assert.ok(!out.isError, JSON.stringify(out));
  assert.match(calls.at(-1).body, /TEKS-UJI/);
  const bad = await client.callTool({ name: 'generate_image', arguments: { prompt: 'via mcp', model: free, style: 'ngawur' } });
  assert.equal(bad.isError, true);
  await client.close();

  // hapus
  const del = await api('DELETE', `/api/styles/${ngopi.id}`);
  assert.equal(del.status, 200);
  assert.equal((await api('DELETE', `/api/styles/${ngopi.id}`)).status, 404);
});

test('Style Guide di database SQLite: Claude kelola lewat MCP, hapus butuh approved, bisa dipulihkan, riwayat tercatat', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { err: r.isError, text: r.content[0].text }; };
  assert.ok(existsSync(join(process.env.DATA_DIR, 'studio.db')), 'database dibuat');

  const made = await call('set_style_guide', { name: 'Promo Gajian', pillar: 'Kabar Pasar', text: 'VERSI-1 tanggal gajian, warna merah-krem' });
  assert.ok(!made.err, made.text);
  await call('set_style_guide', { name: 'Promo Gajian', text: 'VERSI-2 lebih kalem' });
  assert.match((await call('get_style_guide', { name: 'Promo Gajian' })).text, /VERSI-2/);
  assert.match((await call('list_style_guides', {})).text, /Promo Gajian .*oleh claude \(MCP\)|Promo Gajian \| pilar: Kabar Pasar \| diubah .* oleh claude \(MCP\)/);

  // riwayat + kembalikan ke revisi lama
  const hist = (await call('style_guide_history', { name: 'Promo Gajian' })).text;
  assert.match(hist, /create oleh claude \(MCP\)/);
  const v1 = hist.split('\n').find((l) => l.includes('VERSI-1')).match(/^rev (\d+)/)[1];
  assert.ok(!(await call('restore_style_guide', { revision_id: Number(v1) })).err);
  assert.match((await call('get_style_guide', { name: 'Promo Gajian' })).text, /VERSI-1/);

  // menghapus: butuh persetujuan Owner; hapus lunak; bisa dipulihkan
  const noAppr = await call('delete_style_guide', { name: 'Promo Gajian' });
  assert.equal(noAppr.err, true);
  assert.match(noAppr.text, /persetujuan Owner/);
  assert.match((await call('get_style_guide', { name: 'Promo Gajian' })).text, /VERSI-1/, 'belum terhapus');
  assert.ok(!(await call('delete_style_guide', { name: 'Promo Gajian', approved: true })).err);
  assert.match((await call('get_style_guide', { name: 'Promo Gajian' })).text, /tidak ditemukan/);
  assert.match((await call('list_style_guides', {})).text, /Dihapus .*Promo Gajian/);
  const gen = await client.callTool({ name: 'generate_image', arguments: { prompt: 'x style hilang', style: 'Promo Gajian', model: models.data.find((m) => m.id.endsWith(':free')).id } });
  assert.equal(gen.isError, true, 'style terhapus tidak bisa dipakai');
  assert.ok(!(await call('restore_style_guide', { name: 'Promo Gajian' })).err);
  assert.match((await call('get_style_guide', { name: 'Promo Gajian' })).text, /VERSI-1/);

  // Claude menjadikan style sebagai gaya dasar -> tetap hanya satu dasar
  await call('set_style_guide', { name: 'Promo Gajian', text: 'VERSI-1 tanggal gajian, warna merah-krem', base: true });
  const web = (await (await fetch(appBase + '/api/styles', { headers: H })).json()).styles;
  assert.deepEqual(web.filter((x) => x.base).map((x) => x.name), ['Promo Gajian']);
  assert.equal(web.find((x) => x.name === 'Promo Gajian').updatedBy, 'claude (MCP)');
  await client.close();
});

test('Style Guide: data lama (styles.json dan style.txt) dimigrasi ke database sekali jalan', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const run = (dir) => spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `const s = await import(${JSON.stringify(new URL('../src/styles.js', import.meta.url).href)}); console.log(JSON.stringify(s.list().map(x => [x.name, x.text, x.base])));`],
  { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  const d1 = mkdtempSync(join(tmpdir(), 'mig1-'));
  writeFileSync(join(d1, 'style.txt'), 'gaya lama satu');
  assert.deepEqual(JSON.parse(run(d1).stdout), [['Gaya dasar', 'gaya lama satu', true]]);
  assert.deepEqual(JSON.parse(run(d1).stdout), [['Gaya dasar', 'gaya lama satu', true]], 'jalan kedua tidak menggandakan');
  const d2 = mkdtempSync(join(tmpdir(), 'mig2-'));
  mkdirSync(d2, { recursive: true });
  writeFileSync(join(d2, 'styles.json'), JSON.stringify({ styles: [{ id: 'a1', name: 'Ngopi Dulu', pillar: 'Ngopi Dulu', text: 'T1', base: false }, { id: 'a2', name: 'Dasar', text: 'T2', base: true }] }));
  const out = JSON.parse(run(d2).stdout);
  assert.deepEqual(out, [['Dasar', 'T2', true], ['Ngopi Dulu', 'T1', false]]);
  assert.ok(existsSync(join(d2, 'styles.json.migrated')));
});

// ---------------- multi-brand + model per pillar ----------------
const freeModels = () => models.data.filter((m) => m.id.endsWith(':free') && m.endpoints.includes('images')).map((m) => m.id);
const call2 = (m, p, b) => fetch(appBase + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });

test('multi-brand: tiap brand punya gaya dasar + pillar sendiri, nama pillar boleh sama, brand wajib disebut bila lebih dari satu', async () => {
  const free = freeModels();
  const ts = (await (await call2('GET', '/api/brands')).json()).brands;
  assert.equal(ts.length, 1);
  assert.equal(ts[0].slug, 'teman-seller');
  assert.equal(ts[0].default, true);

  assert.equal((await call2('POST', '/api/brands', { name: ' ' })).status, 400);
  const kids = await (await call2('POST', '/api/brands', { name: 'Delova Kids', note: 'baju anak' })).json();
  assert.equal(kids.slug, 'delova-kids');
  assert.equal((await call2('POST', '/api/brands', { name: 'delova kids' })).status, 400, 'nama brand kembar (tak peka huruf besar)');
  const wardrobe = await (await call2('POST', '/api/brands', { name: 'Delova Wardrobe' })).json();

  // style di tiap brand: nama pillar sama boleh di brand berbeda
  const k = (b) => call2('POST', '/api/styles', b);
  assert.equal((await k({ name: 'Gaya dasar', text: 'x' })).status, 400, 'ada banyak brand: brand wajib disebut');
  await k({ brand: 'delova-kids', name: 'Gaya dasar', text: 'DASAR-KIDS', base: true });
  await k({ brand: 'delova-kids', name: 'Hari Raya', pillar: 'Musiman', text: 'PILAR-KIDS-RAYA' });
  await k({ brand: 'delova-wardrobe', name: 'Gaya dasar', text: 'DASAR-WARDROBE', base: true });
  assert.equal((await k({ brand: 'delova-wardrobe', name: 'Hari Raya', text: 'PILAR-WARDROBE-RAYA' })).status, 201, 'nama sama di brand lain');
  assert.equal((await k({ brand: 'delova-wardrobe', name: 'hari raya', text: 'x' })).status, 400, 'tapi kembar di brand sama ditolak');

  // hanya satu gaya dasar PER BRAND
  const kidsStyles = (await (await call2('GET', '/api/styles?brand=delova-kids')).json()).styles;
  assert.deepEqual(kidsStyles.map((x) => x.name), ['Gaya dasar', 'Hari Raya']);
  assert.equal((await (await call2('GET', '/api/styles?brand=delova-wardrobe')).json()).styles.filter((x) => x.base).length, 1);
  assert.equal((await call2('GET', '/api/styles?brand=tidak-ada')).status, 400);

  // generate: brand wajib, style dicari di dalam brand-nya, prompt memakai gaya brand yang benar
  const gen = (b) => post('/api/generate', { prompt: 'uji brand', model: free[0], ...b });
  let r = await gen({});
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Sebutkan brand/);
  r = await gen({ brand: 'delova-kids', style: 'Hari Raya' });
  assert.equal(r.status, 200);
  assert.match(calls.at(-1).body, /DASAR-KIDS/);
  assert.match(calls.at(-1).body, /PILAR-KIDS-RAYA/);
  assert.doesNotMatch(calls.at(-1).body, /WARDROBE/);
  assert.match(calls.at(-1).body, /Style guide Delova Kids \(dasar\)/);
  const img = (await r.json()).images[0];
  assert.equal(img.brand, 'delova-kids');
  assert.equal(img.brandName, 'Delova Kids');
  await gen({ brand: 'Delova Wardrobe', style: 'Hari Raya' });
  assert.match(calls.at(-1).body, /PILAR-WARDROBE-RAYA/);
  assert.doesNotMatch(calls.at(-1).body, /KIDS/);
  const before = calls.length;
  r = await gen({ brand: 'delova-kids', style: 'Cerita Juragan' });
  assert.equal(r.status, 400, 'pillar milik brand lain tidak dikenali');
  assert.equal((await post('/api/generate', { prompt: 'x', model: free[0], brand: 'ngawur' })).status, 400);
  assert.equal(calls.length, before, 'brand/style salah tidak memanggil kenari');

  // galeri disaring per brand; gambar lama (tanpa brand) masuk brand default
  const kg = await (await call2('GET', '/api/gallery?brand=delova-kids')).json();
  assert.ok(kg.length >= 1 && kg.every((e) => e.brand === 'delova-kids'));
  const tg = await (await call2('GET', '/api/gallery?brand=teman-seller')).json();
  assert.ok(tg.length >= 1 && tg.every((e) => e.brand === 'teman-seller'));
  assert.ok((await (await call2('GET', '/api/gallery')).json()).length >= kg.length + tg.length);

  // brand default tidak bisa dihapus/dimatikan; brand lain bisa dihapus lalu dipulihkan (lewat MCP)
  assert.equal((await call2('DELETE', `/api/brands/${ts[0].id}`)).status, 400);
  assert.equal((await call2('PUT', `/api/brands/${ts[0].id}`, { default: false })).status, 400);
  assert.equal((await call2('PUT', `/api/brands/${wardrobe.id}`, { name: 'Delova Wardrobe Utama', note: 'baju dewasa' })).status, 200);
  assert.equal((await call2('DELETE', `/api/brands/${wardrobe.id}`)).status, 200);
  assert.equal((await call2('GET', '/api/styles?brand=delova-wardrobe')).status, 400, 'brand terhapus tak bisa dipakai');
  assert.equal((await gen({ brand: 'delova-wardrobe' })).status, 400);
});

test('model per pillar: pillar punya model + cadangan sendiri; model manual menang; cadangan pillar menimpa cadangan global', async () => {
  const free = freeModels();
  assert.ok(free.length >= 3);
  const [mA, mB, mC] = free;
  const post2 = (b) => post('/api/generate', { prompt: 'uji model pillar', brand: 'delova-kids', ...b });
  const usedModel = () => JSON.parse(calls.at(-1).body).model;
  assert.equal((await call2('PUT', '/api/settings', { defaultModel: mC, fallbackModels: [] })).status, 200); // default global = mC

  const bad = await call2('POST', '/api/styles', { brand: 'delova-kids', name: 'Model Ngawur', text: 'x', model: 'model-tidak-ada' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /tidak ada di daftar model/);
  assert.equal((await call2('POST', '/api/styles', { brand: 'delova-kids', name: 'Kebanyakan', text: 'x', fallbackModels: [mA, mB, mC, 'a', 'b', 'c'] })).status, 400);

  const pil = await (await call2('POST', '/api/styles', { brand: 'delova-kids', name: 'Studio Foto', text: 'PILAR-FOTO', model: mB, fallbackModels: [mC] })).json();
  assert.equal(pil.model, mB);
  assert.deepEqual(pil.fallbackModels, [mC]);

  // tanpa model eksplisit: pakai model pillar (bukan default global)
  let r = await post2({ style: 'Studio Foto' });
  assert.equal(r.status, 200);
  assert.equal(usedModel(), mB);
  assert.equal((await r.json()).modelUsed, mB);
  // pillar lain tanpa model: gaya dasar brand tidak punya model -> default global
  r = await post2({ style: 'Hari Raya', model: undefined });
  assert.equal(usedModel(), mC, 'tanpa model pillar: default global');
  // model eksplisit menang atas model pillar
  await post2({ style: 'Studio Foto', model: mA });
  assert.equal(usedModel(), mA);
  // useStyle=false mematikan model pillar juga
  await post2({ style: 'Studio Foto', useStyle: false });
  assert.equal(usedModel(), mC, 'useStyle=false: default global');

  // gaya dasar brand membawa model untuk semua pillar yang tak punya model sendiri
  const kidsBase = (await (await call2('GET', '/api/styles?brand=delova-kids')).json()).styles.find((x) => x.base);
  await call2('PUT', `/api/styles/${kidsBase.id}`, { model: mA });
  await post2({ style: 'Hari Raya' });
  assert.equal(usedModel(), mA, 'pillar tanpa model mewarisi model gaya dasar brand');
  await post2({ style: 'Studio Foto' });
  assert.equal(usedModel(), mB, 'model pillar lebih diutamakan daripada gaya dasar');

  // cadangan pillar: mB mati -> pindah ke mC (cadangan pillar), bukan cadangan global
  const put = (b) => call2('PUT', '/api/settings', b);
  await put({ fallbackModels: [mA] });
  failModels = new Set([mB]);
  r = await post2({ style: 'Studio Foto' });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.modelUsed, mC);
  assert.equal(out.fallbackFrom, mB);
  // pillar tanpa cadangan sendiri memakai cadangan global
  await call2('PUT', `/api/styles/${pil.id}`, { fallbackModels: [] });
  r = await post2({ style: 'Studio Foto' });
  assert.equal((await r.json()).modelUsed, mA, 'cadangan global dipakai bila pillar tak punya');
  failModels = new Set();
  await put({ fallbackModels: [] });

  // mengosongkan model pillar = kembali ke default
  await call2('PUT', `/api/styles/${pil.id}`, { model: '' });
  await post2({ style: 'Studio Foto' });
  assert.equal(usedModel(), mA, 'model pillar kosong: mewarisi gaya dasar brand (mA)');

  // riwayat menyimpan model; restore revisi mengembalikannya
  await call2('PUT', `/api/styles/${pil.id}`, { model: mB });
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  const mcp = async (name, args) => { const x = await client.callTool({ name, arguments: args }); return { err: x.isError, text: x.content[0].text }; };
  const hist = (await mcp('style_guide_history', { name: 'Studio Foto', brand: 'delova-kids' })).text;
  assert.match(hist, new RegExp(`model: ${mB.replace(/[.:]/g, '\\$&')}`));
  await client.close();
  await call2('PUT', '/api/settings', { defaultModel: 'gpt-image-2', fallbackModels: [] }); // pulihkan
});

test('multi-brand lewat MCP: list/set/delete/restore brand, brand wajib, model per pillar diatur Claude', async () => {
  const free = freeModels();
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  const mcp = async (name, args) => { const x = await client.callTool({ name, arguments: args }); return { err: x.isError, text: x.content[0].text }; };

  const made = await mcp('set_brand', { name: 'Delova Scarf', note: 'hijab dan scarf' });
  assert.ok(!made.err, made.text);
  assert.match(made.text, /slug: delova-scarf/);
  assert.match((await mcp('list_brands', {})).text, /\[DEFAULT\] Teman Seller[\s\S]*Delova Kids[\s\S]*Delova Scarf/);
  assert.ok(!(await mcp('set_brand', { name: 'delova scarf', note: 'catatan baru' })).err, 'upsert berdasarkan nama');

  // brand wajib untuk operasi tulis/generate bila ada banyak brand
  const noBrand = await mcp('set_style_guide', { name: 'Reels', text: 'x' });
  assert.equal(noBrand.err, true);
  assert.match(noBrand.text, /Sebutkan brand/);
  assert.equal((await mcp('generate_image', { prompt: 'tanpa brand', model: free[0] })).err, true);

  // Claude mengatur pillar + modelnya
  const set = await mcp('set_style_guide', { brand: 'Delova Scarf', name: 'Flatlay', pillar: 'Produk', text: 'PILAR-SCARF-FLATLAY', model: free[1], fallback_models: [free[2]] });
  assert.ok(!set.err, set.text);
  assert.match(set.text, new RegExp(`model: ${free[1].replace(/[.:]/g, '\\$&')}`));
  assert.equal((await mcp('set_style_guide', { brand: 'Delova Scarf', name: 'Flatlay', model: 'model-ngawur' })).err, true);
  const got = await mcp('get_style_guide', { name: 'flatlay', brand: 'delova-scarf' });
  assert.match(got.text, /PILAR-SCARF-FLATLAY/);
  assert.equal((await mcp('get_style_guide', { name: 'Flatlay' })).err, true, 'get tanpa brand ditolak saat banyak brand');
  const all = (await mcp('list_style_guides', {})).text;
  assert.match(all, /== Brand: Teman Seller/);
  assert.match(all, /== Brand: Delova Scarf/);
  assert.match(all, /Flatlay/);
  assert.doesNotMatch((await mcp('list_style_guides', { brand: 'delova-kids' })).text, /Flatlay/);

  const g = await client.callTool({ name: 'generate_image', arguments: { prompt: 'scarf flatlay', brand: 'Delova Scarf', style: 'Flatlay' } });
  assert.ok(!g.isError, JSON.stringify(g));
  assert.equal(JSON.parse(calls.at(-1).body).model, free[1], 'pillar menentukan model saat Claude tak menyebut model');
  assert.match(calls.at(-1).body, /PILAR-SCARF-FLATLAY/);
  assert.match(g.content[0].text, /untuk brand Delova Scarf \(Flatlay\)/);
  const gal = (await mcp('list_gallery', { brand: 'delova-scarf' })).text;
  assert.match(gal, /Delova Scarf/);
  assert.doesNotMatch((await mcp('list_gallery', { brand: 'delova-kids' })).text, /scarf flatlay/);

  // hapus butuh persetujuan Owner; brand default tak bisa dihapus; bisa dipulihkan
  const no = await mcp('delete_brand', { name: 'Delova Scarf' });
  assert.equal(no.err, true);
  assert.match(no.text, /persetujuan Owner/);
  assert.equal((await mcp('delete_brand', { name: 'Teman Seller', approved: true })).err, true, 'brand default');
  assert.ok(!(await mcp('delete_brand', { name: 'Delova Scarf', approved: true })).err);
  assert.equal((await mcp('get_style_guide', { name: 'Flatlay', brand: 'delova-scarf' })).err, true);
  assert.match((await mcp('list_brands', {})).text, /Dihapus .*Delova Scarf/);
  assert.ok(!(await mcp('restore_brand', { name: 'Delova Scarf' })).err);
  assert.match((await mcp('get_style_guide', { name: 'Flatlay', brand: 'delova-scarf' })).text, /PILAR-SCARF-FLATLAY/, 'style ikut kembali');
  assert.ok(!(await mcp('set_brand', { name: 'Delova Scarf', make_default: true })).err);
  assert.match((await mcp('list_brands', {})).text, /\[DEFAULT\] Delova Scarf/);
  await mcp('set_brand', { name: 'Teman Seller', make_default: true }); // kembalikan
  await client.close();
});

test('migrasi: database sebelum multi-brand (tanpa brand_id/model) dinaikkan, style lama jadi milik brand default', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'mig3-'));
  const make = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const d = new DatabaseSync(${JSON.stringify(join(dir, 'studio.db'))});
    d.exec(\`
      CREATE TABLE styles (id TEXT PRIMARY KEY, name TEXT NOT NULL, pillar TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', base INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT 'web', deleted_at TEXT);
      CREATE UNIQUE INDEX styles_name_live ON styles (lower(name)) WHERE deleted_at IS NULL;
      CREATE TABLE style_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, style_id TEXT NOT NULL, name TEXT NOT NULL, pillar TEXT NOT NULL, text TEXT NOT NULL, base INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
      INSERT INTO styles (id, name, pillar, text, base, updated_at) VALUES ('s1', 'Gaya dasar', '', 'DASAR-LAMA', 1, '2026-11-01T00:00:00Z'), ('s2', 'Ngopi Dulu', 'Ngopi Dulu', 'PILAR-LAMA', 0, '2026-11-01T00:00:00Z');
      INSERT INTO style_revisions (style_id, name, pillar, text, base, action, actor, at) VALUES ('s2', 'Ngopi Dulu', 'Ngopi Dulu', 'PILAR-LAMA', 0, 'create', 'web', '2026-11-01T00:00:00Z');
    \`);
  `], { encoding: 'utf8' });
  assert.equal(make.status, 0, make.stderr);
  const run = () => spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    const s = await import(${JSON.stringify(new URL('../src/styles.js', import.meta.url).href)});
    const b = s.listBrands();
    const c = s.compose(undefined, 'Ngopi Dulu');
    const before = s.list().map((x) => [x.name, x.text, x.base, x.model]);
    s.update('s2', { model: 'm-x', fallbackModels: ['m-y'] });
    console.log(JSON.stringify({ brands: b.map((x) => [x.name, x.slug, x.default, x.styleCount]), list: before, used: c.used, hist: s.history('Ngopi Dulu').length }));
  `], { env: { ...process.env, DATA_DIR: dir, DEFAULT_BRAND_NAME: 'Teman Seller' }, encoding: 'utf8' });
  const out = JSON.parse(run().stdout);
  assert.deepEqual(out.brands, [['Teman Seller', 'teman-seller', true, 2]]);
  assert.deepEqual(out.list, [['Gaya dasar', 'DASAR-LAMA', true, ''], ['Ngopi Dulu', 'PILAR-LAMA', false, '']]);
  assert.deepEqual(out.used, ['Gaya dasar', 'Ngopi Dulu']);
  const again = JSON.parse(run().stdout);
  assert.deepEqual(again.brands, [['Teman Seller', 'teman-seller', true, 2]], 'jalan kedua tidak menggandakan brand');
  assert.deepEqual(again.list.find((x) => x[0] === 'Ngopi Dulu'), ['Ngopi Dulu', 'PILAR-LAMA', false, 'm-x'], 'kolom model tersimpan');
});

test('kie.ai: cadangan otomatis saat kenari gagal, kredit dihitung & dikontrol (batas, ambang, saldo minimum), bisa dimatikan', async () => {
  const secrets = await import('../src/secrets.js');
  const put = (b) => fetch(appBase + '/api/settings', { method: 'PUT', headers: H, body: JSON.stringify(b) });
  const cfgNow = async () => (await fetch(appBase + '/api/config', { headers: H })).json();
  const logs = async () => (await fetch(appBase + '/api/logs?limit=100', { headers: H })).json();
  const original = (await (await fetch(appBase + '/api/settings', { headers: H })).json()).settings;

  // key kie: token mesin (Claude) ditolak; hanya admin web, format divalidasi, ditolak kie -> tidak disimpan, nilai tidak bocor
  assert.equal((await call2('PUT', '/api/kie/key', { apiKey: 'kie-test-key-0123456789abcd' })).status, 403);
  assert.equal((await call2('DELETE', '/api/kie/key')).status, 403);
  assert.equal((await post('/api/kie/test', {})).status, 403);
  const cookie = (await login({ user: 'bos', password: 'sandi-panjang-123' }, '10.7.7.7')).headers.get('set-cookie').split(';')[0];
  const S = { Cookie: cookie, 'Content-Type': 'application/json' };
  const kkey = (b) => fetch(appBase + '/api/kie/key', { method: 'PUT', headers: S, body: JSON.stringify(b) });
  assert.equal((await kkey({ apiKey: 'pendek' })).status, 400);
  assert.equal((await kkey({ apiKey: 'kie-kunci-salah-0123456789' })).status, 400, 'ditolak kie -> tidak disimpan');
  assert.equal((await (await fetch(appBase + '/api/config', { headers: S })).json()).kieKeySource, 'none');
  assert.equal((await (await fetch(appBase + '/api/kie/test', { method: 'POST', headers: S, body: '{}' })).json()).state, 'none');
  const saved = await kkey({ apiKey: 'kie-test-key-0123456789abcd' });
  assert.equal(saved.status, 200);
  const sb = await saved.json();
  assert.equal(sb.verified, true);
  assert.ok(!JSON.stringify(sb).includes('0123456789abcd'), 'key kie tidak bocor');
  const ok = await (await fetch(appBase + '/api/kie/test', { method: 'POST', headers: S, body: '{}' })).json();
  assert.deepEqual([ok.state, ok.credits, ok.estimatedUsd], ['valid', 1000, 5]);
  const c0 = await cfgNow();
  assert.equal(c0.hasKieKey, true);
  assert.equal(c0.kieKeySource, 'dashboard');
  assert.match(c0.kieKeyMasked, /••••abcd$/);
  assert.ok(!JSON.stringify(c0).includes('0123456789abcd'));
  assert.throws(() => secrets.setKieKey('pendek'), /tidak valid/);

  // pengaturan: validasi
  assert.equal((await put({ kieDailyCredits: -1 })).status, 400);
  assert.equal((await put({ kieCreditIdr: 0 })).status, 400);
  assert.equal((await put({ kieDefaultModel: 'model ngawur!' })).status, 400);
  assert.equal((await put({ kieModelCredits: { 'a/b': 'mahal' } })).status, 400);
  assert.equal((await put({ dailyBudgetIdr: 1000000, kieDailyCredits: 0, kieWeeklyCredits: 0, kieMonthlyCredits: 0, kieApprovalThresholdCredits: 20, kieMinBalance: 0, kieCreditIdr: 80, kieEnabled: true, kieDefaultModel: 'google/nano-banana', defaultModel: 'gpt-image-2', fallbackModels: [] })).status, 200);
  const cat = await (await fetch(appBase + '/api/kie/models', { headers: H })).json();
  assert.ok(cat.some((m) => m.id === 'google/nano-banana' && m.credits === 4 && m.priceIdr === 320 && m.isDefault));

  // kenari normal -> kie TIDAK dipakai
  kieCalls = [];
  let r = await post('/api/generate', { prompt: 'kenari sehat', useStyle: false, brand: 'Teman Seller' });
  { const j = await r.json(); assert.equal(j.providerUsed, 'kenari', JSON.stringify(j)); }
  assert.equal(kieCalls.length, 0);

  // kenari gagal -> kie.ai jadi cadangan: gambar tersimpan, kredit & rupiah tercatat, provider tercatat
  failModels = new Set(['gpt-image-2']);
  const before = await cfgNow();
  r = await post('/api/generate', { prompt: 'cadangan kie', useStyle: false, brand: 'Teman Seller', size: '1024x1792' });
  assert.equal(r.status, 200);
  let b = await r.json();
  assert.equal(b.providerUsed, 'kie');
  assert.equal(b.modelUsed, 'google/nano-banana');
  assert.equal(b.fallbackFrom, 'gpt-image-2');
  assert.equal(b.credits, 4);
  assert.equal(b.costIdr, 320);
  assert.equal(b.images[0].provider, 'kie');
  assert.equal(b.images[0].credits, 4);
  const task = kieCalls.find((x) => x.path === '/api/v1/jobs/createTask');
  assert.equal(task.auth, 'Bearer kie-test-key-0123456789abcd');
  assert.deepEqual(task.body, { model: 'google/nano-banana', input: { prompt: 'cadangan kie', aspect_ratio: '9:16', output_format: 'png' } });
  const after1 = await cfgNow();
  assert.equal(after1.spentKieTodayCredits - before.spentKieTodayCredits, 4);
  assert.equal(after1.spentTodayIdr - before.spentTodayIdr, 320, 'rupiah kie ikut budget rupiah gabungan');
  const l = await logs();
  assert.ok(l.some((x) => x.provider === 'kie' && x.status === 'ok' && x.credits === 4 && x.fallbackFrom === 'gpt-image-2'));
  assert.ok(l.some((x) => x.status === 'error' && x.model === 'gpt-image-2'));
  assert.ok(!JSON.stringify(l).includes('cadangan kie'), 'log tidak memuat prompt');

  // n gambar = n tugas; kredit dijumlahkan
  r = await post('/api/generate', { prompt: 'dua gambar', useStyle: false, brand: 'Teman Seller', n: 2, approved: true });
  b = await r.json();
  assert.equal(b.images.length, 2);
  assert.equal(b.credits, 8);

  // edit: kenari gagal -> gambar sumber diunggah ke kie lalu edit-model kie dipakai
  failNext = true;
  kieCalls = [];
  r = await post('/api/edit', { prompt: 'ganti latar', imageBase64: PNG.toString('base64'), brand: 'Teman Seller', model: 'gpt-image-2' });
  b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  assert.equal(b.providerUsed, 'kie');
  assert.equal(b.modelUsed, 'google/nano-banana-edit');
  assert.ok(kieCalls.some((x) => x.path === '/api/file-base64-upload' && x.body.base64Data.startsWith('data:image/png;base64,')));
  assert.deepEqual(kieCalls.find((x) => x.path === '/api/v1/jobs/createTask').body.input.image_urls, [`${kieBase}/files/hasil.png`]);

  // kontrol kredit: ambang persetujuan -> cadangan tidak jalan diam-diam; provider=kie + approved=true menyetujui
  await put({ kieApprovalThresholdCredits: 2 });
  kieCalls = [];
  r = await post('/api/generate', { prompt: 'butuh setuju', useStyle: false, brand: 'Teman Seller' });
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /kie\.ai.*ambang persetujuan/);
  assert.equal(kieCalls.length, 0, 'tidak memanggil kie tanpa persetujuan');
  r = await post('/api/generate', { prompt: 'butuh setuju', useStyle: false, brand: 'Teman Seller', provider: 'kie', approved: true });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).fallbackFrom, null, 'dipilih langsung, bukan cadangan');

  // batas kredit harian menahan walau approved
  const spent = (await cfgNow()).spentKieTodayCredits;
  await put({ kieApprovalThresholdCredits: 1000, kieDailyCredits: spent + 3 });
  r = await post('/api/generate', { prompt: 'lewat batas', useStyle: false, brand: 'Teman Seller' });
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /Batas kredit kie\.ai harian/);
  r = await post('/api/generate', { prompt: 'lewat batas', useStyle: false, brand: 'Teman Seller', provider: 'kie', approved: true });
  assert.equal(r.status, 402, 'approved tidak menembus batas harian');
  await put({ kieDailyCredits: 0 });

  // saldo minimum
  kieBalance = 10;
  await put({ kieMinBalance: 8 });
  r = await post('/api/generate', { prompt: 'saldo tipis', useStyle: false, brand: 'Teman Seller' });
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /Saldo kie\.ai 10 kredit tidak cukup/);
  await put({ kieMinBalance: 0 });
  kieBalance = 1000;

  // kie juga gagal (kredit habis; galat datang sebagai HTTP 200 + code 402) -> galat gabungan, tanpa biaya
  kieFail = { code: 402, msg: 'Credits insufficient' };
  const spentBefore = await cfgNow();
  r = await post('/api/generate', { prompt: 'dua-duanya mati', useStyle: false, brand: 'Teman Seller' });
  assert.notEqual(r.status, 200);
  const msg = (await r.json()).error;
  assert.match(msg, /Kenari gagal/);
  assert.match(msg, /Kredit kie\.ai habis/);
  assert.equal((await cfgNow()).spentKieTodayCredits, spentBefore.spentKieTodayCredits);
  kieFail = null;

  // dimatikan -> kenari gagal tetap gagal seperti semula
  await put({ kieEnabled: false });
  kieCalls = [];
  r = await post('/api/generate', { prompt: 'tanpa cadangan', useStyle: false, brand: 'Teman Seller' });
  assert.equal(r.status, 503);
  assert.equal(kieCalls.length, 0);
  assert.equal((await post('/api/generate', { prompt: 'paksa kie', useStyle: false, brand: 'Teman Seller', provider: 'kie' })).status, 400);

  // estimasi kredit + MCP
  await put({ kieEnabled: true });
  const est = await (await fetch(appBase + '/api/estimate?provider=kie&n=2', { headers: H })).json();
  assert.deepEqual([est.totalCredits, est.totalIdr, est.provider], [8, 640, 'kie']);
  const status = await (await fetch(appBase + '/api/kie/status', { headers: H })).json();
  assert.equal(status.balance.credits, 1000);
  assert.equal(status.ready, true);

  // model kustom tanpa harga selalu butuh persetujuan; dengan harga kustom dihitung
  await put({ kieDefaultModel: 'vendor/model-baru' });
  assert.equal((await (await fetch(appBase + '/api/estimate?provider=kie', { headers: H })).json()).needsApproval, true);
  await put({ kieModelCredits: { 'vendor/model-baru': 1.5 } });
  const e2 = await (await fetch(appBase + '/api/estimate?provider=kie', { headers: H })).json();
  assert.deepEqual([e2.totalCredits, e2.totalIdr, e2.needsApproval], [1.5, 120, false]);

  failModels = new Set();
  assert.equal((await fetch(appBase + '/api/kie/key', { method: 'DELETE', headers: S })).status, 200);
  assert.equal((await cfgNow()).hasKieKey, false);
  await put(original);
});

test('kie.ai lewat MCP: kie_status dan estimate_cost provider=kie', async () => {
  const secrets = await import('../src/secrets.js');
  secrets.setKieKey('kie-test-key-0123456789abcd');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('kie_status') && names.includes('list_kie_models'));
  assert.match((await client.callTool({ name: 'list_kie_models', arguments: {} })).content[0].text, /google\/nano-banana \|.*4 kredit \(~Rp320\)/);
  const st = JSON.parse((await client.callTool({ name: 'kie_status', arguments: {} })).content[0].text);
  assert.equal(st.saldo.credits, 1000);
  assert.equal(st.saldoRupiah, 80000);
  assert.ok(!JSON.stringify(st).includes('0123456789abcd'));
  const est = JSON.parse((await client.callTool({ name: 'estimate_cost', arguments: { provider: 'kie', n: 2 } })).content[0].text);
  assert.equal(est.provider, 'kie');
  await client.close();
  secrets.clearKieKey();
});

test('kie.ai: daftar model diambil dari dokumentasi, pilihan model fleksibel, input mengikuti skema model', async () => {
  const secrets = await import('../src/secrets.js');
  secrets.setKieKey('kie-test-key-0123456789abcd');
  const put = (b) => fetch(appBase + '/api/settings', { method: 'PUT', headers: H, body: JSON.stringify(b) });
  const before = await (await fetch(appBase + '/api/kie/models', { headers: H })).json();
  assert.ok(!before.some((m) => m.id === 'vendor/edit-x'));

  const r = await post('/api/kie/models/sync', {});
  assert.equal(r.status, 200);
  const sync = await r.json();
  assert.equal(sync.count, 2, 'upscale, terjemahan /cn/, dan video dilewati');
  const m = sync.models.find((x) => x.id === 'vendor/edit-x');
  assert.deepEqual([m.kind, m.group, m.synced, m.credits], ['edit', 'Vendor', true, null]);
  assert.equal(sync.models.find((x) => x.id === 'google/nano-banana').credits, 4, 'harga katalog tetap');
  assert.ok((await (await fetch(appBase + '/api/kie/status', { headers: H })).json()).modelsFetchedAt);

  // model tanpa harga -> butuh persetujuan; dengan harga kustom bisa dipilih jadi default edit
  await put({ kieEditModel: 'vendor/edit-x', kieApprovalThresholdCredits: 20, kieDailyCredits: 0, dailyBudgetIdr: 1000000, defaultModel: 'gpt-image-2', fallbackModels: [], kieEnabled: true });
  assert.equal((await (await fetch(appBase + '/api/estimate?provider=kie&kind=edit', { headers: H })).json()).needsApproval, true);
  await put({ kieModelCredits: { 'vendor/edit-x': 3 } });

  failNext = true;
  kieCalls = [];
  const e = await post('/api/edit', { prompt: 'ganti', imageBase64: PNG.toString('base64'), brand: 'Teman Seller', model: 'gpt-image-2' });
  const eb = await e.json();
  assert.equal(e.status, 200, JSON.stringify(eb));
  assert.equal(eb.modelUsed, 'vendor/edit-x');
  assert.equal(eb.credits, 4);
  // skema dari dokumentasi: kolom gambar 'image_url' (bukan larik), tanpa output_format, tanpa aspect_ratio karena tak ada size
  assert.deepEqual(kieCalls.find((x) => x.path === '/api/v1/jobs/createTask').body, { model: 'vendor/edit-x', input: { prompt: 'ganti', image_url: `${kieBase}/files/hasil.png` } });

  // generate dengan model dari daftar: ikut skema (nano-banana punya output_format + aspect_ratio)
  await put({ kieDefaultModel: 'google/nano-banana' });
  failModels = new Set(['gpt-image-2']);
  kieCalls = [];
  assert.equal((await post('/api/generate', { prompt: 'uji skema', useStyle: false, brand: 'Teman Seller', size: '1024x1024' })).status, 200);
  assert.deepEqual(kieCalls.find((x) => x.path === '/api/v1/jobs/createTask').body.input, { prompt: 'uji skema', aspect_ratio: '1:1', output_format: 'png' });
  failModels = new Set();

  // MCP: Claude bisa mengambil ulang daftar
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(appBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer rahasia' } } }));
  assert.match((await client.callTool({ name: 'sync_kie_models', arguments: {} })).content[0].text, /Terbaca 2 model/);
  assert.match((await client.callTool({ name: 'list_kie_models', arguments: {} })).content[0].text, /vendor\/edit-x \| Vendor - Edit X \(Vendor\) \| edit \| 3 kredit/);
  await client.close();
  await put({ kieEditModel: 'google/nano-banana-edit', kieModelCredits: {} });
  secrets.clearKieKey();
});
