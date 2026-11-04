import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  root,
  port: num(process.env.PORT, 3400),
  host: process.env.HOST || '127.0.0.1',
  kenariBaseUrl: (process.env.KENARI_BASE_URL || 'https://kenari.id/v1').replace(/\/$/, ''),
  kenariApiKey: process.env.KENARI_API_KEY || '',
  accessToken: process.env.ACCESS_TOKEN || '', // token mesin: dipakai /mcp dan klien API
  // Opsional: rahasia di URL konektor Claude, /mcp/<rahasia>. Hanya membuka MCP (bukan web/API). Min. 24 karakter.
  mcpPathSecret: process.env.MCP_PATH_SECRET || '',
  adminUser: process.env.ADMIN_USER || 'admin', // login web dashboard
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionHours: num(process.env.SESSION_HOURS, 168),
  defaultModel: process.env.DEFAULT_MODEL || 'gpt-image-2',
  dataDir: resolve(root, process.env.DATA_DIR || 'data'),
  // Aturan kantor: pengeluaran uang butuh persetujuan Owner.
  // Nilai awal batas biaya. Bisa diubah di Dashboard > Batas Biaya (disimpan di data/settings.json). 0 = tanpa batas.
  dailyBudgetIdr: num(process.env.DAILY_BUDGET_IDR, 5000),
  weeklyBudgetIdr: num(process.env.WEEKLY_BUDGET_IDR, 0),
  monthlyBudgetIdr: num(process.env.MONTHLY_BUDGET_IDR, 0),
  approvalThresholdIdr: num(process.env.APPROVAL_THRESHOLD_IDR, 1000),
  maxN: num(process.env.MAX_N, 5),
  requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 300000),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  // Kebijakan Owner: gambar bersifat sementara, dihapus permanen setelah RETENTION_DAYS.
  retentionDays: num(process.env.RETENTION_DAYS, 7),
  signingSecret: process.env.SIGNING_SECRET || '',
};
