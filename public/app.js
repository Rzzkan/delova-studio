const $ = (s) => document.querySelector(s);
const SIZES = [['Feed 4:5', '1024x1280'], ['Persegi', '1024x1024'], ['Story 9:16', '1024x1792'], ['Thumbnail 16:9', '1792x1024']];
let cfg, models = [], editSource = null;
const tokenGet = () => { try { return sessionStorage.getItem('tk') || localStorage.getItem('tk') || ''; } catch { return ''; } };
const tq = () => (tokenGet() ? `?token=${encodeURIComponent(tokenGet())}` : '');

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (tokenGet()) headers.Authorization = `Bearer ${tokenGet()}`;
  const res = await fetch(`/api${path}`, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const rp = (n) => (n === null || n === undefined ? '?' : 'Rp' + Math.round(n).toLocaleString('id-ID'));

function tabs() {
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.setAttribute('aria-selected', x === b));
    document.querySelectorAll('section').forEach((s) => s.classList.toggle('on', s.id === b.dataset.tab));
    if (b.dataset.tab === 'gal') loadGallery();
  }));
}

function tile(e, { edit = true } = {}) {
  const el = document.createElement('div');
  el.className = 'tile';
  const src = `/files/${encodeURIComponent(e.file)}${tq()}`;
  el.innerHTML = `<a href="${src}" target="_blank"><img loading="lazy" alt=""></a><div></div><div class="acts"></div>`;
  el.querySelector('img').src = src;
  el.querySelector('img').alt = e.prompt || e.file;
  el.children[1].textContent = `${e.file} · ${e.model} · ${rp(e.costIdr)}`;
  const acts = el.querySelector('.acts');
  const dl = document.createElement('a'); dl.textContent = 'Unduh'; dl.href = src; dl.download = e.file; acts.append(dl);
  if (edit) { const b = document.createElement('button'); b.textContent = 'Edit'; b.onclick = () => pickEdit(e); acts.append(b); }
  return el;
}

function pickEdit(e) {
  editSource = { sourceId: e.id, label: e.file };
  $('#e-src').textContent = `Sumber: ${e.file}`;
  document.querySelector('[data-tab=edit]').click();
}

async function refreshBudget() {
  cfg = await api('/config');
  $('#budget').textContent = `Terpakai hari ini ${rp(cfg.spentTodayIdr)} / batas ${rp(cfg.dailyBudgetIdr)}`;
  if (!cfg.hasApiKey) $('#budget').textContent += ' · KENARI_API_KEY belum diisi';
}

async function estimate(prefix) {
  const model = $(`#${prefix}-model`).value, n = $(`#${prefix}-n`).value || 1;
  if (!model) return;
  try {
    const e = await api(`/estimate?model=${encodeURIComponent(model)}&n=${n}`);
    const box = $(`#${prefix}-est`);
    box.textContent = `Estimasi: ${e.n} × ${rp(e.pricePerImageIdr)} = ${rp(e.totalIdr)}. Sisa budget hari ini ${rp(e.remainingTodayIdr)}.` + (e.needsApproval ? ' Butuh persetujuan Owner (melewati ambang).' : '');
    box.classList.toggle('warn', e.needsApproval);
    $(`#${prefix}-appr-wrap`).hidden = !e.needsApproval;
  } catch (err) { $(`#${prefix}-est`).textContent = err.message; }
}

async function run(prefix, path, payload, outId) {
  const btn = $(`#${prefix}-go`), msg = $(`#${prefix}-msg`);
  btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Memproses… bisa sampai beberapa menit.';
  try {
    const r = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    msg.className = 'msg ok'; msg.textContent = `Selesai. ${r.images.length} gambar, biaya ${rp(r.costIdr)}. Tersimpan di Galeri.`;
    const out = $(outId); out.replaceChildren(...r.images.map((e) => tile(e)));
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
  finally { btn.disabled = false; refreshBudget(); estimate(prefix); }
}

async function loadGallery() {
  const items = await api(`/gallery?q=${encodeURIComponent($('#q').value)}`);
  $('#gal-grid').replaceChildren(...items.map((e) => tile(e)));
  if (!items.length) $('#gal-grid').textContent = 'Belum ada gambar.';
}

async function init() {
  tabs();
  $('#token').value = tokenGet();
  $('#mcp-http').textContent = `claude mcp add --transport http teman-seller-studio ${location.origin}/mcp --header "Authorization: Bearer <ACCESS_TOKEN>"`;
  $('#token-save').onclick = () => { try { localStorage.setItem('tk', $('#token').value); } catch {} location.reload(); };
  try { await refreshBudget(); } catch (e) {
    $('#budget').textContent = e.status === 401 ? 'Token diperlukan: isi di tab Style & MCP' : e.message;
    if (e.status === 401) return;
  }
  document.querySelectorAll('.maxn').forEach((x) => (x.textContent = cfg.maxN));
  models = await api('/models').catch(() => []);
  for (const sel of ['#g-model', '#e-model']) {
    $(sel).replaceChildren(...models.map((m) => Object.assign(document.createElement('option'), { value: m.id, textContent: `${m.name} (${m.pricePerImageIdr === 0 ? 'gratis' : rp(m.pricePerImageIdr)})` })));
    $(sel).value = cfg.defaultModel;
  }
  $('#g-sizes').replaceChildren(...SIZES.map(([l, v]) => Object.assign(document.createElement('button'), { className: 'chip', textContent: `${l} ${v}`, onclick: () => ($('#g-size').value = v) })));
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
    if (!editSource) { $('#e-msg').className = 'msg err'; $('#e-msg').textContent = 'Pilih gambar sumber dulu.'; return; }
    run('e', '/edit', { prompt: $('#e-prompt').value, model: $('#e-model').value, n: Number($('#e-n').value) || 1, title: $('#e-title').value || undefined,
      sourceId: editSource.sourceId, imageBase64: editSource.imageBase64, approved: $('#e-appr').checked }, '#e-out');
  };
  $('#q').oninput = () => loadGallery();
  $('#style').value = (await api('/style')).style;
  $('#style-save').onclick = async () => { await api('/style', { method: 'PUT', body: JSON.stringify({ style: $('#style').value }) }); $('#style-msg').className = 'msg ok'; $('#style-msg').textContent = 'Tersimpan.'; };
}
init();
