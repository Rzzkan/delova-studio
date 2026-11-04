const $ = (s) => document.querySelector(s);
const SIZES = [['Feed 4:5', '1024x1280'], ['Persegi', '1024x1024'], ['Story 9:16', '1024x1792'], ['Thumbnail 16:9', '1792x1024']];
const TITLES = { dash: 'Dashboard', gen: 'Generate', edit: 'Edit gambar', gal: 'Galeri', style: 'Style Guide', mcp: 'Koneksi MCP' };
const OK = 'mt-3 text-sm text-success', ERR = 'mt-3 text-sm text-danger', PLAIN = 'mt-3 text-sm';
let cfg, models = [], editSource = null;

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const tokenGet = () => store.get('tk');
const tq = () => (tokenGet() ? `?token=${encodeURIComponent(tokenGet())}` : '');
const rp = (n) => (n === null || n === undefined ? '?' : 'Rp' + Math.round(n).toLocaleString('id-ID'));

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (tokenGet()) headers.Authorization = `Bearer ${tokenGet()}`;
  const res = await fetch(`/api${path}`, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return body;
}

/* ---------- layout ---------- */
function setSidebar(open) {
  $('#sidebar').classList.toggle('-translate-x-full', !open);
  $('#scrim').classList.toggle('hidden', !open);
}
function route() {
  const page = TITLES[location.hash.slice(1)] ? location.hash.slice(1) : 'dash';
  document.querySelectorAll('[data-page]').forEach((s) => (s.hidden = s.dataset.page !== page));
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  $('#page-title').textContent = TITLES[page];
  setSidebar(false);
  if (page === 'gal') loadGallery();
  if (page === 'dash') loadDash();
}

/* ---------- komponen ---------- */
function tile(e, { edit = true } = {}) {
  const el = document.createElement('div');
  el.className = 'overflow-hidden rounded-xl border border-stroke bg-white shadow-card dark:border-strokedark dark:bg-boxdark';
  const src = `/files/${encodeURIComponent(e.file)}${tq()}`;
  const a = document.createElement('a'); a.href = src; a.target = '_blank';
  const img = document.createElement('img'); img.loading = 'lazy'; img.src = src; img.alt = e.prompt || e.file;
  img.className = 'aspect-square w-full bg-graylight object-cover dark:bg-bodydark';
  a.append(img);
  const info = document.createElement('div'); info.className = 'truncate px-3 pt-2 text-xs'; const left = e.expiresAt ? Math.max(0, Math.ceil((new Date(e.expiresAt) - Date.now()) / 86400000)) : null;
  info.textContent = `${e.model} · ${rp(e.costIdr)}` + (left !== null ? ` · hapus ${left}h lagi` : '');
  info.title = e.file;
  const acts = document.createElement('div'); acts.className = 'flex gap-2 px-3 pb-3 pt-2';
  const btnCls = 'rounded-md border border-stroke px-2 py-1 text-xs text-bodydark hover:bg-graylight dark:border-strokedark dark:text-white dark:hover:bg-bodydark';
  const dl = document.createElement('a'); dl.textContent = 'Unduh'; dl.href = src; dl.download = e.file; dl.className = btnCls; acts.append(dl);
  if (edit) { const b = document.createElement('button'); b.textContent = 'Edit'; b.className = btnCls; b.onclick = () => pickEdit(e); acts.append(b); }
  el.append(a, info, acts);
  return el;
}

function pickEdit(e) {
  editSource = { sourceId: e.id, label: e.file };
  $('#e-src').textContent = `Sumber: ${e.file}`;
  location.hash = '#edit';
}

/* ---------- data ---------- */
async function refreshBudget() {
  cfg = await api('/config');
  $('#budget-pill').textContent = `${rp(cfg.spentTodayIdr)} / ${rp(cfg.dailyBudgetIdr)} hari ini`;
  $('#budget-pill').classList.remove('hidden');
}

async function loadDash() {
  if (!cfg) return;
  const left = Math.max(0, cfg.dailyBudgetIdr - cfg.spentTodayIdr);
  $('#st-spent').textContent = rp(cfg.spentTodayIdr);
  $('#st-budget').textContent = `batas harian ${rp(cfg.dailyBudgetIdr)}`;
  $('#st-left').textContent = rp(left);
  $('#st-bar').style.width = `${Math.min(100, Math.round((cfg.spentTodayIdr / (cfg.dailyBudgetIdr || 1)) * 100))}%`;
  $('#st-models').textContent = models.length || '-';
  $('#st-key').textContent = cfg.hasApiKey ? 'API key terisi' : 'KENARI_API_KEY belum diisi';
  $('#st-key').className = `mt-1 text-xs ${cfg.hasApiKey ? 'text-success' : 'text-danger'}`;
  const items = await api('/gallery?limit=200');
  $('#st-count').textContent = items.length;
  $('#dash-grid').replaceChildren(...items.slice(0, 6).map((e) => tile(e)));
  if (!items.length) $('#dash-grid').textContent = 'Belum ada gambar. Mulai dari menu Generate.';
  $('#st-retention').textContent = `Gambar sementara: dihapus permanen otomatis setelah ${cfg.retentionDays} hari. Unduh yang masih dipakai.`;
}

async function estimate(prefix) {
  const model = $(`#${prefix}-model`).value, n = $(`#${prefix}-n`).value || 1;
  if (!model) return;
  try {
    const e = await api(`/estimate?model=${encodeURIComponent(model)}&n=${n}`);
    $(`#${prefix}-est`).textContent = `Estimasi: ${e.n} × ${rp(e.pricePerImageIdr)} = ${rp(e.totalIdr)}. Sisa budget hari ini ${rp(e.remainingTodayIdr)}.` + (e.needsApproval ? ' Butuh persetujuan Owner (melewati ambang).' : '');
    $(`#${prefix}-appr-wrap`).hidden = !e.needsApproval;
  } catch (err) { $(`#${prefix}-est`).textContent = err.message; }
}

async function run(prefix, path, payload, outId) {
  const btn = $(`#${prefix}-go`), msg = $(`#${prefix}-msg`);
  btn.disabled = true; msg.className = PLAIN; msg.textContent = 'Memproses… bisa sampai beberapa menit.';
  try {
    const r = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    msg.className = OK; msg.textContent = `Selesai. ${r.images.length} gambar, biaya ${rp(r.costIdr)}. Tersimpan di Galeri.`;
    $(outId).replaceChildren(...r.images.map((e) => tile(e)));
    if ($('#g-empty')) $('#g-empty').hidden = true;
  } catch (e) { msg.className = ERR; msg.textContent = e.message; }
  finally { btn.disabled = false; refreshBudget(); estimate(prefix); }
}

async function loadGallery() {
  const items = await api(`/gallery?q=${encodeURIComponent($('#q').value)}`);
  $('#gal-grid').replaceChildren(...items.map((e) => tile(e)));
  if (!items.length) $('#gal-grid').textContent = 'Belum ada gambar.';
}

/* ---------- init ---------- */
async function init() {
  $('#burger').onclick = () => setSidebar(true);
  $('#scrim').onclick = () => setSidebar(false);
  $('#theme').onclick = () => { const d = document.documentElement.classList.toggle('dark'); store.set('theme', d ? 'dark' : 'light'); };
  $('#token').value = tokenGet();
  $('#mcp-http').textContent = `claude mcp add --transport http teman-seller-studio ${location.origin}/mcp --header "Authorization: Bearer <ACCESS_TOKEN>"`;
  $('#token-save').onclick = () => { store.set('tk', $('#token').value); location.reload(); };
  window.addEventListener('hashchange', route);

  try { await refreshBudget(); } catch (e) {
    if (e.status === 401) { location.hash = '#mcp'; route(); $('#budget-pill').textContent = 'Token diperlukan'; $('#budget-pill').classList.remove('hidden'); return; }
    $('#budget-pill').textContent = e.message; $('#budget-pill').classList.remove('hidden');
  }
  document.querySelectorAll('.maxn').forEach((x) => (x.textContent = cfg.maxN));
  models = await api('/models').catch(() => []);
  for (const sel of ['#g-model', '#e-model']) {
    $(sel).replaceChildren(...models.map((m) => Object.assign(document.createElement('option'), { value: m.id, textContent: `${m.name} (${m.pricePerImageIdr === 0 ? 'gratis' : rp(m.pricePerImageIdr)})` })));
    $(sel).value = cfg.defaultModel;
  }
  $('#g-sizes').replaceChildren(...SIZES.map(([l, v]) => Object.assign(document.createElement('button'), {
    className: 'rounded-full border border-stroke px-3 py-1 text-xs text-bodydark hover:border-primary hover:text-primary dark:border-strokedark dark:text-white',
    textContent: `${l} ${v}`, onclick: () => ($('#g-size').value = v),
  })));
  for (const p of ['g', 'e']) { $(`#${p}-model`).onchange = () => estimate(p); $(`#${p}-n`).oninput = () => estimate(p); estimate(p); }
  $('#g-go').onclick = () => run('g', '/generate', {
    prompt: $('#g-prompt').value, model: $('#g-model').value, n: Number($('#g-n').value) || 1, size: $('#g-size').value || undefined,
    title: $('#g-title').value || undefined, background: $('#g-opaque').checked ? 'transparent' : undefined, useStyle: $('#g-style').checked, approved: $('#g-appr').checked,
  }, '#g-out');
  $('#g-five').onclick = () => { $('#g-n').value = Math.min(5, cfg.maxN); estimate('g'); };
  $('#e-file').onchange = async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    editSource = { imageBase64: data, label: f.name }; $('#e-src').textContent = `Sumber: ${f.name}`;
  };
  $('#e-go').onclick = () => {
    if (!editSource) { $('#e-msg').className = ERR; $('#e-msg').textContent = 'Pilih gambar sumber dulu.'; return; }
    run('e', '/edit', { prompt: $('#e-prompt').value, model: $('#e-model').value, n: Number($('#e-n').value) || 1, title: $('#e-title').value || undefined,
      sourceId: editSource.sourceId, imageBase64: editSource.imageBase64, approved: $('#e-appr').checked }, '#e-out');
  };
  $('#q').oninput = () => loadGallery();
  $('#style').value = (await api('/style')).style;
  $('#style-save').onclick = async () => { await api('/style', { method: 'PUT', body: JSON.stringify({ style: $('#style').value }) }); $('#style-msg').className = OK; $('#style-msg').textContent = 'Tersimpan.'; };
  route();
}
init();
