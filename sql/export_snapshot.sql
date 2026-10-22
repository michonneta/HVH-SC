-- Tồn hiện tại trên Pancake theo kho + SKU: có thể bán (remain) và thực tế (actual).
-- Dùng để hiển thị "tồn thực tế" và "đang chờ giao" cho ngày hiện tại.
WITH Shop AS (
  SELECT DISTINCT shop_id, country
  FROM `{{TABLE}}`
)
SELECT
  s.country                                                       AS c,
  JSON_VALUE(vw, '$.warehouse_id')                                AS w,
  p.display_id                                                    AS k,
  SUM(SAFE_CAST(JSON_VALUE(vw, '$.remain_quantity') AS INT64))        AS remain,
  SUM(SAFE_CAST(JSON_VALUE(vw, '$.actual_remain_quantity') AS INT64)) AS actual
FROM `hv-data.pancake_pos_dwh.pancake_product__*` p
JOIN Shop s ON s.shop_id = p._TABLE_SUFFIX,
UNNEST(p.variations_warehouses) vw
GROUP BY 1, 2, 3
