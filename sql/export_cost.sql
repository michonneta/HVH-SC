-- Giá vốn bình quân cuối ngày (tiền địa phương) của từng kho + SKU, dùng để định giá tồn.
SELECT
  FORMAT_DATE('%F', inserted_date_vn) AS d,
  country                             AS c,
  warehouse_id                        AS w,
  sku                                 AS k,
  ARRAY_AGG(cost_price ORDER BY inserted_at DESC, id DESC LIMIT 1)[OFFSET(0)] AS cp
FROM `{{TABLE}}`
WHERE is_in_catalog
  AND NOT IFNULL(is_composite, FALSE)
  AND row_source = 'Giao dịch'
GROUP BY 1, 2, 3, 4
