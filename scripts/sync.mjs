// Đồng bộ dữ liệu kho từ BigQuery -> site/data/data.enc.json (đã mã hóa bằng mật khẩu).
//
// Biến môi trường:
//   GOOGLE_APPLICATION_CREDENTIALS  đường dẫn file JSON của service account (bắt buộc)
//   GCP_PROJECT_ID                  project chạy truy vấn (mặc định: hv-data)
//   BQ_LOCATION                     vị trí dataset (mặc định: asia-southeast1)
//   BQ_TABLE                        bảng nguồn (mặc định: hv-data.a_data_mart_sales.FactInventory)
//   DASHBOARD_PASSWORD              mật khẩu mở báo cáo; thiếu thì dừng, không xuất dữ liệu trần
//
// Chạy: npm run sync

import { BigQuery } from '@google-cloud/bigquery';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ID = process.env.GCP_PROJECT_ID || 'hv-data';
const LOCATION = process.env.BQ_LOCATION || 'asia-southeast1';
const TABLE = process.env.BQ_TABLE || 'hv-data.a_data_mart_sales.FactInventory';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const PBKDF2_ITERATIONS = 310000;

// Đơn vị tiền theo thị trường (theo mdm_prod_dwh.markets)
const CURRENCY = { VN: 'VND', ID: 'IDR', TH: 'THB', PH: 'PHP', CAM: 'USD', ML: 'MYR' };

if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(TABLE)) {
  fail(`BQ_TABLE không hợp lệ: ${TABLE}`);
}
if (!PASSWORD) {
  fail('Thiếu DASHBOARD_PASSWORD – dừng để không xuất dữ liệu kho ra trang công khai mà không mã hóa.');
}

const bigquery = new BigQuery({ projectId: PROJECT_ID, location: LOCATION });

function fail(message) {
  console.error(`[sync] LỖI: ${message}`);
  process.exit(1);
}

async function runSql(file) {
  const query = readFileSync(join(ROOT, 'sql', file), 'utf8').replaceAll('{{TABLE}}', TABLE);
  const started = Date.now();
  const [rows] = await bigquery.query({ query, location: LOCATION, useLegacySql: false });
  console.log(`[sync] ${file}: ${rows.length} dòng (${Date.now() - started} ms)`);
  return rows;
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

function dayIndexer(day0) {
  const base = Date.parse(`${day0}T00:00:00Z`);
  return (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - base) / 86400000);
}

function encrypt(plain, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 1,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    compression: 'gzip',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: body.toString('base64'),
  };
}

async function main() {
  const [meta] = await runSql('export_meta.sql');
  const [dims, movements, costs, fx, snapshot] = await Promise.all([
    runSql('export_dims.sql'),
    runSql('export_movements.sql'),
    runSql('export_cost.sql'),
    runSql('export_fx.sql'),
    runSql('export_snapshot.sql'),
  ]);

  const dayOf = dayIndexer(meta.data_from);

  // Danh mục: kho và SKU, đánh chỉ số để nén dữ liệu
  const warehouses = [];
  const whIndex = new Map();
  const skus = [];
  const skuIndex = new Map();
  for (const r of dims) {
    if (r.kind === 'warehouse') {
      whIndex.set(r.w, warehouses.length);
      warehouses.push([r.w, r.name, r.c]);
    } else {
      skuIndex.set(`${r.c}|${r.k}`, skus.length);
      skus.push([r.c, r.k, r.name, num(r.retail_price), num(r.last_imported_price)]);
    }
  }

  const ref = (r) => {
    const w = whIndex.get(r.w);
    const k = skuIndex.get(`${r.c}|${r.k}`);
    if (w === undefined || k === undefined) fail(`Không tìm thấy kho/SKU trong danh mục: ${r.c} ${r.w} ${r.k}`);
    return [w, k];
  };

  const mv = { d: [], w: [], k: [], r: [], iq: [], eq: [], iv: [], ev: [] };
  for (const r of movements) {
    const [w, k] = ref(r);
    mv.d.push(dayOf(r.d));
    mv.w.push(w);
    mv.k.push(k);
    mv.r.push(num(r.r));
    mv.iq.push(num(r.iq));
    mv.eq.push(num(r.eq));
    mv.iv.push(num(r.iv));
    mv.ev.push(num(r.ev));
  }

  const cost = { d: [], w: [], k: [], cp: [] };
  for (const r of costs) {
    const [w, k] = ref(r);
    cost.d.push(dayOf(r.d));
    cost.w.push(w);
    cost.k.push(k);
    cost.cp.push(num(r.cp));
  }

  const snap = [];
  for (const r of snapshot) {
    const w = whIndex.get(r.w);
    const k = skuIndex.get(`${r.c}|${r.k}`);
    if (w === undefined || k === undefined) continue; // chỉ giữ kho + SKU có trong báo cáo
    snap.push([w, k, num(r.remain), num(r.actual)]);
  }

  const countries = [...new Set(warehouses.map((w) => w[2]))].sort();
  const payload = {
    v: 1,
    generatedAt: new Date().toISOString(),
    source: TABLE,
    dataFrom: meta.data_from,
    dataTo: meta.data_to,
    lastTxnAt: meta.last_txn_at,
    excluded: {
      rowsNotInCatalog: num(meta.rows_not_in_catalog),
      rowsComposite: num(meta.rows_composite),
      qtyNotInCatalog: num(meta.qty_not_in_catalog),
    },
    countries: countries.map((c) => [c, CURRENCY[c] || c]),
    warehouses,
    skus,
    mv,
    cost,
    fx: fx.map((r) => [r.c, dayOf(r.d), num(r.fx)]),
    snap,
  };

  const plain = gzipSync(Buffer.from(JSON.stringify(payload)));
  const out = join(ROOT, 'site', 'data', 'data.enc.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(encrypt(plain, PASSWORD)));
  console.log(`[sync] Đã ghi ${out} (${(plain.length / 1024).toFixed(0)} KB nén, ${movements.length} dòng biến động)`);
}

main().catch((err) => {
  // Không in chi tiết có thể chứa thông tin xác thực
  fail(err?.errors?.[0]?.message || err?.message || 'Lỗi không xác định khi truy vấn BigQuery');
});
