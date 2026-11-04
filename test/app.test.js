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
