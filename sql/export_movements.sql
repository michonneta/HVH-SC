-- Biến động kho gộp theo ngày (giờ VN) + kho + SKU + mã lý do.
-- r: note_type của Pancake; -1 = Tồn đầu dữ liệu, -2 = Chênh lệch hệ thống, 0 = không có note_type.
-- Chỉ lấy hàng thật: mẫu mã còn trong danh mục và không phải combo ghép.
-- Giá trị (iv, ev) theo tiền địa phương = số lượng × giá vốn bình quân tại dòng.
SELECT
  FORMAT_DATE('%F', inserted_date_vn) AS d,
  country                             AS c,
  warehouse_id                        AS w,
  sku                                 AS k,
  CASE row_source
    WHEN 'Tồn đầu dữ liệu'     THEN -1
    WHEN 'Chênh lệch hệ thống' THEN -2
    ELSE IFNULL(note_type, 0)
  END                                 AS r,
  SUM(im_quantity)                    AS iq,
  SUM(ex_quantity)                    AS eq,
  ROUND(SUM(im_quantity * cost_price), 4) AS iv,
  ROUND(SUM(ex_quantity * cost_price), 4) AS ev
FROM `{{TABLE}}`
WHERE is_in_catalog
  AND NOT IFNULL(is_composite, FALSE)
GROUP BY 1, 2, 3, 4, 5
