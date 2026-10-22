// Bộ tính toán báo cáo kho. Mọi số liệu tính từ dữ liệu đã gộp theo ngày + kho + SKU.
// Nguyên tắc: tồn tính ở cấp kho + SKU trước, sau đó mới cộng dồn theo bộ lọc.

import { CONFIG } from '../config.js';

const DAY_MS = 86400000;

export function isoOf(day0Ms, d) {
  return new Date(day0Ms + d * DAY_MS).toISOString().slice(0, 10);
}

export function buildModel(raw) {
  const day0Ms = Date.parse(`${raw.dataFrom}T00:00:00Z`);
  const dayOf = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - day0Ms) / DAY_MS);
  const N = dayOf(raw.dataTo) + 1;

  const countries = raw.countries.map(([code, currency]) => ({ code, currency }));
  const warehouses = raw.warehouses.map(([id, name, country]) => ({ id, name, country }));
  const excludedKeys = new Set(CONFIG.excludedSkus.map((e) => `${e.country}|${e.sku}`));
  const skus = raw.skus.map(([country, sku, name, retail, lastImport]) => ({
    country, sku, name, retail, lastImport, excluded: excludedKeys.has(`${country}|${sku}`),
  }));

  // Nhóm lý do: chỉ số nhóm cho từng mã
  const reasons = CONFIG.reasonOrder;
  const reasonIdx = (r) => {
    const g = CONFIG.reasonGroups[r] ?? CONFIG.unknownReason;
    const i = reasons.indexOf(g);
    return i >= 0 ? i : reasons.indexOf(CONFIG.unknownReason);
  };
  const salesIdx = reasons.indexOf(CONFIG.salesReason);

  // Cặp kho + SKU
  const pairIndex = new Map();
  const pairs = [];
  const pairOf = (w, k) => {
    const key = w * 100000 + k;
    let pi = pairIndex.get(key);
    if (pi === undefined) {
      pi = pairs.length;
      pairIndex.set(key, pi);
      pairs.push({ w, k, country: warehouses[w].country });
    }
    return pi;
  };

  const mv = raw.mv;
  const n = mv.d.length;
  const rows = { d: new Int32Array(n), p: new Int32Array(n), g: new Int8Array(n), iq: new Float64Array(n), eq: new Float64Array(n), iv: new Float64Array(n), ev: new Float64Array(n) };
  let kept = 0;
  const excludedQty = { rows: 0, qty: 0 };
  for (let i = 0; i < n; i++) {
    if (skus[mv.k[i]].excluded) {
      excludedQty.rows++;
      excludedQty.qty += mv.iq[i] - mv.eq[i];
      continue;
    }
    rows.d[kept] = mv.d[i];
    rows.p[kept] = pairOf(mv.w[i], mv.k[i]);
    rows.g[kept] = reasonIdx(mv.r[i]);
    rows.iq[kept] = mv.iq[i];
    rows.eq[kept] = mv.eq[i];
    rows.iv[kept] = mv.iv[i] || 0;
    rows.ev[kept] = mv.ev[i] || 0;
    kept++;
  }
  for (const key of Object.keys(rows)) rows[key] = rows[key].subarray(0, kept);
  rows.length = kept;

  const P = pairs.length;
  const closing = Array.from({ length: P }, () => new Float64Array(N));
  const salesPrefix = Array.from({ length: P }, () => new Float64Array(N + 1));
  const actPrefix = Array.from({ length: P }, () => new Int32Array(N + 1));
  const cost = Array.from({ length: P }, () => new Float64Array(N));
  const sales = Array.from({ length: P }, () => new Float64Array(N));
  const active = Array.from({ length: P }, () => new Uint8Array(N));

  for (let i = 0; i < rows.length; i++) {
    const p = rows.p[i], d = rows.d[i];
    closing[p][d] += rows.iq[i] - rows.eq[i];
    active[p][d] = 1;
    if (rows.g[i] === salesIdx) sales[p][d] += rows.eq[i] - rows.iq[i];
  }
  for (let p = 0; p < P; p++) {
    const c = closing[p], s = sales[p], sp = salesPrefix[p], a = active[p], ap = actPrefix[p];
    for (let d = 0; d < N; d++) {
      if (d > 0) c[d] += c[d - 1];
      sp[d + 1] = sp[d] + s[d];
      ap[d + 1] = ap[d] + a[d];
    }
  }

  // Giá vốn cuối ngày: lấp tiến, ngày trước giá đầu tiên dùng giá đầu tiên
  const costSet = Array.from({ length: P }, () => new Uint8Array(N));
  for (let i = 0; i < raw.cost.d.length; i++) {
    const pi = pairIndex.get(raw.cost.w[i] * 100000 + raw.cost.k[i]);
    if (pi === undefined) continue;
    cost[pi][raw.cost.d[i]] = raw.cost.cp[i] || 0;
    costSet[pi][raw.cost.d[i]] = 1;
  }
  for (let p = 0; p < P; p++) fillSeries(cost[p], costSet[p]);

  // Tỷ giá về VND theo thị trường
  const fx = {};
  const fxSet = {};
  for (const c of countries) { fx[c.code] = new Float64Array(N); fxSet[c.code] = new Uint8Array(N); }
  for (const [c, d, rate] of raw.fx) {
    if (fx[c] && d >= 0 && d < N && rate) { fx[c][d] = rate; fxSet[c][d] = 1; }
  }
  const fxMissing = [];
  for (const c of countries) {
    if (!fxSet[c.code].some(Boolean)) fxMissing.push(c.code);
    fillSeries(fx[c.code], fxSet[c.code], 1);
  }

  const snap = new Map();
  for (const [w, k, remain, actual] of raw.snap) {
    const pi = pairIndex.get(w * 100000 + k);
    if (pi !== undefined) snap.set(pi, { remain, actual });
  }

  return {
    raw, N, day0Ms, dayOf, iso: (d) => isoOf(day0Ms, d),
    countries, warehouses, skus, reasons, salesIdx, pairs, rows,
    closing, sales, salesPrefix, actPrefix, cost, fx, fxMissing, snap, excludedQty,
  };
}

function fillSeries(arr, isSet, fallback = 0) {
  let first = -1;
  for (let d = 0; d < arr.length; d++) if (isSet[d]) { first = d; break; }
  if (first < 0) { arr.fill(fallback); return; }
  for (let d = 0; d < first; d++) arr[d] = arr[first];
  for (let d = first + 1; d < arr.length; d++) if (!isSet[d]) arr[d] = arr[d - 1];
}

// ---------- Phạm vi lọc ----------

export function resolveCurrency(m, f) {
  if (f.currency === 'LOCAL' && f.countries.size === 1) {
    const code = [...f.countries][0];
    return { local: true, code: m.countries.find((c) => c.code === code)?.currency || code };
  }
  return { local: false, code: 'VND' };
}

function priceFactor(m, cur) {
  return cur.local ? () => 1 : (country, d) => m.fx[country][d];
}

export function scopePairs(m, f) {
  const q = f.q.trim().toLowerCase();
  const out = [];
  for (let p = 0; p < m.pairs.length; p++) {
    const pr = m.pairs[p];
    if (!f.countries.has(pr.country)) continue;
    if (!f.warehouses.has(pr.w)) continue;
    if (q) {
      const s = m.skus[pr.k];
      if (!s.sku.toLowerCase().includes(q) && !(s.name || '').toLowerCase().includes(q)) continue;
    }
    out.push(p);
  }
  return out;
}

// ---------- Chỉ số theo SKU (cộng các kho trong phạm vi) ----------

export function skuMetrics(m, f, pairIds) {
  const cur = resolveCurrency(m, f);
  const pf = priceFactor(m, cur);
  const { from, to } = f;
  const adsFrom = Math.max(0, to - CONFIG.adsDays + 1);
  const actFrom = Math.max(0, to - CONFIG.activeDays + 1);
  const bySku = new Map();

  for (const p of pairIds) {
    const pr = m.pairs[p];
    let s = bySku.get(pr.k);
    if (!s) {
      s = {
        k: pr.k, country: pr.country, sku: m.skus[pr.k].sku, name: m.skus[pr.k].name,
        pairs: [], open: 0, close: 0, physical: 0, preorder: 0, value: 0, sales30: 0,
        im: 0, ex: 0, active: false, lastSale: -1, snapRemain: null, snapActual: null, preorderPairs: 0,
      };
      bySku.set(pr.k, s);
    }
    const c = m.closing[p];
    const close = c[to];
    s.pairs.push(p);
    s.open += from > 0 ? c[from - 1] : 0;
    s.close += close;
    if (close > 0) s.physical += close; else if (close < 0) { s.preorder += -close; s.preorderPairs++; }
    s.value += Math.max(close, 0) * m.cost[p][to] * pf(pr.country, to);
    s.sales30 += m.salesPrefix[p][to + 1] - m.salesPrefix[p][adsFrom];
    if (close !== 0 || m.actPrefix[p][to + 1] - m.actPrefix[p][actFrom] > 0) s.active = true;
    const sl = m.sales[p];
    for (let d = to; d >= 0; d--) if (sl[d] > 0) { if (d > s.lastSale) s.lastSale = d; break; }
    const sn = m.snap.get(p);
    if (sn) { s.snapRemain = (s.snapRemain || 0) + sn.remain; s.snapActual = (s.snapActual || 0) + sn.actual; }
  }

  // Nhập / xuất trong kỳ (mọi lý do – để đối soát tồn đầu + nhập − xuất = tồn cuối)
  const inScope = new Uint8Array(m.pairs.length);
  for (const p of pairIds) inScope[p] = 1;
  const r = m.rows;
  for (let i = 0; i < r.length; i++) {
    const d = r.d[i];
    if (d < from || d > to || !inScope[r.p[i]]) continue;
    const s = bySku.get(m.pairs[r.p[i]].k);
    s.im += r.iq[i];
    s.ex += r.eq[i];
  }

  const list = [...bySku.values()];
  for (const s of list) {
    s.ads = s.sales30 > 0 ? s.sales30 / CONFIG.adsDays : 0;
    s.doh = s.close > 0 && s.ads > 0 ? s.close / s.ads : null;
    s.status = classifyStatus(s);
  }
  assignSpeed(list);
  return { list, cur };
}

function classifyStatus(s) {
  if (s.close < 0) return 'Âm (pre-order)';
  if (s.close === 0) return 'Hết hàng';
  if (s.sales30 <= 0) return 'Không luân chuyển';
  if (s.doh < CONFIG.lowDoh) return 'Sắp hết';
  if (s.doh <= CONFIG.highDoh) return 'Bình thường';
  return 'Dư thừa';
}

// Pareto theo đóng góp sản lượng bán 30 ngày, xếp hạng trong từng thị trường.
// SKU đồng hạng sắp theo mã SKU; SKU có phần lũy kế trước nó < ngưỡng thì thuộc nhóm đó.
function assignSpeed(list) {
  const byCountry = new Map();
  for (const s of list) {
    if (s.sales30 <= 0) { s.speed = 'Không bán được'; s.share = 0; continue; }
    if (!byCountry.has(s.country)) byCountry.set(s.country, []);
    byCountry.get(s.country).push(s);
  }
  for (const group of byCountry.values()) {
    group.sort((a, b) => b.sales30 - a.sales30 || a.sku.localeCompare(b.sku));
    const total = group.reduce((t, s) => t + s.sales30, 0);
    let cum = 0;
    for (const s of group) {
      const before = cum / total;
      cum += s.sales30;
      s.share = s.sales30 / total;
      s.speed = before < CONFIG.paretoA ? 'Bán chạy' : before < CONFIG.paretoB ? 'Bán ổn định' : 'Bán chậm';
    }
  }
}

// Áp bộ lọc phân khúc (trạng thái / tốc độ bán) – thu hẹp tập SKU, không đổi cách tính tồn.
export function applySegment(f, list) {
  return list.filter((s) => (!f.statuses.size || f.statuses.has(s.status)) && (!f.speeds.size || f.speeds.has(s.speed)));
}

// ---------- Chuỗi thời gian ----------

export function buildBuckets(m, f) {
  const out = [];
  let d = f.from;
  while (d <= f.to) {
    const start = d;
    let end;
    if (f.gran === 'day') end = d;
    else if (f.gran === 'week') {
      const dow = (new Date(m.day0Ms + d * DAY_MS).getUTCDay() + 6) % 7; // Thứ 2 = 0
      end = d + (6 - dow);
    } else {
      const dt = new Date(m.day0Ms + d * DAY_MS);
      const last = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0);
      end = Math.round((last - m.day0Ms) / DAY_MS);
    }
    end = Math.min(end, f.to);
    out.push({ start, end, label: bucketLabel(m, f.gran, start) });
    d = end + 1;
  }
  return out;
}

function bucketLabel(m, gran, start) {
  const iso = m.iso(start);
  const [y, mo, da] = iso.split('-');
  if (gran === 'month') return `${mo}/${y}`;
  if (gran === 'week') return `Tuần ${da}/${mo}`;
  return `${da}/${mo}`;
}

export function timeSeries(m, f, pairIds) {
  const cur = resolveCurrency(m, f);
  const pf = priceFactor(m, cur);
  const buckets = buildBuckets(m, f);
  const R = m.reasons.length;
  const dayToBucket = new Int32Array(m.N).fill(-1);
  buckets.forEach((b, i) => { for (let d = b.start; d <= b.end; d++) dayToBucket[d] = i; });

  const series = buckets.map((b) => ({
    ...b, open: 0, close: 0, closeValue: 0, im: 0, ex: 0, imValue: 0, exValue: 0,
    imBy: new Float64Array(R), exBy: new Float64Array(R), imValBy: new Float64Array(R), exValBy: new Float64Array(R),
  }));
  for (const p of pairIds) {
    const pr = m.pairs[p], c = m.closing[p];
    for (const s of series) {
      s.open += s.start > 0 ? c[s.start - 1] : 0;
      s.close += c[s.end];
      s.closeValue += Math.max(c[s.end], 0) * m.cost[p][s.end] * pf(pr.country, s.end);
    }
  }
  const inScope = new Uint8Array(m.pairs.length);
  for (const p of pairIds) inScope[p] = 1;
  const r = m.rows;
  for (let i = 0; i < r.length; i++) {
    const b = r.d[i] >= f.from && r.d[i] <= f.to ? dayToBucket[r.d[i]] : -1;
    if (b < 0 || !inScope[r.p[i]]) continue;
    const s = series[b], g = r.g[i];
    const k = pf(m.pairs[r.p[i]].country, r.d[i]);
    s.im += r.iq[i]; s.ex += r.eq[i];
    s.imBy[g] += r.iq[i]; s.exBy[g] += r.eq[i];
    s.imValue += r.iv[i] * k; s.exValue += r.ev[i] * k;
    s.imValBy[g] += r.iv[i] * k; s.exValBy[g] += r.ev[i] * k;
  }
  return { series, cur };
}

// ---------- Hiệu quả tồn kho ----------

// Vòng quay = Giá vốn hàng bán trong kỳ / Giá trị tồn bình quân ngày.
// DOH (theo giá trị) = Giá trị tồn bình quân / Giá vốn bán bình quân mỗi ngày.
export function efficiency(m, f, pairIds) {
  const cur = resolveCurrency(m, f);
  const pf = priceFactor(m, cur);
  const days = f.to - f.from + 1;
  let cogs = 0, valueSum = 0, qtySum = 0, salesQty = 0, open = 0, imNonSales = 0, countLoss = 0;
  const kiemKe = m.reasons.indexOf('Kiểm kê');
  for (const p of pairIds) {
    const pr = m.pairs[p], c = m.closing[p], s = m.sales[p], cp = m.cost[p];
    open += f.from > 0 ? c[f.from - 1] : 0;
    for (let d = f.from; d <= f.to; d++) {
      const k = cp[d] * pf(pr.country, d);
      cogs += s[d] * k;
      salesQty += s[d];
      const phys = Math.max(c[d], 0);
      valueSum += phys * k;
      qtySum += phys;
    }
  }
  // Hao hụt kiểm kê: cộng phần giảm ròng của từng kho + SKU (kho dư không bù kho thiếu)
  const inScope = new Uint8Array(m.pairs.length);
  for (const p of pairIds) inScope[p] = 1;
  const lossByPair = new Map();
  const r = m.rows;
  for (let i = 0; i < r.length; i++) {
    if (r.d[i] < f.from || r.d[i] > f.to || !inScope[r.p[i]]) continue;
    if (r.g[i] !== m.salesIdx) imNonSales += r.iq[i];
    if (r.g[i] === kiemKe) lossByPair.set(r.p[i], (lossByPair.get(r.p[i]) || 0) + r.eq[i] - r.iq[i]);
  }
  for (const loss of lossByPair.values()) if (loss > 0) countLoss += loss;
  const avgValue = valueSum / days;
  const avgQty = qtySum / days;
  const sellBase = open + imNonSales;
  return {
    cur, days, cogs, avgValue, avgQty, salesQty,
    turnover: cogs > 0 && avgValue > 0 ? cogs / avgValue : null,
    dohValue: cogs > 0 ? avgValue / (cogs / days) : null,
    sellThrough: sellBase > 0 ? salesQty / sellBase : null,
    shrinkQty: Math.max(countLoss, 0),
    shrinkRate: avgQty > 0 ? Math.max(countLoss, 0) / avgQty : null,
  };
}

// ---------- Chi tiết 1 SKU ----------

export function skuDetail(m, f, s) {
  const cur = resolveCurrency(m, f);
  const pf = priceFactor(m, cur);
  const adsFrom = Math.max(0, f.to - CONFIG.adsDays + 1);
  const perWarehouse = s.pairs.map((p) => {
    const pr = m.pairs[p], c = m.closing[p];
    const sn = m.snap.get(p);
    return {
      warehouse: m.warehouses[pr.w].name,
      close: c[f.to],
      cost: m.cost[p][f.to] * pf(pr.country, f.to),
      value: Math.max(c[f.to], 0) * m.cost[p][f.to] * pf(pr.country, f.to),
      sales30: m.salesPrefix[p][f.to + 1] - m.salesPrefix[p][adsFrom],
      snapRemain: sn?.remain ?? null,
      snapActual: sn?.actual ?? null,
    };
  });
  const daily = [];
  for (let d = f.from; d <= f.to; d++) {
    let q = 0;
    for (const p of s.pairs) q += m.closing[p][d];
    daily.push({ d, q });
  }
  const R = m.reasons.length;
  const imBy = new Float64Array(R), exBy = new Float64Array(R);
  const set = new Set(s.pairs);
  const r = m.rows;
  for (let i = 0; i < r.length; i++) {
    if (r.d[i] < f.from || r.d[i] > f.to || !set.has(r.p[i])) continue;
    imBy[r.g[i]] += r.iq[i];
    exBy[r.g[i]] += r.eq[i];
  }
  return { cur, perWarehouse, daily, imBy, exBy };
}
