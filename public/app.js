const $ = (s) => document.querySelector(s);
const SIZES = [['Feed 4:5', '1024x1280'], ['Persegi', '1024x1024'], ['Story 9:16', '1024x1792'], ['Thumbnail 16:9', '1792x1024']];
const TITLES = { dash: 'Dashboard', gen: 'Generate', edit: 'Edit gambar', gal: 'Galeri', budget: 'Batas Biaya', style: 'Style Guide', mcp: 'Koneksi MCP' };
const OK = 'mt-3 text-sm text-success', ERR = 'mt-3 text-sm text-danger', PLAIN = 'mt-3 text-sm';
let cfg, models = [], editSource = null, current = null;

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const tokenGet = () => store.get('tk'); // hanya untuk server lama tanpa login
const tq = () => (tokenGet() ? `?token=${encodeURIComponent(tokenGet())}` : '');
const rp = (n) => (n === null || n === undefined ? '?' : 'Rp' + Math.round(n).toLocaleString('id-ID'));
const limitText = (n) => (n > 0 ? rp(n) : 'tanpa batas');
const fileUrl = (e) => `${location.origin}/files/${encodeURIComponent(e.file)}`;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (tokenGet()) headers.Authorization = `Bearer ${tokenGet()}`;
  const res = await fetch(`/api${path}`, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.loginRequired) { location.replace('/login'); throw new Error('Perlu login'); }
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return body;
}
async function copy(text, msgEl, okText = 'URL disalin') {
  try { await navigator.clipboard.writeText(text); msgEl.textContent = okText; }
  catch { window.prompt('Salin manual:', text); }
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
  if (page === 'budget') loadBudget();
}

/* ---------- galeri: grid gambar + nama file + URL ---------- */
function tile(e) {
  const el = document.createElement('div');
  el.className = 'overflow-hidden rounded-xl border border-stroke bg-white shadow-card dark:border-strokedark dark:bg-boxdark';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'block w-full'; btn.onclick = () => openLightbox(e);
  const img = document.createElement('img');
  img.loading = 'lazy'; img.src = `/files/${encodeURIComponent(e.file)}${tq()}`; img.alt = e.prompt || e.file;
  img.className = 'aspect-square w-full bg-graylight object-cover dark:bg-bodydark';
  btn.append(img);
  const name = document.createElement('div');
  name.className = 'line-clamp-2 break-all px-3 pt-2 text-xs font-medium leading-snug text-bodydark dark:text-white'; name.textContent = e.file; name.title = e.file;
  const url = document.createElement('button');
  url.type = 'button'; url.className = 'block w-full px-3 pb-2 pt-1 text-left text-xs text-primary hover:underline';
  url.textContent = 'Salin URL'; url.title = fileUrl(e);
  url.onclick = async () => { try { await navigator.clipboard.writeText(fileUrl(e)); url.textContent = 'URL disalin ✓'; } catch { window.prompt('Salin manual:', fileUrl(e)); } setTimeout(() => (url.textContent = 'Salin URL'), 1500); };
  el.append(btn, name, url);
  return el;
}

function openLightbox(e) {
  current = e;
  $('#lb-name').textContent = e.file;
  $('#lb-url').textContent = fileUrl(e);
  $('#lb-img').src = `/files/${encodeURIComponent(e.file)}${tq()}`;
  const left = e.expiresAt ? Math.max(0, Math.ceil((new Date(e.expiresAt) - Date.now()) / 86400000)) : null;
  $('#lb-meta').textContent = `${e.model} · ${rp(e.costIdr)}${left !== null ? ` · dihapus permanen ${left} hari lagi` : ''}`;
  $('#lb-prompt').textContent = e.prompt ? `Prompt: ${e.prompt}` : '';
  $('#lb-dl').href = `/files/${encodeURIComponent(e.file)}${tq()}`; $('#lb-dl').download = e.file;
  $('#lb-msg').textContent = '';
  $('#lb').classList.remove('hidden'); $('#lb').classList.add('flex');
}
function closeLightbox() { $('#lb').classList.add('hidden'); $('#lb').classList.remove('flex'); }

function pickEdit(e) {
  editSource = { sourceId: e.id, label: e.file };
  $('#e-src').textContent = `Sumber: ${e.file}`;
  closeLightbox();
  location.hash = '#edit';
}

/* ---------- data ---------- */
function bar(id, spent, limit) {
  const el = $(id); const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  el.style.width = `${pct}%`;
  el.className = `h-2 rounded-full ${pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-primary'}`;
}
async function refreshConfig() {
  cfg = await api('/config');
  $('#budget-pill').textContent = `${rp(cfg.spentTodayIdr)} / ${limitText(cfg.dailyBudgetIdr)} hari ini`;
  if (cfg.user) { $('#who').textContent = cfg.user; $('#logout').classList.remove('hidden'); }
  document.querySelectorAll('.maxn').forEach((x) => (x.textContent = cfg.maxN));
  const base = cfg.publicUrlSet ? new URL(location.href).origin : location.origin;
  const has = Boolean(cfg.mcpPathSecret);
  $('#mcp-url-wrap').classList.toggle('hidden', !has);
  $('#mcp-url-off').classList.toggle('hidden', has);
  if (has) $('#mcp-url').textContent = `${base}/mcp/${cfg.mcpPathSecret}`;
}

async function loadDash() {
  await refreshConfig().catch(() => {});
  if (!cfg) return;
  for (const [k, spent, limit, label] of [['today', cfg.spentTodayIdr, cfg.dailyBudgetIdr, 'batas harian'], ['week', cfg.spentWeekIdr, cfg.weeklyBudgetIdr, 'batas mingguan'], ['month', cfg.spentMonthIdr, cfg.monthlyBudgetIdr, 'batas bulanan']]) {
    $(`#st-${k}`).textContent = rp(spent);
    $(`#st-${k}-l`).textContent = `${label}: ${limitText(limit)}`;
    bar(`#bar-${k}`, spent, limit);
  }
  $('#st-key').textContent = cfg.hasApiKey ? 'API key kenari terisi' : 'KENARI_API_KEY belum diisi';
  $('#st-key').className = `mt-1 text-xs ${cfg.hasApiKey ? 'text-success' : 'text-danger'}`;
  $('#st-retention').textContent = `Gambar sementara: dihapus permanen otomatis setelah ${cfg.retentionDays} hari. Unduh yang masih dipakai.`;
  const items = await api('/gallery?limit=200');
  $('#st-count').textContent = items.length;
  $('#dash-grid').replaceChildren(...items.slice(0, 5).map(tile));
  if (!items.length) $('#dash-grid').textContent = 'Belum ada gambar. Mulai dari menu Generate.';
}

async function loadBudget() {
  await refreshConfig();
  const { settings } = await api('/settings');
  $('#s-daily').value = settings.dailyBudgetIdr; $('#s-weekly').value = settings.weeklyBudgetIdr; $('#s-monthly').value = settings.monthlyBudgetIdr;
  $('#s-approval').value = settings.approvalThresholdIdr; $('#s-maxn').value = settings.maxN;
  const rows = [['Hari ini', cfg.spentTodayIdr, cfg.dailyBudgetIdr], [`Minggu ini (sejak ${cfg.weekStart})`, cfg.spentWeekIdr, cfg.weeklyBudgetIdr], [`Bulan ini (sejak ${cfg.monthStart})`, cfg.spentMonthIdr, cfg.monthlyBudgetIdr]];
  $('#usage-list').replaceChildren(...rows.map(([label, spent, limit]) => {
    const d = document.createElement('div');
    const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
    d.innerHTML = '<div class="flex justify-between"><span></span><span class="font-medium text-bodydark dark:text-white"></span></div><div class="mt-2 h-2 overflow-hidden rounded-full bg-graylight dark:bg-bodydark"><div class="h-2 rounded-full bg-primary"></div></div>';
    d.querySelector('span').textContent = label;
    d.querySelectorAll('span')[1].textContent = `${rp(spent)} / ${limitText(limit)}`;
    const b = d.querySelector('.bg-primary'); b.style.width = `${pct}%`; if (pct >= 90) b.className = 'h-2 rounded-full bg-danger'; else if (pct >= 70) b.className = 'h-2 rounded-full bg-warning';
    return d;
  }));
  $('#budget-key').textContent = cfg.hasApiKey ? 'API key kenari: terisi.' : 'API key kenari belum diisi (KENARI_API_KEY di .env server).';
}

async function estimate(prefix) {
  const model = $(`#${prefix}-model`).value, n = $(`#${prefix}-n`).value || 1;
  if (!model) return;
  try {
    const e = await api(`/estimate?model=${encodeURIComponent(model)}&n=${n}`);
    const sisa = [e.remainingTodayIdr, e.remainingWeekIdr, e.remainingMonthIdr].filter((v) => v !== null);
    $(`#${prefix}-est`).textContent = `Estimasi: ${e.n} × ${rp(e.pricePerImageIdr)} = ${rp(e.totalIdr)}. ` + (sisa.length ? `Sisa budget terendah ${rp(Math.min(...sisa))}.` : 'Tanpa batas budget.') + (e.needsApproval ? ' Butuh persetujuan Owner (melewati ambang).' : '');
    $(`#${prefix}-appr-wrap`).hidden = !e.needsApproval;
  } catch (err) { $(`#${prefix}-est`).textContent = err.message; }
}

async function run(prefix, path, payload, outId) {
  const btn = $(`#${prefix}-go`), msg = $(`#${prefix}-msg`);
  btn.disabled = true; msg.className = PLAIN; msg.textContent = 'Memproses… bisa sampai beberapa menit.';
  try {
    const r = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    msg.className = OK; msg.textContent = `Selesai. ${r.images.length} gambar, biaya ${rp(r.costIdr)}. Tersimpan di Galeri.`;
    $(outId).replaceChildren(...r.images.map(tile));
    if ($('#g-empty')) $('#g-empty').hidden = true;
  } catch (e) { msg.className = ERR; msg.textContent = e.message; }
  finally { btn.disabled = false; refreshConfig().catch(() => {}); estimate(prefix); }
}

async function loadGallery() {
  const items = await api(`/gallery?q=${encodeURIComponent($('#q').value)}`);
  $('#gal-grid').replaceChildren(...items.map(tile));
  if (!items.length) $('#gal-grid').textContent = 'Belum ada gambar.';
}

/* ---------- init ---------- */
async function init() {
  $('#burger').onclick = () => setSidebar(true);
  $('#scrim').onclick = () => setSidebar(false);
  $('#theme').onclick = () => { const d = document.documentElement.classList.toggle('dark'); store.set('theme', d ? 'dark' : 'light'); };
  $('#logout').onclick = async () => { await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); location.replace('/login'); };
  $('#token').value = tokenGet();
  $('#mcp-url-copy').onclick = () => copy($('#mcp-url').textContent, $('#mcp-url-msg'), 'URL konektor disalin');
  $('#mcp-http').textContent = `claude mcp add --transport http teman-seller-studio ${location.origin}/mcp --header "Authorization: Bearer <ACCESS_TOKEN>"`;
  $('#token-save').onclick = () => { store.set('tk', $('#token').value); location.reload(); };
  window.addEventListener('hashchange', route);
  $('#lb-close').onclick = closeLightbox;
  $('#lb').onclick = (ev) => { if (ev.target === $('#lb')) closeLightbox(); };
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeLightbox(); });
  $('#lb-edit').onclick = () => pickEdit(current);
  $('#lb-copy').onclick = () => copy(fileUrl(current), $('#lb-msg'));
  $('#lb-share').onclick = async () => {
    try { const r = await api('/share', { method: 'POST', body: JSON.stringify({ id: current.id, ttlMinutes: 60 }) }); await copy(r.url, $('#lb-msg'), `Tautan publik disalin (berlaku sampai ${new Date(r.expiresAt).toLocaleString('id-ID')})`); }
    catch (err) { $('#lb-msg').textContent = err.message; }
  };

  try { await refreshConfig(); } catch (e) {
    if (e.status === 401) { location.hash = '#mcp'; route(); $('#budget-pill').textContent = 'Token diperlukan'; }
    else { $('#budget-pill').textContent = e.message; }
    if (!cfg) return;
  }
  models = await api('/models').catch(() => []);
  for (const sel of ['#g-model', '#e-model']) {
    $(sel).replaceChildren(...models.map((m) => Object.assign(document.createElement('option'), { value: m.id, textContent: `${m.name} (${m.pricePerImageIdr === 0 ? 'gratis' : rp(m.pricePerImageIdr)})` })));
    $(sel).value = cfg.defaultModel;
  }
  $('#g-sizes').replaceChildren(...SIZES.map(([l, v]) => Object.assign(document.createElement('button'), {
    type: 'button', className: 'rounded-full border border-stroke px-3 py-1 text-xs text-bodydark hover:border-primary hover:text-primary dark:border-strokedark dark:text-white',
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

  $('#budget-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = $('#budget-msg');
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify({ dailyBudgetIdr: Number($('#s-daily').value), weeklyBudgetIdr: Number($('#s-weekly').value), monthlyBudgetIdr: Number($('#s-monthly').value), approvalThresholdIdr: Number($('#s-approval').value), maxN: Number($('#s-maxn').value) }) });
      msg.className = OK; msg.textContent = 'Batas biaya tersimpan dan langsung berlaku.'; await loadBudget(); estimate('g'); estimate('e');
    } catch (e) { msg.className = ERR; msg.textContent = e.message; }
  };
  $('#budget-reset').onclick = async () => {
    const { defaults } = await api('/settings');
    await api('/settings', { method: 'PUT', body: JSON.stringify(defaults) });
    $('#budget-msg').className = OK; $('#budget-msg').textContent = 'Dikembalikan ke nilai awal dari .env.'; await loadBudget();
  };
  route();
}
init();
