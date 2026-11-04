import * as kenari from './kenari.js';
import * as store from './store.js';
import * as settings from './settings.js';

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
    if (limit > 0 && est.totalIdr !== null && spent + est.totalIdr > limit) {
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

async function withStyle(prompt, useStyle) {
  if (!useStyle) return prompt;
  const style = await store.getStyle();
  return style ? `${prompt}\n\nStyle guide Teman Seller: ${style}` : prompt;
}

export async function generateImages({ prompt, model, n = 1, size, background, title, role, useStyle = true, approved = false, source = 'web' }) {
  if (!prompt?.trim()) throw new Error('prompt wajib diisi');
  const est = await estimate({ model, n });
  model = est.model; // model default dari pengaturan jika tidak diisi
  await guard(est, approved);
  const finalPrompt = await withStyle(prompt, useStyle);
  const images = await kenari.generate({ model, prompt: finalPrompt, n: est.n, size, background });
  const costIdr = est.pricePerImageIdr === null ? 0 : est.pricePerImageIdr * images.length;
  const saved = await store.saveBatch({ images, meta: { kind: 'generate', model, prompt, finalPrompt, title, role, size, costIdr, source } });
  return { images: saved, costIdr, estimate: est };
}

export async function editImages({ prompt, sources, mask, model, n = 1, size, quality, title, role, useStyle = false, approved = false, source = 'web' }) {
  if (!prompt?.trim()) throw new Error('prompt wajib diisi');
  if (!sources?.length) throw new Error('minimal satu gambar sumber');
  const est = await estimate({ model, n });
  model = est.model; // model default dari pengaturan jika tidak diisi
  await guard(est, approved);
  const finalPrompt = await withStyle(prompt, useStyle);
  const images = await kenari.edit({ model, prompt: finalPrompt, images: sources, mask, n: est.n, size, quality });
  const costIdr = est.pricePerImageIdr === null ? 0 : est.pricePerImageIdr * images.length;
  const saved = await store.saveBatch({ images, meta: { kind: 'edit', model, prompt, finalPrompt, title, role, size, costIdr, source } });
  return { images: saved, costIdr, estimate: est };
}
