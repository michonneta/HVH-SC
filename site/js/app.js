import { CONFIG } from '../config.js';
import { decryptPayload } from './crypto.js';
import { buildModel, scopePairs, skuMetrics, applySegment, timeSeries, efficiency, skuDetail, resolveCurrency } from './model.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf0 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
const nfc = new Intl.NumberFormat('vi-VN', { notation: 'compact', maximumFractionDigits: 1 });
const qty = (v) => nf0.format(Math.round(v));
const pct = (v) => (v === null || !isFinite(v) ? na() : `${nf1.format(v * 100)}%`);
const na = (t = 'Chưa đủ dữ liệu') => `<span class="na">${t}</span>`;
const money = (v, cur, compact = false) => {
  if (v === null || !isFinite(v)) return na();
  const f = compact ? nfc : cur.code === 'VND' || cur.code === 'IDR' ? nf0 : nf2;
  return `${f.format(v)} ${esc(cur.code)}`;
};

const STATUS_CLASS = { 'Âm (pre-order)': 'bad', 'Hết hàng': 'bad', 'Sắp hết': 'warn', 'Dư thừa': 'warn', 'Không luân chuyển': 'warn', 'Bình thường': 'good' };
const REASON_COLORS = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#64748b', '#0891b2', '#db2777', '#a3a3a3'];

let M = null;           // mô hình dữ liệu
let F = null;           // trạng thái bộ lọc
let tab = 'overview';
let charts = [];
let skuSort = { key: 'value', dir: -1 };
let skuPage = 0;

// ---------------- Khởi động ----------------

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Không tải được dữ liệu (${res.status}).`);
  return res.json();
}

async function start() {
  const form = $('#login-form');
  let envelope;
  try {
    envelope = await fetchJson('data/data.enc.json');
    if (!envelope) {
      // Chế độ chạy thử trên máy: dữ liệu chưa mã hóa (không bao giờ được đưa lên GitHub)
      const plain = await fetchJson('data/data.json');
      if (plain) return openApp(plain);
      $('#login-msg').textContent = 'Chưa có dữ liệu. Hãy chạy đồng bộ (GitHub Actions) trước.';
      return;
    }
  } catch (err) {
    $('#login-msg').textContent = err.message;
    return;
  }
  $('#login-msg').textContent = '';
  $('#login-btn').disabled = false;

  const unlock = async (password, remember) => {
    $('#login-btn').disabled = true;
    $('#login-msg').textContent = 'Đang giải mã…';
    try {
      const raw = await decryptPayload(envelope, password);
      if (remember) try { sessionStorage.setItem('kho-pw', password); } catch { /* bỏ qua */ }
      openApp(raw);
    } catch (err) {
      try { sessionStorage.removeItem('kho-pw'); } catch { /* bỏ qua */ }
      $('#login-msg').textContent = err.code === 'BAD_PASSWORD' ? 'Sai mật khẩu.' : `Lỗi: ${err.message}`;
      $('#login-btn').disabled = false;
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    unlock($('#password').value, $('#remember').checked);
  });
  let saved = null;
  try { saved = sessionStorage.getItem('kho-pw'); } catch { /* bỏ qua */ }
  if (saved) unlock(saved, true);
}

function openApp(raw) {
  try {
    M = buildModel(raw);
  } catch (err) {
    $('#login-msg').textContent = `Dữ liệu không hợp lệ: ${err.message}`;
    return;
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  const synced = new Date(raw.generatedAt).toLocaleString('vi-VN');
  const lastTxn = raw.lastTxnAt ? new Date(raw.lastTxnAt).toLocaleString('vi-VN') : raw.dataTo;
  $('#freshness').textContent = `Giao dịch mới nhất: ${lastTxn} · Đồng bộ lúc: ${synced} · Tồn = tồn có thể bán theo kho`;
  initFilters();
  try { tab = localStorage.getItem('kho-tab') || 'overview'; } catch { /* bỏ qua */ }
  setTab(tab);
}

// ---------------- Bộ lọc ----------------

function defaultFilters() {
  const to = M.N - 1;
  return {
    from: Math.max(0, to - 89),
    to,
    gran: 'week',
    countries: new Set(M.countries.map((c) => c.code)),
    warehouses: new Set(M.warehouses.map((_, i) => i)),
    q: '',
    statuses: new Set(),
    speeds: new Set(),
    reasons: new Set(M.reasons.map((_, i) => i)),
    currency: 'VND',
  };
}

function initFilters() {
  F = defaultFilters();
  const minIso = M.iso(0), maxIso = M.iso(M.N - 1);
  for (const id of ['#f-from', '#f-to']) { $(id).min = minIso; $(id).max = maxIso; }
  $('#f-from').addEventListener('change', (e) => { F.from = clampDay(e.target.value, 0); if (F.from > F.to) F.to = F.from; refresh(); });
  $('#f-to').addEventListener('change', (e) => { F.to = clampDay(e.target.value, M.N - 1); if (F.to < F.from) F.from = F.to; refresh(); });
  $('#f-gran').addEventListener('change', (e) => { F.gran = e.target.value; refresh(); });
  $('#f-currency').addEventListener('change', (e) => { F.currency = e.target.value; refresh(); });
  let timer;
  $('#f-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { F.q = e.target.value; skuPage = 0; refresh(); }, 250); });
  $('#f-reset').addEventListener('click', () => { F = defaultFilters(); $('#f-q').value = ''; skuPage = 0; refresh(); });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.multi[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });
}

function clampDay(iso, fallback) {
  if (!iso) return fallback;
  return Math.min(M.N - 1, Math.max(0, M.dayOf(iso)));
}

function renderFilterControls() {
  $('#f-from').value = M.iso(F.from);
  $('#f-to').value = M.iso(F.to);
  $('#f-gran').value = F.gran;
  $('#f-currency').value = F.currency;

  multi($('#f-countries'), 'Thị trường', M.countries.map((c) => ({ value: c.code, label: c.code })), F.countries, (set) => {
    F.countries = set;
    F.warehouses = new Set(M.warehouses.map((w, i) => (set.has(w.country) ? i : -1)).filter((i) => i >= 0));
  });
  multi($('#f-warehouses'), 'Kho',
    M.warehouses.map((w, i) => ({ value: i, label: `${w.country} · ${w.name}` })).filter((o) => F.countries.has(M.warehouses[o.value].country)),
    F.warehouses, (set) => { F.warehouses = set; });
  multi($('#f-statuses'), 'Trạng thái tồn', CONFIG.statusOrder.map((s) => ({ value: s, label: s })), F.statuses,
    (set) => { F.statuses = set; }, 'Trống = tất cả. Thu hẹp tập SKU, không đổi cách tính tồn.');
  multi($('#f-speeds'), 'Tốc độ bán', CONFIG.speedOrder.map((s) => ({ value: s, label: s })), F.speeds,
    (set) => { F.speeds = set; }, 'Trống = tất cả. Thu hẹp tập SKU, không đổi cách tính tồn.');
  multi($('#f-reasons'), 'Lý do nhập/xuất', M.reasons.map((r, i) => ({ value: i, label: r })), F.reasons,
    (set) => { F.reasons = set; }, 'Chỉ dùng cho phân tích nhập/xuất. Không làm thay đổi số tồn.');
}

function multi(container, label, options, selected, onChange, hint) {
  const all = options.length;
  const count = options.filter((o) => selected.has(o.value)).length;
  const summary = count === 0 || count === all ? 'Tất cả' : count === 1 ? options.find((o) => selected.has(o.value)).label : `${count} đã chọn`;
  const wasOpen = container.querySelector('details')?.open;
  container.innerHTML = `
    <span>${esc(label)}</span>
    <details class="multi"${wasOpen ? ' open' : ''}>
      <summary>${esc(summary)}</summary>
      <div class="menu">
        <div class="menu-actions"><button type="button" class="ghost" data-act="all">Chọn tất cả</button><button type="button" class="ghost" data-act="none">Bỏ chọn</button></div>
        ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
        ${options.map((o, i) => `<label><input type="checkbox" data-i="${i}"${selected.has(o.value) ? ' checked' : ''}> ${esc(o.label)}</label>`).join('')}
      </div>
    </details>`;
  container.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => {
    const set = new Set(selected);
    const v = options[Number(cb.dataset.i)].value;
    if (cb.checked) set.add(v); else set.delete(v);
    onChange(set); skuPage = 0; refresh();
  }));
  container.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    onChange(b.dataset.act === 'all' ? new Set(options.map((o) => o.value)) : new Set());
    skuPage = 0; refresh();
  }));
}

// ---------------- Tính toán theo bộ lọc ----------------

function compute() {
  const pairs = scopePairs(M, F);
  const { list, cur } = skuMetrics(M, F, pairs);
  const segment = applySegment(F, list);
  const segPairs = segment.flatMap((s) => s.pairs);
  return { pairs, list, segment, segPairs, cur };
}

function setTab(name) {
  tab = name;
  try { localStorage.setItem('kho-tab', name); } catch { /* bỏ qua */ }
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  refresh();
}

function refresh() {
  renderFilterControls();
  charts.forEach((c) => c.destroy());
  charts = [];
  const view = $('#view');
  try {
    const ctx = compute();
    const segNote = F.statuses.size || F.speeds.size ? ' · Đang lọc theo nhóm SKU (trạng thái/tốc độ tại ngày cuối kỳ).' : '';
    const curNote = F.currency === 'LOCAL' && F.countries.size !== 1 ? ' · Tiền địa phương chỉ dùng khi chọn 1 thị trường – đang hiển thị VND.' : '';
    $('#scope-note').textContent = `Kỳ: ${fmtDate(F.from)} – ${fmtDate(F.to)} (${F.to - F.from + 1} ngày) · ${ctx.segment.length} SKU · Tiền tệ: ${ctx.cur.code}${segNote}${curNote}`;
    if (!ctx.pairs.length) { view.innerHTML = '<div class="card empty">Không có dữ liệu trong phạm vi lọc.</div>'; return; }
    const pages = { overview, flow, sku: skuTab, risk, notes };
    (pages[tab] || overview)(view, ctx);
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="card error">Lỗi khi tính báo cáo: ${esc(err.message)}</div>`;
  }
}

const fmtDate = (d) => M.iso(d).split('-').reverse().join('/');

// ---------------- Biểu đồ ----------------

const textColor = () => getComputedStyle(document.documentElement).getPropertyValue('--text').trim();

function chart(canvas, config) {
  if (!window.Chart) { canvas.parentElement.innerHTML = '<div class="empty">Không tải được thư viện biểu đồ.</div>'; return; }
  const style = getComputedStyle(document.documentElement);
  Chart.defaults.color = style.getPropertyValue('--muted').trim();
  Chart.defaults.borderColor = style.getPropertyValue('--border').trim();
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const c = new Chart(canvas, { ...config, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, ...config.options } });
  charts.push(c);
}

// ---------------- Trang 1: Tổng quan ----------------

function statusCounts(list) {
  const c = Object.fromEntries(CONFIG.statusOrder.map((s) => [s, 0]));
  for (const s of list) c[s.status]++;
  return c;
}

function overview(view, ctx) {
  const { segment, segPairs, cur } = ctx;
  const active = segment.filter((s) => s.active);
  const counts = statusCounts(active);
  const oos = counts['Hết hàng'] + counts['Âm (pre-order)'];
  const stock = segment.reduce((t, s) => t + s.close, 0);
  const physical = segment.reduce((t, s) => t + s.physical, 0);
  const preorder = segment.reduce((t, s) => t + s.preorder, 0);
  const preorderPairs = segment.reduce((t, s) => t + s.preorderPairs, 0);
  const value = segment.reduce((t, s) => t + s.value, 0);
  const ads = segment.reduce((t, s) => t + s.ads, 0);
  const eff = efficiency(M, F, segPairs);
  const isToday = F.to === M.N - 1;
  const snapActual = segment.reduce((t, s) => t + (s.snapActual || 0), 0);
  const snapRemain = segment.reduce((t, s) => t + (s.snapRemain || 0), 0);

  view.innerHTML = `
    <div class="kpis">
      ${kpi('Tổng SKU đang quản lý', qty(active.length), `${segment.length} SKU trong phạm vi lọc`)}
      ${kpi('Tồn cuối kỳ (có thể bán)', qty(stock), `Hàng có trong kho ${qty(physical)} · Pre-order ${qty(preorder)}`)}
      ${kpi('Giá trị tồn cuối kỳ', money(value, cur, true), 'Theo giá vốn bình quân')}
      ${kpi('SKU hết hàng', qty(oos), `Tỷ lệ ${pct(active.length ? oos / active.length : null)} · gồm ${counts['Âm (pre-order)']} SKU âm`, 'Hết hàng,Âm (pre-order)')}
      ${kpi('SKU sắp hết', qty(counts['Sắp hết']), `DOH < ${CONFIG.lowDoh} ngày`, 'Sắp hết')}
      ${kpi('SKU dư thừa', qty(counts['Dư thừa']), `DOH > ${CONFIG.highDoh} ngày`, 'Dư thừa')}
      ${kpi('SKU không luân chuyển', qty(counts['Không luân chuyển']), `Không bán trong ${CONFIG.adsDays} ngày, còn tồn`, 'Không luân chuyển')}
      ${kpi('Vòng quay tồn kho (kỳ)', eff.turnover === null ? na() : `${nf2.format(eff.turnover)} lần`, 'Giá vốn bán / Giá trị tồn bình quân')}
      ${kpi('DOH theo giá trị', eff.dohValue === null ? na() : `${nf0.format(eff.dohValue)} ngày`, 'Tồn bình quân / Giá vốn bán mỗi ngày')}
      ${kpi('DOH theo số lượng', ads > 0 && stock > 0 ? `${nf0.format(stock / ads)} ngày` : na(), `Tồn cuối / ADS ${CONFIG.adsDays} ngày`)}
      ${kpi('Tỷ trọng kho+SKU pre-order', pct(segPairs.length ? preorderPairs / segPairs.length : null), `${preorderPairs} / ${segPairs.length} kho+SKU`)}
      ${isToday ? kpi('Tồn thực tế hiện tại (Pancake)', qty(snapActual), `Đang chờ giao: ${qty(snapActual - snapRemain)}`) : ''}
    </div>
    <div class="grid-2">
      <div class="card"><h2>Xu hướng tồn kho</h2><div class="chart-box"><canvas id="c-trend"></canvas></div></div>
      <div class="card"><h2>Phân bố trạng thái tồn (SKU)</h2><div class="chart-box"><canvas id="c-status"></canvas></div></div>
    </div>
    <div class="card">
      <h2>SKU cần chú ý</h2>
      <p class="muted small">Âm/hết hàng/sắp hết và còn bán được trong ${CONFIG.adsDays} ngày – sắp theo ADS giảm dần.</p>
      ${skuMiniTable(active.filter((s) => ['Âm (pre-order)', 'Hết hàng', 'Sắp hết'].includes(s.status) && s.sales30 > 0).sort((a, b) => b.ads - a.ads).slice(0, 15), cur)}
    </div>`;
  bindKpiLinks(view);
  bindSkuRows(view, segment);

  const { series } = timeSeries(M, F, segPairs);
  chart($('#c-trend'), {
    data: {
      labels: series.map((s) => s.label),
      datasets: [
        { type: 'bar', label: 'Tồn cuối (SL)', data: series.map((s) => s.close), backgroundColor: '#93b4f5', yAxisID: 'y' },
        { type: 'line', label: `Giá trị tồn (${cur.code})`, data: series.map((s) => s.closeValue), borderColor: '#d97706', backgroundColor: '#d97706', yAxisID: 'y1', tension: 0.25 },
      ],
    },
    options: { scales: { y: { position: 'left', title: { display: true, text: 'Số lượng' } }, y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: (v) => nfc.format(v) } } } },
  });
  const sc = statusCounts(active);
  chart($('#c-status'), {
    type: 'doughnut',
    data: { labels: CONFIG.statusOrder, datasets: [{ data: CONFIG.statusOrder.map((s) => sc[s]), backgroundColor: ['#b91c1c', '#ef4444', '#a3a3a3', '#f59e0b', '#16a34a', '#7c3aed'] }] },
    options: { plugins: { legend: { position: 'right' } } },
  });
}

function kpi(label, value, sub, statusLink) {
  return `<div class="kpi${statusLink ? ' link' : ''}"${statusLink ? ` data-status="${esc(statusLink)}" title="Xem danh sách SKU"` : ''}>
    <div class="label">${esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function bindKpiLinks(root) {
  root.querySelectorAll('[data-status]').forEach((el) => el.addEventListener('click', () => {
    F.statuses = new Set(el.dataset.status.split(','));
    F.speeds = new Set();
    skuPage = 0;
    setTab('sku');
  }));
}

function skuMiniTable(list, cur) {
  if (!list.length) return '<div class="empty">Không có SKU nào.</div>';
  return `<div class="table-wrap"><table><thead><tr><th class="l">Thị trường</th><th class="l">SKU</th><th class="l">Tên</th><th>Tồn</th><th>ADS</th><th>DOH</th><th class="l">Trạng thái</th><th>Giá trị tồn</th></tr></thead><tbody>
    ${list.map((s) => `<tr class="clickable" data-k="${s.k}"><td class="l">${esc(s.country)}</td><td class="l">${esc(s.sku)}</td><td class="name" title="${esc(s.name)}">${esc(s.name)}</td>
      <td>${qty(s.close)}</td><td>${nf1.format(s.ads)}</td><td>${s.doh === null ? '–' : nf0.format(s.doh)}</td>
      <td class="l">${statusPill(s.status)}</td><td>${money(s.value, cur)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

const statusPill = (s) => `<span class="pill ${STATUS_CLASS[s] || ''}">${esc(s)}</span>`;

function bindSkuRows(root, list) {
  const byK = new Map(list.map((s) => [s.k, s]));
  root.querySelectorAll('tr[data-k]').forEach((tr) => tr.addEventListener('click', () => openSku(byK.get(Number(tr.dataset.k)))));
}

// ---------------- Trang 2: Nhập xuất tồn ----------------

function flow(view, ctx) {
  const { segPairs, cur } = ctx;
  const { series } = timeSeries(M, F, segPairs);
  const sel = [...F.reasons].sort((a, b) => a - b);
  const tot = series.reduce((t, s) => {
    t.im += s.im; t.ex += s.ex; t.imValue += s.imValue; t.exValue += s.exValue;
    sel.forEach((g) => { t.imBy[g] = (t.imBy[g] || 0) + s.imBy[g]; t.exBy[g] = (t.exBy[g] || 0) + s.exBy[g]; t.imV[g] = (t.imV[g] || 0) + s.imValBy[g]; t.exV[g] = (t.exV[g] || 0) + s.exValBy[g]; });
    return t;
  }, { im: 0, ex: 0, imValue: 0, exValue: 0, imBy: {}, exBy: {}, imV: {}, exV: {} });
  const first = series[0], last = series[series.length - 1];

  view.innerHTML = `
    <div class="card">
      <h2>Nhập – xuất theo lý do</h2>
      <p class="muted small">Cột dương: nhập; cột âm: xuất; đường: tồn cuối. Chỉ hiển thị các lý do đã chọn ở bộ lọc "Lý do nhập/xuất".</p>
      <div class="chart-box tall"><canvas id="c-flow"></canvas></div>
    </div>
    <div class="card">
      <h2>Bảng nhập xuất tồn</h2>
      <p class="muted small">Tồn đầu + Nhập − Xuất = Tồn cuối (mọi lý do, kể cả "Tồn đầu dữ liệu" và "Chênh lệch hệ thống"). Cột "Đối soát" phải bằng 0.</p>
      <div class="table-wrap"><table>
        <thead><tr><th class="l">Kỳ</th><th>Tồn đầu</th><th>Nhập</th><th>Xuất</th><th>Tồn cuối</th><th>Đối soát</th>
          <th>Giá trị nhập</th><th>Giá trị xuất</th><th>Giá trị tồn cuối</th></tr></thead>
        <tbody>${series.map((s) => `<tr><td class="l">${esc(s.label)}</td><td>${qty(s.open)}</td><td>${qty(s.im)}</td><td>${qty(s.ex)}</td><td>${qty(s.close)}</td>
          <td>${qty(s.open + s.im - s.ex - s.close)}</td><td>${money(s.imValue, cur)}</td><td>${money(s.exValue, cur)}</td><td>${money(s.closeValue, cur)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td class="l">Cả kỳ</td><td>${qty(first.open)}</td><td>${qty(tot.im)}</td><td>${qty(tot.ex)}</td><td>${qty(last.close)}</td>
          <td>${qty(first.open + tot.im - tot.ex - last.close)}</td><td>${money(tot.imValue, cur)}</td><td>${money(tot.exValue, cur)}</td><td>${money(last.closeValue, cur)}</td></tr></tfoot>
      </table></div>
    </div>
    <div class="card">
      <h2>Tổng hợp theo lý do (cả kỳ)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th class="l">Lý do</th><th>SL nhập</th><th>SL xuất</th><th>Ròng</th><th>Giá trị nhập</th><th>Giá trị xuất</th></tr></thead>
        <tbody>${sel.map((g) => `<tr><td class="l">${esc(M.reasons[g])}</td><td>${qty(tot.imBy[g])}</td><td>${qty(tot.exBy[g])}</td><td>${qty(tot.imBy[g] - tot.exBy[g])}</td>
          <td>${money(tot.imV[g], cur)}</td><td>${money(tot.exV[g], cur)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Giá trị xuất là số lượng × giá vốn bình quân tại thời điểm xuất – không đồng nghĩa giá vốn hàng bán (chuyển kho, kiểm kê, xuất khác có ý nghĩa khác).</p>
    </div>`;

  chart($('#c-flow'), {
    data: {
      labels: series.map((s) => s.label),
      datasets: [
        ...sel.map((g) => ({ type: 'bar', label: `Nhập · ${M.reasons[g]}`, data: series.map((s) => s.imBy[g]), backgroundColor: REASON_COLORS[g % REASON_COLORS.length], stack: 'in' })),
        ...sel.map((g) => ({ type: 'bar', label: `Xuất · ${M.reasons[g]}`, data: series.map((s) => -s.exBy[g]), backgroundColor: REASON_COLORS[g % REASON_COLORS.length] + '99', stack: 'out' })),
        { type: 'line', label: 'Tồn cuối', data: series.map((s) => s.close), borderColor: textColor(), backgroundColor: textColor(), yAxisID: 'y1', tension: 0.25 },
      ],
    },
    options: {
      scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: 'Nhập (+) / Xuất (−)' } }, y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Tồn cuối' } } },
      plugins: { legend: { labels: { filter: (item, data) => data.datasets[item.datasetIndex].data.some((v) => v !== 0) } } },
    },
  });
}

// ---------------- Trang 3: Phân tích SKU ----------------

const SKU_COLS = [
  { key: 'country', label: 'Thị trường', l: true },
  { key: 'wh', label: 'Kho', l: true },
  { key: 'sku', label: 'SKU', l: true },
  { key: 'name', label: 'Tên sản phẩm', l: true },
  { key: 'open', label: 'Tồn đầu' },
  { key: 'im', label: 'Nhập' },
  { key: 'ex', label: 'Xuất' },
  { key: 'close', label: 'Tồn cuối' },
  { key: 'value', label: 'Giá trị tồn' },
  { key: 'sales30', label: `Bán ${CONFIG.adsDays}N` },
  { key: 'ads', label: 'ADS' },
  { key: 'doh', label: 'DOH (ngày)' },
  { key: 'status', label: 'Trạng thái', l: true },
  { key: 'speed', label: 'Tốc độ bán', l: true },
  { key: 'lastSale', label: 'Bán gần nhất' },
];

function whLabel(s) {
  const names = s.pairs.map((p) => M.warehouses[M.pairs[p].w].name);
  return names.length === 1 ? names[0] : `${names.length} kho`;
}

function skuTab(view, ctx) {
  const { segment, cur } = ctx;
  const rows = segment.map((s) => ({ ...s, wh: whLabel(s) }));
  const { key, dir } = skuSort;
  rows.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
  const pages = Math.max(1, Math.ceil(rows.length / CONFIG.pageSize));
  skuPage = Math.min(skuPage, pages - 1);
  const pageRows = rows.slice(skuPage * CONFIG.pageSize, (skuPage + 1) * CONFIG.pageSize);

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <h2 style="margin:0">Phân tích SKU <span class="muted small">(${rows.length} SKU · tồn cộng các kho đã chọn · trạng thái tại ${fmtDate(F.to)})</span></h2>
        <div class="pager">
          <button class="ghost" id="csv" type="button">Tải CSV</button>
          <button class="ghost" id="prev" type="button"${skuPage === 0 ? ' disabled' : ''}>‹</button>
          <span class="small">Trang ${skuPage + 1}/${pages}</span>
          <button class="ghost" id="next" type="button"${skuPage >= pages - 1 ? ' disabled' : ''}>›</button>
        </div>
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr>${SKU_COLS.map((c) => `<th class="sortable${c.l ? ' l' : ''}" data-key="${c.key}">${esc(c.label)}${skuSort.key === c.key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
        <tbody>${pageRows.map((s) => `<tr class="clickable" data-k="${s.k}">
          <td class="l">${esc(s.country)}</td><td class="l">${esc(s.wh)}</td><td class="l">${esc(s.sku)}</td><td class="name" title="${esc(s.name)}">${esc(s.name)}</td>
          <td>${qty(s.open)}</td><td>${qty(s.im)}</td><td>${qty(s.ex)}</td><td>${qty(s.close)}</td><td>${money(s.value, cur)}</td>
          <td>${qty(s.sales30)}</td><td>${nf1.format(s.ads)}</td><td>${s.doh === null ? '–' : nf0.format(s.doh)}</td>
          <td class="l">${statusPill(s.status)}</td><td class="l">${esc(s.speed)}</td><td>${s.lastSale >= 0 ? fmtDate(s.lastSale) : '–'}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">Không có SKU nào trong phạm vi lọc.</div>'}
      <p class="muted small">DOH = Tồn cuối / ADS (ADS = bán thuần ${CONFIG.adsDays} ngày đến ${fmtDate(F.to)} / ${CONFIG.adsDays}). "–" khi tồn ≤ 0 hoặc không bán.</p>
    </div>`;

  view.querySelectorAll('th[data-key]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.key;
    skuSort = { key: k, dir: skuSort.key === k ? -skuSort.dir : (SKU_COLS.find((c) => c.key === k).l ? 1 : -1) };
    refresh();
  }));
  $('#prev')?.addEventListener('click', () => { skuPage--; refresh(); });
  $('#next')?.addEventListener('click', () => { skuPage++; refresh(); });
  $('#csv')?.addEventListener('click', () => downloadCsv(rows));
  bindSkuRows(view, segment);
}

function downloadCsv(rows) {
  const head = SKU_COLS.map((c) => c.label);
  const lines = rows.map((s) => SKU_COLS.map((c) => {
    let v = s[c.key];
    if (c.key === 'lastSale') v = v >= 0 ? M.iso(v) : '';
    if (typeof v === 'number') v = Math.round(v * 100) / 100;
    return `"${String(v ?? '').replace(/"/g, '""')}"`;
  }).join(','));
  const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `phan-tich-sku_${M.iso(F.to)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function openSku(s) {
  if (!s) return;
  const d = skuDetail(M, F, s);
  const dlg = $('#sku-dialog');
  $('#sku-detail').innerHTML = `
    <div class="toolbar"><div><h2 style="margin:0">${esc(s.sku)}</h2><div class="muted">${esc(s.name)} · ${esc(s.country)}</div></div>
      <button class="ghost" id="close-dlg" type="button">Đóng</button></div>
    <div class="kpis">
      ${kpi('Tồn cuối kỳ', qty(s.close), `Pre-order ${qty(s.preorder)}`)}
      ${kpi('ADS', nf1.format(s.ads), `Bán ${CONFIG.adsDays} ngày: ${qty(s.sales30)}`)}
      ${kpi('DOH', s.doh === null ? '–' : `${nf0.format(s.doh)} ngày`, statusPill(s.status))}
      ${kpi('Tốc độ bán', esc(s.speed), s.share ? `Đóng góp ${pct(s.share)} sản lượng thị trường` : '')}
    </div>
    <div class="card"><h3>Tồn theo ngày (${fmtDate(F.from)} – ${fmtDate(F.to)})</h3><div class="chart-box"><canvas id="c-sku"></canvas></div></div>
    <div class="card"><h3>Theo kho tại ${fmtDate(F.to)}</h3><div class="table-wrap"><table>
      <thead><tr><th class="l">Kho</th><th>Tồn có thể bán</th><th>Bán ${CONFIG.adsDays}N</th><th>Giá vốn</th><th>Giá trị tồn</th><th>Pancake hiện tại: có thể bán / thực tế</th></tr></thead>
      <tbody>${d.perWarehouse.map((w) => `<tr><td class="l">${esc(w.warehouse)}</td><td>${qty(w.close)}</td><td>${qty(w.sales30)}</td><td>${money(w.cost, d.cur)}</td><td>${money(w.value, d.cur)}</td>
        <td>${w.snapActual === null ? '–' : `${qty(w.snapRemain)} / ${qty(w.snapActual)}`}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><h3>Nhập – xuất theo lý do trong kỳ</h3><div class="table-wrap"><table>
      <thead><tr><th class="l">Lý do</th><th>Nhập</th><th>Xuất</th></tr></thead>
      <tbody>${M.reasons.map((r, g) => (d.imBy[g] || d.exBy[g] ? `<tr><td class="l">${esc(r)}</td><td>${qty(d.imBy[g])}</td><td>${qty(d.exBy[g])}</td></tr>` : '')).join('') || '<tr><td class="l" colspan="3">Không có biến động trong kỳ.</td></tr>'}</tbody></table></div></div>`;
  $('#close-dlg').addEventListener('click', () => dlg.close());
  dlg.showModal();
  const old = charts.find((c) => c.canvas?.id === 'c-sku');
  if (old) old.destroy();
  chart($('#c-sku'), {
    type: 'line',
    data: { labels: d.daily.map((x) => fmtDate(x.d)), datasets: [{ label: 'Tồn có thể bán', data: d.daily.map((x) => x.q), borderColor: '#2563eb', backgroundColor: '#2563eb33', fill: true, pointRadius: 0, stepped: true }] },
    options: { plugins: { legend: { display: false } } },
  });
}

// ---------------- Trang 4: Hiệu quả & rủi ro ----------------

function risk(view, ctx) {
  const { segment, segPairs, cur } = ctx;
  const active = segment.filter((s) => s.active);
  const excess = active.filter((s) => s.status === 'Dư thừa');
  const excessValue = excess.reduce((t, s) => t + s.value, 0);
  const overCover = excess.reduce((t, s) => t + (s.close > 0 ? s.value * Math.max(0, 1 - (CONFIG.highDoh * s.ads) / s.close) : 0), 0);
  const nonMoving = active.filter((s) => s.status === 'Không luân chuyển');
  const nonMovingValue = nonMoving.reduce((t, s) => t + s.value, 0);
  const atRisk = active.filter((s) => s.status === 'Sắp hết' || (['Hết hàng', 'Âm (pre-order)'].includes(s.status) && s.sales30 > 0));
  const eff = efficiency(M, F, segPairs);

  const allowed = new Set(segPairs);
  const groupEff = (keyOf, labelOf) => {
    const groups = new Map();
    for (const p of segPairs) {
      const key = keyOf(M.pairs[p]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    return [...groups.entries()].map(([key, ps]) => {
      const e = efficiency(M, F, ps.filter((p) => allowed.has(p)));
      return { label: labelOf(key), ...e };
    }).sort((a, b) => b.avgValue - a.avgValue);
  };
  const byCountry = groupEff((pr) => pr.country, (k) => k);
  const byWarehouse = groupEff((pr) => pr.w, (w) => `${M.warehouses[w].country} · ${M.warehouses[w].name}`);
  const effTable = (rows) => `<div class="table-wrap"><table><thead><tr><th class="l">Phạm vi</th><th>Tồn bình quân (${esc(cur.code)})</th><th>Giá vốn bán</th><th>Vòng quay</th><th>DOH giá trị</th><th>Tỷ lệ bán</th><th>Hao hụt kiểm kê</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td class="l">${esc(r.label)}</td><td>${money(r.avgValue, cur)}</td><td>${money(r.cogs, cur)}</td>
      <td>${r.turnover === null ? na() : nf2.format(r.turnover)}</td><td>${r.dohValue === null ? na() : nf0.format(r.dohValue)}</td><td>${pct(r.sellThrough)}</td><td>${pct(r.shrinkRate)}</td></tr>`).join('')}</tbody></table></div>`;

  view.innerHTML = `
    <div class="kpis">
      ${kpi('Giá trị tồn dư thừa', money(excessValue, cur, true), `${excess.length} SKU · phần vượt ${CONFIG.highDoh} ngày: ${money(overCover, cur, true)}`, 'Dư thừa')}
      ${kpi('Giá trị tồn không luân chuyển', money(nonMovingValue, cur, true), `${nonMoving.length} SKU`, 'Không luân chuyển')}
      ${kpi('SKU có nguy cơ hết hàng', qty(atRisk.length), 'Sắp hết, hoặc đã hết nhưng vẫn có nhu cầu', 'Sắp hết,Hết hàng,Âm (pre-order)')}
      ${kpi('Vòng quay tồn kho (kỳ)', eff.turnover === null ? na() : `${nf2.format(eff.turnover)} lần`, `${eff.days} ngày`)}
      ${kpi('Tỷ lệ bán (sell-through)', pct(eff.sellThrough), 'Bán thuần / (Tồn đầu + Nhập không phải bán hàng)')}
      ${kpi('Tỷ lệ hao hụt kiểm kê', pct(eff.shrinkRate), `Hao hụt ròng ${qty(eff.shrinkQty)} / tồn bình quân ${qty(eff.avgQty)}`)}
    </div>
    <div class="card"><h2>Hiệu quả theo thị trường</h2>${effTable(byCountry)}</div>
    <div class="card"><h2>Hiệu quả theo kho</h2>${effTable(byWarehouse)}</div>
    <div class="grid-2">
      <div class="card"><h2>Top tồn dư thừa (giá trị)</h2>${skuMiniTable(excess.sort((a, b) => b.value - a.value).slice(0, 10), cur)}</div>
      <div class="card"><h2>Top không luân chuyển (giá trị)</h2>${skuMiniTable(nonMoving.sort((a, b) => b.value - a.value).slice(0, 10), cur)}</div>
    </div>
    <div class="card"><h2>SKU có nguy cơ hết hàng</h2>${skuMiniTable(atRisk.sort((a, b) => b.ads - a.ads).slice(0, 20), cur)}</div>
    <p class="muted small">Hao hụt kiểm kê = tổng phần giảm ròng do kiểm kê của từng kho + SKU trong kỳ (kho + SKU kiểm kê dư không bù cho nơi thiếu) / tồn bình quân ngày. Vòng quay chỉ tính trên giá vốn của nhóm "Bán hàng".</p>`;
  bindKpiLinks(view);
  bindSkuRows(view, segment);
}

// ---------------- Ghi chú dữ liệu ----------------

function notes(view) {
  const raw = M.raw;
  const fxMiss = M.fxMissing.length ? `<li class="error">Thiếu tỷ giá cho: ${esc(M.fxMissing.join(', '))} – giá trị VND của các thị trường này tính theo tỷ giá 1.</li>` : '';
  view.innerHTML = `
    <div class="card notes">
      <h2>Nguồn và phạm vi dữ liệu</h2>
      <ul>
        <li>Nguồn: <code>${esc(raw.source)}</code>, dữ liệu từ ${esc(raw.dataFrom)} đến ${esc(raw.dataTo)}; đồng bộ lúc ${esc(new Date(raw.generatedAt).toLocaleString('vi-VN'))}.</li>
        <li>Tồn = <b>tồn có thể bán</b> theo kho (Pancake trừ kho khi tạo đơn). Tồn thực tế hiện tại lấy từ danh mục Pancake, chỉ hiển thị khi "Đến ngày" là ngày mới nhất.</li>
        <li>Chỉ tính hàng thật: mẫu mã còn trong danh mục và không phải combo ghép. Đã loại ${qty(raw.excluded.rowsNotInCatalog)} dòng của mẫu mã đã xóa (tồn ảo ${qty(raw.excluded.qtyNotInCatalog)}) và ${qty(raw.excluded.rowsComposite)} dòng combo ghép.</li>
        <li>SKU loại theo cấu hình (${CONFIG.excludedSkus.map((e) => `${esc(e.country)}/${esc(e.sku)}`).join(', ')}): ${qty(M.excludedQty.rows)} dòng, tồn ${qty(M.excludedQty.qty)}.</li>
        <li>Giá trị = số lượng × giá vốn bình quân (tiền địa phương, TH/PH/ML/CAM đã chia 100) × tỷ giá ngày về VND.</li>
        ${fxMiss}
      </ul>
      <h2>Quy tắc tính</h2>
      <ul>
        <li>Tồn tính ở cấp kho + SKU trước rồi mới cộng theo bộ lọc. Tồn âm = bán pre-order; "Hàng có trong kho" chỉ cộng phần dương.</li>
        <li>ADS = bán thuần ${CONFIG.adsDays} ngày đến ngày cuối kỳ / ${CONFIG.adsDays}. Bán thuần = xuất − nhập của nhóm "${esc(CONFIG.salesReason)}".</li>
        <li>Trạng thái (ưu tiên theo thứ tự): ${CONFIG.statusOrder.map(esc).join(' → ')}. Sắp hết: DOH &lt; ${CONFIG.lowDoh}; Bình thường: ${CONFIG.lowDoh}–${CONFIG.highDoh}; Dư thừa: &gt; ${CONFIG.highDoh}.</li>
        <li>Tốc độ bán: xếp hạng Pareto theo bán thuần ${CONFIG.adsDays} ngày trong từng thị trường; Bán chạy đến ${CONFIG.paretoA * 100}% lũy kế, Bán ổn định đến ${CONFIG.paretoB * 100}%, còn lại Bán chậm; không bán = Không bán được. Tỷ lệ thực tế không bằng tuyệt đối các ngưỡng.</li>
        <li>Tỷ lệ hết hàng: mẫu số = SKU còn tồn hoặc có biến động trong ${CONFIG.activeDays} ngày gần nhất.</li>
        <li>Bộ lọc "Lý do" chỉ dùng cho phân tích nhập/xuất; bộ lọc trạng thái/tốc độ chỉ thu hẹp tập SKU. Không bộ lọc nào thay đổi cách tính tồn của một kho + SKU.</li>
        <li>Quy tắc có thể chỉnh trong <code>site/config.js</code>.</li>
      </ul>
    </div>`;
}

start();
