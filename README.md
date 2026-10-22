# Báo cáo Kho

Webapp theo dõi tồn kho đa thị trường, đa kho. Dữ liệu lấy từ BigQuery
(`hv-data.a_data_mart_sales.FactInventory`), đồng bộ định kỳ bằng GitHub Actions
và host miễn phí trên **GitHub Pages**.

> **Bảo mật:** repo và trang web là công khai, nhưng **dữ liệu kho được mã hóa**
> (AES-256-GCM) bằng mật khẩu. Ai mở trang cũng phải nhập mật khẩu mới xem được số liệu.
> Khóa service account chỉ nằm trong GitHub Secrets, không bao giờ nằm trong code hay trên trang.

## Cách hoạt động

```
GitHub Actions (mỗi 6 giờ / khi đẩy code / bấm tay)
  └─ scripts/sync.mjs ── service account ──▶ BigQuery
       └─ gộp dữ liệu theo ngày + kho + SKU, mã hóa ──▶ site/data/data.enc.json
  └─ triển khai thư mục site/ lên GitHub Pages

Trình duyệt ── nhập mật khẩu ──▶ giải mã ──▶ tính báo cáo ngay trên máy (không gửi dữ liệu đi đâu)
```

Các trang: **Tổng quan**, **Nhập xuất tồn**, **Phân tích SKU**, **Hiệu quả & rủi ro**, **Ghi chú dữ liệu**.

## Cài đặt lần đầu

### 1. Tạo service account (người có quyền trên project `hv-data` làm)

1. Google Cloud Console → **IAM & Admin → Service Accounts → Create service account**, ví dụ tên `bao-cao-kho-reader`.
2. Cấp quyền tối thiểu:
   - **BigQuery Job User** trên project `hv-data` (để chạy truy vấn).
   - **BigQuery Data Viewer** trên các dataset: `a_data_mart_sales`, `a_dwh`, `mdm_prod_dwh`, `pancake_pos_dwh`.
3. Vào service account → **Keys → Add key → JSON**. Lưu file, **không** để file trong thư mục dự án.

### 2. Tạo repo GitHub

1. Tạo repo mới (Public), ví dụ `bao-cao-kho`.
2. Đưa toàn bộ thư mục này lên repo (GitHub Desktop, `git push`, hoặc **Add file → Upload files** trên web).
   File `.gitignore` đã chặn file khóa và dữ liệu sinh ra.

### 3. Khai báo bí mật

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Tên | Giá trị |
|---|---|
| `GCP_SA_KEY` | Toàn bộ nội dung file JSON của service account |
| `DASHBOARD_PASSWORD` | Mật khẩu mở báo cáo (nên ≥ 12 ký tự) |

Tùy chọn (tab **Variables**): `GCP_PROJECT_ID`, `BQ_TABLE`, `BQ_LOCATION` nếu khác mặc định.

### 4. Bật GitHub Pages

Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 5. Chạy lần đầu

Repo → **Actions → "Đồng bộ dữ liệu & triển khai" → Run workflow**. Khi xong, địa chỉ trang có dạng
`https://<tên-tài-khoản>.github.io/bao-cao-kho/`.

## Vận hành

- Dữ liệu tự cập nhật mỗi 6 giờ (sửa lịch ở `.github/workflows/sync-and-deploy.yml`).
- Đổi mật khẩu: sửa secret `DASHBOARD_PASSWORD` rồi chạy lại workflow.
- Đổi quy tắc nghiệp vụ (ngưỡng DOH, Pareto, SKU loại trừ, nhóm lý do): sửa `site/config.js`.
- Mỗi lần đồng bộ quét khoảng vài trăm MB trên BigQuery – nằm trong hạn mức miễn phí hàng tháng với lịch 6 giờ/lần.

## Lưu ý bảo mật

- Mã hóa bằng mật khẩu bảo vệ dữ liệu khỏi người không có mật khẩu, nhưng **không thay thế phân quyền theo tài khoản**:
  ai biết mật khẩu đều xem được toàn bộ. Khi nhân sự nghỉ việc, hãy đổi mật khẩu.
- Code và câu SQL trong repo là công khai (không chứa dữ liệu hay khóa).
- Nếu cần phân quyền theo người dùng, chuyển sang repo riêng tư + hosting có đăng nhập (ví dụ Cloud Run).

## Cấu trúc

```
sql/                     Câu truy vấn xuất dữ liệu (đã gộp) từ BigQuery
scripts/sync.mjs         Chạy truy vấn, đóng gói, mã hóa dữ liệu
site/                    Trang web tĩnh (HTML/CSS/JS, không cần build)
  config.js              Quy tắc nghiệp vụ có thể chỉnh
  js/model.js            Bộ tính toán tồn, ADS, DOH, trạng thái, Pareto, vòng quay
  js/app.js              Giao diện
.github/workflows/       Đồng bộ + triển khai GitHub Pages
docs/                    Quy tắc nghiệp vụ và SQL tạo bảng FactInventory
```
