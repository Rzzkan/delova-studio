import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import * as store from './store.js';
import * as service from './service.js';
import * as kenari from './kenari.js';
import { buildMcpServer } from './mcp.js';
import { ApprovalRequired } from './service.js';
import { detectMime } from './kenari.js';
import { verify } from './share.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '40mb' }));

  const safeEq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const auth = (req, res, next) => {
    if (!config.accessToken) return next();
    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (given && safeEq(given, config.accessToken)) return next();
    res.status(401).json({ error: 'Token salah atau belum diisi' });
  };

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(express.static(resolve(config.root, 'public')));

  const api = express.Router();
  api.use(auth);

  api.get('/config', async (_req, res) => {
    res.json({
      defaultModel: config.defaultModel,
      maxN: config.maxN,
      dailyBudgetIdr: config.dailyBudgetIdr,
      approvalThresholdIdr: config.approvalThresholdIdr,
      spentTodayIdr: await store.spentToday(),
      hasApiKey: Boolean(config.kenariApiKey),
      retentionDays: config.retentionDays,
    });
  });
  api.get('/models', async (_req, res, next) => {
    try { res.json(await kenari.listImageModels()); } catch (e) { next(e); }
  });
  api.get('/estimate', async (req, res, next) => {
    try { res.json(await service.estimate({ model: req.query.model || config.defaultModel, n: req.query.n })); } catch (e) { next(e); }
  });
  api.post('/generate', async (req, res, next) => {
    try { res.json(await service.generateImages({ ...req.body, useStyle: req.body.useStyle ?? true, source: 'web' })); } catch (e) { next(e); }
  });
  api.post('/edit', async (req, res, next) => {
    try {
      const { sourceId, imageBase64, ...rest } = req.body;
      let source;
      if (sourceId) {
        const e = await store.getImage(sourceId);
        if (!e) return res.status(404).json({ error: 'Gambar sumber tidak ada' });
        source = { buffer: await store.readImageFile(e.file), mime: e.mime };
      } else if (imageBase64) {
        const buffer = Buffer.from(imageBase64.replace(/^data:[^,]+,/, ''), 'base64');
        source = { buffer, mime: detectMime(buffer) };
      } else return res.status(400).json({ error: 'Pilih gambar dari galeri atau unggah gambar' });
      res.json(await service.editImages({ ...rest, sources: [source], source: 'web' }));
    } catch (e) { next(e); }
  });
  api.get('/gallery', async (req, res, next) => {
    try { res.json(await store.listImages({ limit: Number(req.query.limit) || 60, query: req.query.q })); } catch (e) { next(e); }
  });
  api.get('/style', async (_req, res, next) => {
    try { res.json({ style: await store.getStyle() }); } catch (e) { next(e); }
  });
  api.put('/style', async (req, res, next) => {
    try { await store.setStyle(String(req.body.style || '').slice(0, 4000)); res.json({ ok: true }); } catch (e) { next(e); }
  });
  app.use('/api', api);

  // File gambar: dilindungi token yang sama; browser memakai ?token= untuk tag <img>.
  app.get('/files/:file', (req, res, next) => {
    if (config.accessToken && !req.headers.authorization && req.query.token) req.headers.authorization = `Bearer ${req.query.token}`;
    auth(req, res, () => res.sendFile(store.imagePath(req.params.file), (err) => err && res.status(404).end()));
  });

  // Tautan publik bertanda tangan + kedaluwarsa (untuk Social Hub). Tidak memakai token, hanya tanda tangan.
  app.get('/p/:name', async (req, res) => {
    const id = req.params.name.split('.')[0];
    if (!(await verify(id, req.query.exp, req.query.sig))) return res.status(403).type('text').send('Tautan tidak valid atau sudah kedaluwarsa');
    const entry = await store.getImage(id);
    if (!entry) return res.status(404).type('text').send('Gambar sudah dihapus (masa simpan habis)');
    res.set('Cache-Control', 'private, max-age=300').type(entry.mime);
    res.sendFile(store.imagePath(entry.file), (err) => err && !res.headersSent && res.status(404).end());
  });

  // MCP lewat Streamable HTTP (stateless): hubungkan dari Claude Code / klien MCP remote.
  app.post('/mcp', auth, async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  app.all('/mcp', auth, (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ApprovalRequired) return res.status(402).json({ error: err.message, approvalRequired: true, estimate: err.details });
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status === 401 ? 502 : status).json({ error: err.message });
  });
  return app;
}

if (process.argv[1] === import.meta.filename) {
  await store.init();
  store.startSweeper();
  if (!config.accessToken && config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.error('ACCESS_TOKEN wajib diisi jika HOST bukan localhost. Berhenti.');
    process.exit(1);
  }
  createApp().listen(config.port, config.host, () => {
    console.log(`Teman Seller Studio: http://${config.host}:${config.port}  (MCP: /mcp)`);
    if (!config.kenariApiKey) console.warn('Peringatan: KENARI_API_KEY belum diisi.');
  });
}
