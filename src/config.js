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
  accessToken: process.env.ACCESS_TOKEN || '',
  defaultModel: process.env.DEFAULT_MODEL || 'gpt-image-2',
  dataDir: resolve(root, process.env.DATA_DIR || 'data'),
  // Aturan kantor: pengeluaran uang butuh persetujuan Owner.
  dailyBudgetIdr: num(process.env.DAILY_BUDGET_IDR, 5000),
  approvalThresholdIdr: num(process.env.APPROVAL_THRESHOLD_IDR, 1000),
  maxN: num(process.env.MAX_N, 5),
  requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 300000),
  publicUrl: process.env.PUBLIC_URL || '',
};
