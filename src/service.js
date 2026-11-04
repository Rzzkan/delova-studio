import { config } from './config.js';
import * as kenari from './kenari.js';
import * as store from './store.js';

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

export async function estimate({ model = config.defaultModel, n = 1 }) {
  const price = await priceOf(model);
  const count = clampN(n);
  const totalIdr = price === null ? null : price * count;
  const spent = await store.spentToday();
  return {
    model,
    n: count,
    pricePerImageIdr: price,
    totalIdr,
    spentTodayIdr: spent,
    dailyBudgetIdr: config.dailyBudgetIdr,
    remainingTodayIdr: Math.max(0, config.dailyBudgetIdr - spent),
    needsApproval: totalIdr === null || totalIdr > config.approvalThresholdIdr,
    approvalThresholdIdr: config.approvalThresholdIdr,
  };
}

export const clampN = (n) => Math.min(config.maxN, Math.max(1, Math.floor(Number(n) || 1)));

// Penjaga biaya: aturan kantor menyatakan pengeluaran uang butuh persetujuan Owner.
async function guard(est, approved) {
  if (est.totalIdr !== null && est.spentTodayIdr + est.totalIdr > est.dailyBudgetIdr) {
    throw new ApprovalRequired(
      `Batas budget harian Rp${est.dailyBudgetIdr} terlampaui (terpakai Rp${est.spentTodayIdr}, permintaan ini Rp${est.totalIdr}). Owner perlu menaikkan DAILY_BUDGET_IDR.`,
      est,
    );
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

export async function generateImages({ prompt, model = config.defaultModel, n = 1, size, background, title, role, useStyle = true, approved = false, source = 'web' }) {
  if (!prompt?.trim()) throw new Error('prompt wajib diisi');
  const est = await estimate({ model, n });
  await guard(est, approved);
  const finalPrompt = await withStyle(prompt, useStyle);
  const images = await kenari.generate({ model, prompt: finalPrompt, n: est.n, size, background });
  const costIdr = est.pricePerImageIdr === null ? 0 : est.pricePerImageIdr * images.length;
  const saved = await store.saveBatch({ images, meta: { kind: 'generate', model, prompt, finalPrompt, title, role, size, costIdr, source } });
  return { images: saved, costIdr, estimate: est };
}

export async function editImages({ prompt, sources, mask, model = config.defaultModel, n = 1, size, quality, title, role, useStyle = false, approved = false, source = 'web' }) {
  if (!prompt?.trim()) throw new Error('prompt wajib diisi');
  if (!sources?.length) throw new Error('minimal satu gambar sumber');
  const est = await estimate({ model, n });
  await guard(est, approved);
  const finalPrompt = await withStyle(prompt, useStyle);
  const images = await kenari.edit({ model, prompt: finalPrompt, images: sources, mask, n: est.n, size, quality });
  const costIdr = est.pricePerImageIdr === null ? 0 : est.pricePerImageIdr * images.length;
  const saved = await store.saveBatch({ images, meta: { kind: 'edit', model, prompt, finalPrompt, title, role, size, costIdr, source } });
  return { images: saved, costIdr, estimate: est };
}
