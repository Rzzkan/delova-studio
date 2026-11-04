import { appendFileSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

// Log pemanggilan kenari (termasuk perpindahan ke model cadangan). Satu baris JSON per kejadian.
// Tidak memuat prompt maupun API key. Dipangkas otomatis agar tidak membengkak.
const file = () => join(config.dataDir, 'attempts.jsonl');
const MAX_BYTES = 1_000_000, KEEP = 500;

export function record(entry) {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    appendFileSync(file(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    if (statSync(file()).size > MAX_BYTES) {
      const lines = readFileSync(file(), 'utf8').trim().split('\n');
      writeFileSync(file(), lines.slice(-KEEP).join('\n') + '\n');
    }
  } catch { /* log tidak boleh menggagalkan generate */ }
}

export function recent({ limit = 100, onlyIssues = false } = {}) {
  let rows = [];
  try {
    rows = readFileSync(file(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { /* belum ada log */ }
  if (onlyIssues) rows = rows.filter((r) => r.status !== 'ok' || r.fallbackFrom);
  return rows.reverse().slice(0, Math.min(500, Math.max(1, limit)));
}
