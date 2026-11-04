import * as kenari from './kenari.js';
import * as store from './store.js';
import * as settings from './settings.js';
import * as log from './log.js';
import * as styles from './styles.js';

export class ApprovalRequired extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ApprovalRequired';
    this.details = details;
  }
}

async function priceOf(model) {
  const models = await kenari.listImageModels();
  const m = models.find((x) => x.id === model);
  if (!m) throw new Error(`Model gambar "${model}" tidak ditemukan. Pakai list_image_models untuk melihat daftar.`);
  return m.pricePerImageIdr;
}

export const clampN = (n, max) => Math.min(max, Math.max(1, Math.floor(Number(n) || 1)));
const remain = (limit, spent) => (limit > 0 ? Math.max(0, limit - spent) : null); // null = tanpa batas

export async function estimate({ model, n = 1 }) {
  const st = await settings.get();
  model ||= st.defaultModel;
  const price = await priceOf(model);
  const count = clampN(n, st.maxN);
  const totalIdr = price === null ? null : price * count;
  const u = await store.usage();
  return {
    model,
    n: count,
    pricePerImageIdr: price,
    totalIdr,
    spentTodayIdr: u.today,
    spentWeekIdr: u.week,
    spentMonthIdr: u.month,
    dailyBudgetIdr: st.dailyBudgetIdr,
    weeklyBudgetIdr: st.weeklyBudgetIdr,
    monthlyBudgetIdr: st.monthlyBudgetIdr,
    remainingTodayIdr: remain(st.dailyBudgetIdr, u.today),
    remainingWeekIdr: remain(st.weeklyBudgetIdr, u.week),
    remainingMonthIdr: remain(st.monthlyBudgetIdr, u.month),
    needsApproval: totalIdr === null || totalIdr > st.approvalThresholdIdr,
    approvalThresholdIdr: st.approvalThresholdIdr,
  };
}

// Penjaga biaya: aturan kantor menyatakan pengeluaran uang butuh persetujuan Owner.
async function guard(est, approved) {
  for (const [label, limit, spent] of [
    ['harian', est.dailyBudgetIdr, est.spentTodayIdr],
    ['mingguan', est.weeklyBudgetIdr, est.spentWeekIdr],
    ['bulanan', est.monthlyBudgetIdr, est.spentMonthIdr],
  ]) {
    if (limit > 0 && est.totalIdr !== null && est.totalIdr > 0 && spent + est.totalIdr > limit) { // model gratis tidak memakai budget
      throw new ApprovalRequired(
        `Batas budget ${label} Rp${limit} terlampaui (terpakai Rp${spent}, permintaan ini Rp${est.totalIdr}). Owner dapat menaikkannya di Dashboard > Batas Biaya.`,
        est,
      );
    }
  }
  if (est.needsApproval && !approved) {
    throw new ApprovalRequired(
      `Biaya ${est.totalIdr === null ? 'tidak diketahui' : 'Rp' + est.totalIdr} melewati ambang persetujuan Rp${est.approvalThresholdIdr}. Minta persetujuan Owner (Aditya), lalu ulangi dengan approved=true.`,
      est,
    );
  }
}

// Style Guide: gaya dasar + (opsional) gaya terpilih. `style` = id atau nama; kosong = hanya gaya dasar.
function withStyle(prompt, useStyle, style) {
  if (!useStyle) return { prompt, used: [] };
  const { text, used } = styles.compose(style);
  return { prompt: text ? `${prompt}\n\n${text}` : prompt, used };
}

// Jalankan dengan model utama; jika gagal (gangguan kenari, model bermasalah, dll.) coba model cadangan berurutan.
// Setiap model cadangan tetap lewat penjaga biaya yang sama (batas budget + persetujuan Owner), jadi tidak ada
// pengeluaran tersembunyi: cadangan yang lebih mahal dari yang disetujui dilewati dan dicatat di log.
// 401/403 (key salah/dilarang) tidak memicu cadangan karena model lain tidak akan menolong.
async function withFallback({ kind, source, model, n, approved, call }) {
  const st = await settings.get();
  const primaryEst = await estimate({ model, n });
  const primary = primaryEst.model;
  const chain = [primary, ...st.fallbackModels.filter((m) => m !== primary)];
  const failures = [];
  for (const [i, m] of chain.entries()) {
    let est = primaryEst;
    if (i > 0) {
      try {
        est = await estimate({ model: m, n });
        // persetujuan Owner hanya berlaku untuk biaya yang disetujui: cadangan yang lebih mahal butuh persetujuan baru
        await guard(est, approved && est.totalIdr !== null && primaryEst.totalIdr !== null && est.totalIdr <= primaryEst.totalIdr);
      } catch (e) {
        log.record({ kind, source, model: m, status: 'skipped', fallbackFrom: primary, message: e.message });
        failures.push(`${m}: dilewati (${e.message})`);
        continue;
      }
    } else {
      await guard(est, approved);
    }
    const t0 = Date.now();
    try {
      const images = await call(m, est);
      log.record({ kind, source, model: m, status: 'ok', ms: Date.now() - t0, fallbackFrom: i > 0 ? primary : undefined, images: images.length });
      return { images, est, model: m, fallbackFrom: i > 0 ? primary : undefined, failures };
    } catch (e) {
      log.record({ kind, source, model: m, status: 'error', ms: Date.now() - t0, code: e.code, httpStatus: e.status, fallbackFrom: i > 0 ? primary : undefined, message: e.message });
      failures.push(`${m}: ${e.message}`);
      if (e.status === 401 || e.status === 403 || e.code === 'no_api_key') throw e;
      if (i === chain.length - 1) {
        if (chain.length === 1) throw e; // tanpa cadangan: pesan asli
        const err = new Error(`Semua model gagal. ${failures.join(' | ')}`);
        err.status = e.status;
        throw err;
      }
    }
  }
  const err = new Error(`Tidak ada model yang bisa dipakai. ${failures.join(' | ')}`);
  err.status = 502;
  throw err;
}

function finish({ images, est, model, fallbackFrom, failures }, saveMeta) {
  const costIdr = est.pricePerImageIdr === null ? 0 : est.pricePerImageIdr * images.length;
  return store.saveBatch({ images, meta: { ...saveMeta, model, costIdr } }).then((saved) => ({
    images: saved, costIdr, estimate: est, modelUsed: model, fallbackFrom: fallbackFrom || null, failures,
  }));
}

export async function generateImages({ prompt, model, n = 1, size, background, title, role, useStyle = true, style, approved = false, source = 'web' }) {
  if (!prompt?.trim()) throw new Error('prompt wajib diisi');
  const { prompt: finalPrompt, used } = withStyle(prompt, useStyle, style);
  const r = await withFallback({ kind: 'generate', source, model, n, approved, call: (m, est) => kenari.generate({ model: m, prompt: finalPrompt, n: est.n, size, background }) });
  return finish(r, { kind: 'generate', prompt, finalPrompt, title, role, size, source, style: used.join(' + ') || null });
}

export async function editImages({ prompt, sources, mask, model, n = 1, size, quality, title, role, useStyle = false, style, approved = false, source = 'web' }) {
  if (!prompt?.trim()) throw new Error('prompt wajib diisi');
  if (!sources?.length) throw new Error('minimal satu gambar sumber');
  const { prompt: finalPrompt, used } = withStyle(prompt, useStyle, style);
  const r = await withFallback({ kind: 'edit', source, model, n, approved, call: (m, est) => kenari.edit({ model: m, prompt: finalPrompt, images: sources, mask, n: est.n, size, quality }) });
  return finish(r, { kind: 'edit', prompt, finalPrompt, title, role, size, source, style: used.join(' + ') || null });
}
