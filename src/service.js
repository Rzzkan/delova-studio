import * as kenari from './kenari.js';
import * as kie from './kie.js';
import * as secrets from './secrets.js';
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
  if (!m) throw Object.assign(new Error(`Model gambar "${model}" tidak ditemukan. Pakai list_image_models untuk melihat daftar.`), { code: 'model_not_found' });
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

// Style Guide: gaya dasar brand + (opsional) gaya pillar terpilih. `style` = id atau nama; kosong = hanya gaya dasar.
// Brand selalu dicek (dan dicatat di galeri) walau Style Guide dimatikan. Pillar juga membawa model + cadangan sendiri.
function withStyle(prompt, useStyle, brandRef, style) {
  const brand = styles.pickBrand(brandRef);
  if (!useStyle) return { prompt, used: [], brand, model: '', fallbackModels: [] };
  const c = styles.compose(brand.id, style);
  return { prompt: c.text ? `${prompt}\n\n${c.text}` : prompt, used: c.used, brand, model: c.model, fallbackModels: c.fallbackModels };
}

/** Pastikan ID model ada di daftar kenari (dipakai saat menyimpan konfigurasi model per pillar). */
export async function assertModels(ids) {
  const list = await kenari.listImageModels({ force: true }).catch(() => null); // daftar tak terjangkau: terima apa adanya
  const bad = list && ids.filter(Boolean).find((x) => !list.some((m) => m.id === x));
  if (bad) throw Object.assign(new Error(`Model "${bad}" tidak ada di daftar model gambar kenari`), { status: 400 });
}

export async function gallery({ query, limit, brand } = {}) {
  const b = brand ? styles.resolveBrand(brand) : null;
  return store.listImages({ query, limit, brand: b?.slug, fallbackBrand: styles.defaultBrand()?.slug });
}

// ---------- kie.ai: penyedia CADANGAN ----------
const NO_RETRY = (e) => e.status === 401 || e.status === 403 || e.code === 'no_api_key';

/** kie.ai dipakai hanya jika diaktifkan di Konfigurasi DAN API key-nya ada. */
export async function kieReady() {
  const st = await settings.get();
  return Boolean(st.kieEnabled && secrets.getKieKey());
}

export function kiePrice(st, model) {
  const custom = st.kieModelCredits?.[model];
  if (typeof custom === 'number') return custom;
  return kie.CATALOG.find((m) => m.id === model)?.credits ?? null; // null = harga tak diketahui -> selalu butuh persetujuan
}

/** Daftar model kie: katalog bawaan + model kustom, dengan harga kredit yang berlaku. */
export async function kieModels() {
  const st = await settings.get();
  const ids = new Set([...kie.CATALOG.map((m) => m.id), ...Object.keys(st.kieModelCredits || {}), st.kieDefaultModel, st.kieEditModel]);
  return [...ids].map((id) => {
    const base = kie.CATALOG.find((m) => m.id === id);
    const credits = kiePrice(st, id);
    return { id, name: base?.name || id, kind: base?.kind || (/edit/i.test(id) ? 'edit' : 'generate'), credits, priceIdr: credits === null ? null : Math.round(credits * st.kieCreditIdr), custom: typeof st.kieModelCredits?.[id] === 'number', isDefault: id === st.kieDefaultModel, isEditDefault: id === st.kieEditModel };
  });
}

export async function estimateKie({ model, n = 1, kind = 'generate' }) {
  const st = await settings.get();
  model ||= kind === 'edit' ? st.kieEditModel : st.kieDefaultModel;
  const count = clampN(n, st.maxN);
  const per = kiePrice(st, model);
  const totalCredits = per === null ? null : per * count;
  const u = await store.usage();
  const totalIdr = totalCredits === null ? null : Math.round(totalCredits * st.kieCreditIdr);
  return {
    provider: 'kie', model, n: count, creditsPerImage: per, totalCredits, creditIdr: st.kieCreditIdr,
    pricePerImageIdr: per === null ? null : Math.round(per * st.kieCreditIdr), totalIdr,
    spentTodayCredits: u.kieToday, spentWeekCredits: u.kieWeek, spentMonthCredits: u.kieMonth,
    dailyLimitCredits: st.kieDailyCredits, weeklyLimitCredits: st.kieWeeklyCredits, monthlyLimitCredits: st.kieMonthlyCredits,
    remainingTodayCredits: remain(st.kieDailyCredits, u.kieToday),
    remainingWeekCredits: remain(st.kieWeeklyCredits, u.kieWeek),
    remainingMonthCredits: remain(st.kieMonthlyCredits, u.kieMonth),
    minBalanceCredits: st.kieMinBalance,
    note: `Estimasi: ${totalCredits === null ? 'harga model tidak diketahui' : totalCredits + ' kredit = Rp' + totalIdr} (1 kredit = Rp${st.kieCreditIdr})`,
    approvalThresholdCredits: st.kieApprovalThresholdCredits,
    needsApproval: totalCredits === null || totalCredits > st.kieApprovalThresholdCredits,
    // untuk penjaga rupiah gabungan (kenari + kie berbagi budget rupiah yang sama)
    spentTodayIdr: u.today, spentWeekIdr: u.week, spentMonthIdr: u.month,
    dailyBudgetIdr: st.dailyBudgetIdr, weeklyBudgetIdr: st.weeklyBudgetIdr, monthlyBudgetIdr: st.monthlyBudgetIdr,
  };
}

// Penjaga kredit kie: batas kredit harian/mingguan/bulanan, budget rupiah gabungan, ambang persetujuan, dan saldo minimum.
async function guardKie(est, approved) {
  for (const [label, limit, spent] of [
    ['harian', est.dailyLimitCredits, est.spentTodayCredits],
    ['mingguan', est.weeklyLimitCredits, est.spentWeekCredits],
    ['bulanan', est.monthlyLimitCredits, est.spentMonthCredits],
  ]) {
    if (limit > 0 && est.totalCredits > 0 && spent + est.totalCredits > limit) {
      throw new ApprovalRequired(`Batas kredit kie.ai ${label} ${limit} terlampaui (terpakai ${spent}, permintaan ini ${est.totalCredits}). Owner dapat menaikkannya di Dashboard > Batas Biaya.`, est);
    }
  }
  await guard({ ...est, needsApproval: false }, true); // budget rupiah gabungan
  if (est.needsApproval && !approved) {
    throw new ApprovalRequired(
      `Biaya kie.ai ${est.totalCredits === null ? 'tidak diketahui (model tanpa harga)' : est.totalCredits + ' kredit (~Rp' + est.totalIdr + ')'} melewati ambang persetujuan ${est.approvalThresholdCredits} kredit. Minta persetujuan Owner (Aditya), lalu ulangi dengan provider="kie" dan approved=true.`,
      est,
    );
  }
  if (est.totalCredits > 0) {
    let bal = null;
    try { bal = await kie.balance(); } catch { /* saldo tak terbaca: biarkan kie yang menolak jika memang kurang */ }
    if (bal !== null && bal - est.totalCredits < est.minBalanceCredits) {
      throw new ApprovalRequired(`Saldo kie.ai ${bal} kredit tidak cukup (butuh ${est.totalCredits}${est.minBalanceCredits ? `, saldo minimum ${est.minBalanceCredits}` : ''}). Top up di kie.ai atau turunkan saldo minimum di Batas Biaya.`, est);
    }
  }
}

async function viaKie({ kind, source, n, approved, primaryEst, primary, kieCall, failures }) {
  const est = await estimateKie({ n, kind });
  // Cadangan otomatis: persetujuan Owner untuk biaya kenari hanya berlaku bila kie tidak lebih mahal (setara rupiah).
  const covered = !primaryEst || (approved && est.totalIdr !== null && primaryEst.totalIdr !== null && est.totalIdr <= primaryEst.totalIdr);
  try {
    await guardKie(est, primaryEst ? covered : approved);
  } catch (e) {
    log.record({ kind, source, provider: 'kie', model: est.model, status: 'skipped', fallbackFrom: primary, message: e.message });
    throw e;
  }
  const t0 = Date.now();
  try {
    const r = await kieCall(est.model, est);
    log.record({ kind, source, provider: 'kie', model: est.model, status: 'ok', ms: Date.now() - t0, fallbackFrom: primary, images: r.images.length, credits: r.credits });
    return { images: r.images, est, model: est.model, provider: 'kie', credits: r.credits, fallbackFrom: primary, failures };
  } catch (e) {
    log.record({ kind, source, provider: 'kie', model: est.model, status: 'error', ms: Date.now() - t0, code: e.code, httpStatus: e.status, fallbackFrom: primary, message: e.message });
    throw e;
  }
}

// Jalankan dengan model utama; jika gagal (gangguan kenari, model bermasalah, dll.) coba model cadangan berurutan.
// Setiap model cadangan tetap lewat penjaga biaya yang sama (batas budget + persetujuan Owner), jadi tidak ada
// pengeluaran tersembunyi: cadangan yang lebih mahal dari yang disetujui dilewati dan dicatat di log.
// 401/403 (key salah/dilarang) tidak memicu model cadangan kenari karena model lain tidak akan menolong.
async function kenariChain({ kind, source, primaryEst, approved, call, fallbackModels, n }) {
  const st = await settings.get();
  const primary = primaryEst.model;
  const chain = [primary, ...(fallbackModels?.length ? fallbackModels : st.fallbackModels).filter((m) => m !== primary)]; // cadangan pillar menimpa cadangan global
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
      return { images, est, model: m, provider: 'kenari', fallbackFrom: i > 0 ? primary : undefined, failures };
    } catch (e) {
      log.record({ kind, source, model: m, status: 'error', ms: Date.now() - t0, code: e.code, httpStatus: e.status, fallbackFrom: i > 0 ? primary : undefined, message: e.message });
      failures.push(`${m}: ${e.message}`);
      if (NO_RETRY(e)) throw Object.assign(e, { failures });
      if (i === chain.length - 1) {
        if (chain.length === 1) throw Object.assign(e, { failures }); // tanpa cadangan: pesan asli
        const err = new Error(`Semua model gagal. ${failures.join(' | ')}`);
        err.status = e.status;
        err.failures = failures;
        throw err;
      }
    }
  }
  const err = new Error(`Tidak ada model yang bisa dipakai. ${failures.join(' | ')}`);
  err.status = 502;
  err.failures = failures;
  throw err;
}

// provider: 'auto' (kenari dulu, kie.ai sebagai cadangan bila kenari gagal) | 'kie' (langsung kie.ai) | 'kenari' (tanpa cadangan kie).
async function withFallback({ kind, source, model, n, approved, call, kieCall, fallbackModels, provider = 'auto' }) {
  const kieOn = provider !== 'kenari' && (await kieReady());
  if (provider === 'kie') {
    if (!kieOn) throw Object.assign(new Error('kie.ai belum aktif: isi API key kie.ai dan aktifkan cadangan kie.ai di Dashboard > Konfigurasi.'), { status: 400 });
    return viaKie({ kind, source, n, approved, primaryEst: null, primary: undefined, kieCall, failures: [] });
  }
  let primaryEst, kenariErr;
  try {
    primaryEst = await estimate({ model, n });
  } catch (e) {
    if (e.code === 'model_not_found' || !kieOn) throw e; // salah input / tanpa cadangan: apa adanya
    kenariErr = e; // daftar model kenari tak terjangkau = kenari tidak jalan
    log.record({ kind, source, model: model || '(default)', status: 'error', code: e.code, httpStatus: e.status, message: e.message });
  }
  if (primaryEst) {
    try {
      return await kenariChain({ kind, source, primaryEst, approved, call, fallbackModels, n });
    } catch (e) {
      if (e instanceof ApprovalRequired || !kieOn) throw e; // butuh persetujuan: jangan diam-diam pindah ke kie
      kenariErr = e;
    }
  }
  try {
    return await viaKie({ kind, source, n, approved, primaryEst, primary: primaryEst?.model, kieCall, failures: kenariErr.failures || [kenariErr.message] });
  } catch (e) {
    const msg = `Kenari gagal (${kenariErr.message}); cadangan kie.ai juga tidak jalan: ${e.message}`;
    if (e instanceof ApprovalRequired) throw new ApprovalRequired(`Kenari gagal (${kenariErr.message}). Cadangan kie.ai butuh persetujuan: ${e.message}`, e.details);
    throw Object.assign(new Error(msg), { status: e.status || kenariErr.status || 502 });
  }
}

async function finish(r, saveMeta) {
  const st = await settings.get();
  const isKie = r.provider === 'kie';
  const credits = isKie ? r.credits ?? 0 : undefined;
  const costIdr = isKie ? Math.round(credits * st.kieCreditIdr) : r.est.pricePerImageIdr === null ? 0 : r.est.pricePerImageIdr * r.images.length;
  const saved = await store.saveBatch({ images: r.images, meta: { ...saveMeta, model: r.model, costIdr, provider: isKie ? 'kie' : 'kenari', credits } });
  return { images: saved, costIdr, credits: credits ?? null, estimate: r.est, modelUsed: r.model, providerUsed: isKie ? 'kie' : 'kenari', fallbackFrom: r.fallbackFrom || null, failures: r.failures };
}

// Urutan model: yang diminta eksplisit > model pillar (atau gaya dasar brand) > default global di Konfigurasi.
export async function generateImages({ prompt, model, n = 1, size, background, title, role, useStyle = true, style, brand, approved = false, source = 'web', provider = 'auto' }) {
  if (!prompt?.trim()) throw new Error('prompt wajib diisi');
  const w = withStyle(prompt, useStyle, brand, style);
  const r = await withFallback({
    kind: 'generate', source, provider, model: model || w.model || undefined, fallbackModels: w.fallbackModels, n, approved,
    call: (m, est) => kenari.generate({ model: m, prompt: w.prompt, n: est.n, size, background }),
    kieCall: (m, est) => kie.generate({ model: m, prompt: w.prompt, n: est.n, size, perImageCredits: est.creditsPerImage }),
  });
  return finish(r, { kind: 'generate', prompt, finalPrompt: w.prompt, title, role, size, source, style: w.used.join(' + ') || null, brand: w.brand.slug, brandName: w.brand.name });
}

export async function editImages({ prompt, sources, mask, model, n = 1, size, quality, title, role, useStyle = false, style, brand, approved = false, source = 'web', provider = 'auto' }) {
  if (!prompt?.trim()) throw new Error('prompt wajib diisi');
  if (!sources?.length) throw new Error('minimal satu gambar sumber');
  const w = withStyle(prompt, useStyle, brand, style);
  const r = await withFallback({
    kind: 'edit', source, provider, model: model || w.model || undefined, fallbackModels: w.fallbackModels, n, approved,
    call: (m, est) => kenari.edit({ model: m, prompt: w.prompt, images: sources, mask, n: est.n, size, quality }),
    kieCall: (m, est) => kie.edit({ model: m, prompt: w.prompt, images: sources, n: est.n, perImageCredits: est.creditsPerImage }), // mask tidak didukung kie
  });
  return finish(r, { kind: 'edit', prompt, finalPrompt: w.prompt, title, role, size, source, style: w.used.join(' + ') || null, brand: w.brand.slug, brandName: w.brand.name });
}
