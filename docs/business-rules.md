# Quy tắc nghiệp vụ – Báo cáo tồn kho

Trạng thái: **[CHỐT]** = người dùng đã xác nhận · **[ĐỀ XUẤT]** = chờ xác nhận · **[MỞ]** = chưa quyết định.
Cập nhật: 2026-10-21.

## 1. Nguồn dữ liệu
- Lịch sử nhập/xuất: bảng mới `hv-data.a_data_mart_sales.FactInventoryMovement`, tạo bằng `sql/fact_inventory_movement.sql` từ `hv-data.pancake_pos_dwh.pancake_inventory_history__<shop_id>` (thay cho `FactInventory` cũ bị trùng dòng). **[CHỐT 2026-10-22]**
  - Tên kho: nối `pancake_warehouse__*` theo shop + `warehouse_id`.
  - Tên sản phẩm: nối `pancake_product__*` theo shop + `variation_id`; mẫu mã đã xóa thì lấy tên lúc giao dịch.
  - Giá (`cost_price`, `last_imported_price`, `retail_price`, `retail_price_after_discount`): TH, PH, ML, CAM chia 100.
  - Loại 2 kho VN `402b50cf-…`, `b522479f-…` ("Kho mặc định" đã xóa).
  - `is_in_catalog`: mẫu mã còn trong `pancake_product`.
  - `row_source`: 'Giao dịch' (dòng Pancake) / 'Tồn đầu dữ liệu' (tồn kho + mẫu mã trước giao dịch đầu tiên) / 'Chênh lệch hệ thống' (tồn thay đổi mà lịch sử không ghi). Với 2 loại dòng bổ sung, Σ quantity theo kho + mẫu mã luôn = `wh_remain_quantity` (đã kiểm tra 100% dòng, 2026-10-22): CAM 20 dòng tồn đầu (+23.841); VN 34 dòng tồn đầu (−3.792, chủ yếu SKU "1") và 44 dòng chênh lệch (+75). **[CHỐT]**
  - `wh_remain_quantity` / `wh_actual_remain_quantity`: tồn có thể bán / tồn thực tế của kho trên dòng ngay sau biến động, lấy từ `current_inventory`. Chuỗi tồn có thể bán theo kho liền mạch (chỉ VN có 44 điểm đứt); tồn thực tế không cập nhật khi giao hàng nên chỉ đúng tại thời điểm giao dịch.
- Tỷ giá: CTE `ExchangeRate` (DimExchangeRate × mdm_prod_dwh.markets), nối theo `country` + `exchange_date`. `fx_rate` quy tiền địa phương → VND. **[CHỐT]**

## 2. Làm sạch
- Trùng dòng ở FactInventory: nguyên nhân là nối `pancake_product` theo `product_id` (cấp sản phẩm) – mỗi variation của cùng sản phẩm nhân thêm 1 bản sao (khớp 100% ở ID). SQL mới lấy thuộc tính variation từ `variation_now` và gộp `pancake_product` 1 dòng / `product_id`.
- `FactInventory.product_id` là mã sản phẩm cha, không phải variation; SKU (`display_id`) là cấp variation.
- Giá vốn: TH, PH, ML, CAM → `cost_price / 100`. VN, ID giữ nguyên. **[CHỐT]**
- Dữ liệu test CAM (SKU `1` – 33 mẫu mã, `12345678`) đã bị xóa khỏi `pancake_product` → được loại qua `is_in_catalog = FALSE`, không cần quy tắc riêng. **[CHỐT 2026-10-22]**

## 3. Thời gian
- Mọi ranh giới ngày/tuần/tháng và ngày tra tỷ giá dùng giờ Việt Nam: `DATE(inserted_date, 'Asia/Ho_Chi_Minh')`. **[CHỐT]**

## 4. Tồn kho
- Tồn hiện tại (chuẩn) = Σ `actual_remain_quantity` (tồn thực tế) trong `pancake_product.variations_warehouses`, theo kho + SKU, với điều kiện: **[ĐÃ XÁC MINH 2026-10-21]**
  - mẫu mã còn trong danh mục và có trong lịch sử kho;
  - không phải combo ghép (SKU dạng `…x2`, `…_…x1T`; tồn do Pancake suy ra từ hàng thành phần);
  - loại SKU KDH (TH) và MASK 24K (ID) – **[MỞ]** chờ xác nhận lý do (hàng tặng?).
  - Khớp số người dùng cung cấp: VN 157.229, CAM 132.651 (người dùng 132.648 – lệch thời điểm), PH 5.891, ML 65.627, TH 14.856, ID 18.585.
- Tồn tại ngày D = tồn hiện tại − Σ(nhập − xuất) phát sinh sau D (lùi ngược từ mốc hiện tại). **[ĐỀ XUẤT]**
  - Thay cho cộng dồn từ 0: cộng dồn lệch vì (1) lịch sử trừ kho khi tạo đơn → ra "tồn có thể bán" (`remain_quantity`), không phải tồn thực tế; (2) CAM có tồn trước khi lịch sử bắt đầu, không xác định được thuộc kho nào.
  - Hạn chế: tồn quá khứ lệch nhẹ bằng hàng đã lên đơn chưa giao tại ngày đó.
- `remain_quantity` trong lịch sử là tồn TỔNG mọi kho của variation, không phải tồn theo kho. **[ĐÃ XÁC MINH]**
- Đơn vị tính tồn gốc: **kho + SKU**. Tính tồn ở cấp kho + SKU trước, sau đó mới cộng dồn/lọc theo thị trường, nhóm, toàn công ty. **[CHỐT]**
- Tồn âm = bán pre-order (cho phép). **[CHỐT]**
  - SL pre-order (kho+SKU) = MAX(0, −tồn). **[ĐỀ XUẤT]**
  - Tỷ trọng SKU pre-order = số kho+SKU có tồn < 0 / số kho+SKU trong phạm vi. **[ĐỀ XUẤT]**
  - Khi gộp nhiều kho: Tồn vật lý = Σ MAX(tồn,0); SL pre-order = Σ MAX(−tồn,0); Tồn ròng = Σ tồn. Không để tồn âm kho này bù tồn dương kho khác. **[ĐỀ XUẤT]**

## 5. Khóa SKU
- Khóa phân tích: `sku` (trong phạm vi kho). **[CHỐT]**
- Cảnh báo: cùng kho + SKU có nhiều `product_id` – CAM 7, PH 243, VN 3 (đều là SKU `1`). **[MỞ]**

## 6. Nhóm lý do theo `note_type` **[CHỐT]**
| note_type | Nhóm |
|---|---|
| 5, 15 | NCC |
| 2 | Kiểm kê |
| 6, 7, 10, 11, 18, 31 | Bán hàng |
| 19, 20, 22, 23 | Chuyển kho |
| 1, 14, 16, 25, 26, 27, 28 | Khác |
| khác (mã mới) | Chưa phân loại |

- Bán thuần = Σ(`ex_quantity` − `im_quantity`) của nhóm Bán hàng. **[ĐỀ XUẤT]**
