import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

const file = () => join(config.dataDir, 'settings.json');

export const defaults = () => ({
  defaultModel: config.defaultModel,
  fallbackModels: config.fallbackModels,
  dailyBudgetIdr: config.dailyBudgetIdr,
  weeklyBudgetIdr: config.weeklyBudgetIdr,
  monthlyBudgetIdr: config.monthlyBudgetIdr,
  approvalThresholdIdr: config.approvalThresholdIdr,
  maxN: config.maxN,
  kieEnabled: config.kieEnabled,
  kieDefaultModel: config.kieDefaultModel,
  kieEditModel: config.kieEditModel,
  kieDailyCredits: config.kieDailyCredits,
  kieWeeklyCredits: config.kieWeeklyCredits,
  kieMonthlyCredits: config.kieMonthlyCredits,
  kieApprovalThresholdCredits: config.kieApprovalThresholdCredits,
  kieMinBalance: config.kieMinBalance,
  kieCreditIdr: config.kieCreditIdr,
  kieModelCredits: {}, // harga kustom (kredit/gambar) per ID model kie, menimpa katalog bawaan
});

// [min, max] per kolom. 0 pada batas anggaran = tanpa batas.
const RULES = {
  dailyBudgetIdr: [0, 100_000_000],
  weeklyBudgetIdr: [0, 1_000_000_000],
  monthlyBudgetIdr: [0, 1_000_000_000],
  approvalThresholdIdr: [0, 100_000_000],
  maxN: [1, 10],
  kieDailyCredits: [0, 1_000_000],
  kieWeeklyCredits: [0, 10_000_000],
  kieMonthlyCredits: [0, 10_000_000],
  kieApprovalThresholdCredits: [0, 100_000],
  kieMinBalance: [0, 10_000_000],
  kieCreditIdr: [1, 100_000],
};

export function getSync() {
  let saved = {};
  try { saved = JSON.parse(readFileSync(file(), 'utf8')); } catch { /* belum ada: pakai default .env */ }
  return { ...defaults(), ...saved };
}
export async function get() { return getSync(); }

const MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;

export async function set(patch) {
  const next = await get();
  for (const [key, [lo, hi]] of Object.entries(RULES)) {
    if (patch[key] === undefined) continue;
    const v = Number(patch[key]);
    if (!Number.isInteger(v) || v < lo || v > hi) {
      const err = new Error(`${key} harus bilangan bulat ${lo} sampai ${hi}`);
      err.status = 400;
      throw err;
    }
    next[key] = v;
  }
  if (patch.defaultModel !== undefined) {
    if (!MODEL_RE.test(String(patch.defaultModel))) {
      const err = new Error('defaultModel tidak valid');
      err.status = 400;
      throw err;
    }
    next.defaultModel = String(patch.defaultModel);
  }
  if (patch.fallbackModels !== undefined) {
    const list = patch.fallbackModels;
    if (!Array.isArray(list) || list.length > 5 || !list.every((m) => typeof m === 'string' && MODEL_RE.test(m))) {
      const err = new Error('fallbackModels harus daftar maksimal 5 ID model yang valid');
      err.status = 400;
      throw err;
    }
    next.fallbackModels = [...new Set(list)];
  }
  if (patch.kieEnabled !== undefined) next.kieEnabled = Boolean(patch.kieEnabled);
  for (const k of ['kieDefaultModel', 'kieEditModel']) {
    if (patch[k] === undefined) continue;
    if (!MODEL_RE.test(String(patch[k]))) {
      const err = new Error(`${k} tidak valid`);
      err.status = 400;
      throw err;
    }
    next[k] = String(patch[k]);
  }
  if (patch.kieModelCredits !== undefined) {
    const m = patch.kieModelCredits;
    const entries = m && typeof m === 'object' && !Array.isArray(m) ? Object.entries(m) : null;
    if (!entries || entries.length > 30 || !entries.every(([id, c]) => MODEL_RE.test(id) && typeof c === 'number' && c >= 0 && c <= 100_000)) {
      const err = new Error('kieModelCredits harus objek {idModel: kredit} maksimal 30 model, kredit 0-100000');
      err.status = 400;
      throw err;
    }
    next.kieModelCredits = Object.fromEntries(entries);
  }
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(file() + '.tmp', JSON.stringify(next, null, 2));
  await rename(file() + '.tmp', file());
  return next;
}
