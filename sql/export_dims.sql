-- Danh mục kho và SKU (lấy thông tin của giao dịch gần nhất).
SELECT
  'sku'                                                          AS kind,
  country                                                        AS c,
  sku                                                            AS k,
  CAST(NULL AS STRING)                                           AS w,
  ARRAY_AGG(product_name ORDER BY inserted_at DESC LIMIT 1)[OFFSET(0)]  AS name,
  ARRAY_AGG(retail_price ORDER BY inserted_at DESC LIMIT 1)[OFFSET(0)]  AS retail_price,
  ARRAY_AGG(last_imported_price ORDER BY inserted_at DESC LIMIT 1)[OFFSET(0)] AS last_imported_price
FROM `{{TABLE}}`
WHERE is_in_catalog
  AND NOT IFNULL(is_composite, FALSE)
GROUP BY 2, 3

UNION ALL

SELECT
  'warehouse',
  country,
  CAST(NULL AS STRING),
  warehouse_id,
  ARRAY_AGG(warehouse_name ORDER BY inserted_at DESC LIMIT 1)[OFFSET(0)],
  NULL,
  NULL
FROM `{{TABLE}}`
WHERE is_in_catalog
  AND NOT IFNULL(is_composite, FALSE)
GROUP BY 2, 4
