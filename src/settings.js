import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

const file = () => join(config.dataDir, 'settings.json');

export const defaults = () => ({
  dailyBudgetIdr: config.dailyBudgetIdr,
  weeklyBudgetIdr: config.weeklyBudgetIdr,
  monthlyBudgetIdr: config.monthlyBudgetIdr,
  approvalThresholdIdr: config.approvalThresholdIdr,
  maxN: config.maxN,
});

// [min, max] per kolom. 0 pada batas anggaran = tanpa batas.
const RULES = {
  dailyBudgetIdr: [0, 100_000_000],
  weeklyBudgetIdr: [0, 1_000_000_000],
  monthlyBudgetIdr: [0, 1_000_000_000],
  approvalThresholdIdr: [0, 100_000_000],
  maxN: [1, 10],
};

export async function get() {
  let saved = {};
  try { saved = JSON.parse(await readFile(file(), 'utf8')); } catch { /* belum ada: pakai default .env */ }
  return { ...defaults(), ...saved };
}

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
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(file() + '.tmp', JSON.stringify(next, null, 2));
  await rename(file() + '.tmp', file());
  return next;
}
