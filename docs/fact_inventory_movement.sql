-- Lịch sử xuất nhập kho từ Pancake POS
-- Nguồn : hv-data.pancake_pos_dwh.pancake_inventory_history__<shop_id>
-- Hạt   : 1 dòng = 1 biến động kho (shop_id, id), cộng các dòng bổ sung (row_source <> 'Giao dịch'):
--           - 'Tồn đầu dữ liệu'     : tồn của kho + mẫu mã trước giao dịch đầu tiên trong lịch sử
--           - 'Chênh lệch hệ thống' : phần tồn thay đổi mà lịch sử Pancake không ghi dòng nào
--         Nhờ đó, theo từng kho + mẫu mã: Σ quantity đến dòng N = wh_remain_quantity của dòng N,
--         nên tồn đầu + nhập − xuất = tồn cuối luôn khớp.
-- Ghi chú:
--   - quantity > 0 là nhập, < 0 là xuất (giữ nguyên dấu của Pancake).
--   - remain_quantity là tồn TỔNG mọi kho của variation ngay sau biến động, không phải tồn của kho trên dòng.
--   - wh_remain_quantity / wh_actual_remain_quantity: tồn có thể bán / tồn thực tế của kho trên dòng ngay sau
--     biến động (lấy từ current_inventory). Tồn có thể bán dùng được cho chuỗi thời gian; tồn thực tế
--     chỉ đúng tại thời điểm giao dịch (giao hàng không sinh dòng lịch sử).
--   - cost_price, retail_price, last_imported_price là tiền địa phương; TH, PH, ML, CAM đã chia 100
--     (Pancake lưu x100 cho các shop này).
--   - Thông tin SKU lấy từ variation_now (trạng thái hiện tại). Tên sản phẩm lấy từ pancake_product
--     (nối theo variation_id); mẫu mã đã xóa khỏi danh mục thì lấy tên lúc giao dịch.
--   - is_in_catalog = FALSE: mẫu mã không còn trong pancake_product. Loại khi tính tồn kho,
--     vẫn giữ khi tính bán hàng.

-- Đổi tên bảng đích trước khi chạy
CREATE OR REPLACE TABLE `hv-data.a_data_mart_sales.FactInventoryMovement`
PARTITION BY DATE(inserted_at)
CLUSTER BY country, warehouse_id, sku
AS

WITH
-- Map shop -> thị trường (thay bằng bảng dim nếu có)
-- price_divisor: TH, PH, ML, CAM lưu tiền theo đơn vị nhỏ (x100)
ShopMarket AS (
  SELECT * FROM UNNEST([
    STRUCT('1942976467' AS shop_id, 'VN'  AS country, 1   AS price_divisor),
    STRUCT('1635973951' AS shop_id, 'ID'  AS country, 1   AS price_divisor),
    STRUCT('714982840'  AS shop_id, 'TH'  AS country, 100 AS price_divisor),
    STRUCT('1942955945' AS shop_id, 'PH'  AS country, 100 AS price_divisor),
    STRUCT('1942946009' AS shop_id, 'CAM' AS country, 100 AS price_divisor),
    STRUCT('1021230300' AS shop_id, 'ML'  AS country, 100 AS price_divisor)
  ])
),

-- Danh mục kho (1 dòng / kho để không nhân bản giao dịch)
Warehouse AS (
  SELECT
    _TABLE_SUFFIX AS shop_id,
    id AS warehouse_id,
    ANY_VALUE(name) AS warehouse_name
  FROM `hv-data.pancake_pos_dwh.pancake_warehouse__*`
  GROUP BY 1, 2
),

-- Danh mục mẫu mã (pancake_product: 1 dòng / variation)
Product AS (
  SELECT
    _TABLE_SUFFIX AS shop_id,
    id AS variation_id,
    ANY_VALUE(JSON_VALUE(product, '$.name')) AS product_name
  FROM `hv-data.pancake_pos_dwh.pancake_product__*`
  GROUP BY 1, 2
),

Raw AS (
  SELECT
    _TABLE_SUFFIX AS shop_id,
    h.*
  FROM `hv-data.pancake_pos_dwh.pancake_inventory_history__*` h
  -- Loại 2 kho "Kho mặc định" đã xóa khỏi danh mục (VN, dữ liệu không dùng – đã kiểm tra 2026-10-21)
  WHERE JSON_VALUE(h.warehouse, '$.id') NOT IN (
    '402b50cf-f315-4209-a834-5211c0814762',
    'b522479f-c996-40e1-9ece-faacbb4b2082'
  )
  -- Chống trùng nếu bảng nguồn từng nạp lại
  QUALIFY ROW_NUMBER() OVER (PARTITION BY _TABLE_SUFFIX, h.id ORDER BY h.inserted_at DESC) = 1
),

Movement AS (
  SELECT
    r.shop_id,
    sm.country,
    r.id,
    r.inserted_at,
    'Giao dịch'                                                AS row_source,

    -- Chứng từ
    r.table_name,
    r.note_type,
    r.type,
    r.ref_display_id,
    r.record_id,
    r.editor_id,
    r.supplier_products_id,

    -- Kho
    JSON_VALUE(r.warehouse, '$.id')                            AS warehouse_id,
    w.warehouse_name,

    -- Sản phẩm
    JSON_VALUE(r.variation_now, '$.id')                        AS variation_id,
    JSON_VALUE(r.variation_now, '$.product_id')                AS product_id,
    JSON_VALUE(r.variation_now, '$.display_id')                AS sku,
    JSON_VALUE(r.variation_now, '$.barcode')                   AS barcode,
    -- Tên hiện tại từ danh mục; mẫu mã đã xóa khỏi danh mục thì lấy tên lúc giao dịch
    COALESCE(p.product_name, JSON_VALUE(r.variation, '$.name')) AS product_name,
    SAFE_CAST(JSON_VALUE(r.variation_now, '$.is_composite') AS BOOL) AS is_composite,
    SAFE_CAST(JSON_VALUE(r.variation_now, '$.is_removed') AS BOOL)   AS is_removed,
    -- Mẫu mã còn trong danh mục pancake_product hay không (FALSE: combo tồn ảo, SKU test, SKU đã xóa)
    p.variation_id IS NOT NULL                                 AS is_in_catalog,

    -- Số lượng
    r.quantity,
    r.remain_quantity,
    wi.wh_remain_quantity,
    wi.wh_actual_remain_quantity,

    -- Giá theo tiền địa phương (đã chia price_divisor)
    r.avg_price / sm.price_divisor                             AS cost_price,
    SAFE_CAST(JSON_VALUE(r.variation_now, '$.last_imported_price') AS FLOAT64) / sm.price_divisor        AS last_imported_price,
    SAFE_CAST(JSON_VALUE(r.variation_now, '$.retail_price') AS FLOAT64) / sm.price_divisor               AS retail_price,
    SAFE_CAST(JSON_VALUE(r.variation_now, '$.retail_price_after_discount') AS FLOAT64) / sm.price_divisor AS retail_price_after_discount
  FROM Raw r
  LEFT JOIN ShopMarket sm ON sm.shop_id = r.shop_id
  LEFT JOIN Warehouse w   ON w.shop_id = r.shop_id AND w.warehouse_id = JSON_VALUE(r.warehouse, '$.id')
  LEFT JOIN Product p     ON p.shop_id = r.shop_id AND p.variation_id = JSON_VALUE(r.variation_now, '$.id')
  -- Tồn của kho trên dòng, lấy từ current_inventory (1 phần tử / kho)
  LEFT JOIN UNNEST(ARRAY(
    SELECT AS STRUCT
      SAFE_CAST(JSON_VALUE(ci, '$.remain_quantity') AS INT64)        AS wh_remain_quantity,
      SAFE_CAST(JSON_VALUE(ci, '$.actual_remain_quantity') AS INT64) AS wh_actual_remain_quantity
    FROM UNNEST(r.current_inventory) ci
    WHERE JSON_VALUE(ci, '$.id') = JSON_VALUE(r.warehouse, '$.id')
    LIMIT 1
  )) wi
),

-- Phần tồn thay đổi trước mỗi giao dịch mà lịch sử không giải thích được
-- (dòng đầu tiên: so với 0 = tồn đầu dữ liệu; các dòng sau: so với tồn của giao dịch trước = điểm đứt)
Chain AS (
  SELECT
    m.*,
    m.wh_remain_quantity - m.quantity
      - COALESCE(LAG(m.wh_remain_quantity) OVER w, 0)          AS gap_quantity,
    LAG(m.wh_remain_quantity) OVER w IS NULL                   AS is_first_row
  FROM Movement m
  WINDOW w AS (PARTITION BY m.shop_id, m.warehouse_id, m.variation_id ORDER BY m.inserted_at, m.id)
),

Adjustment AS (
  SELECT
    * EXCEPT (gap_quantity, is_first_row)
    REPLACE (
      CAST(NULL AS INT64)                                      AS id,
      TIMESTAMP_SUB(inserted_at, INTERVAL 1 MICROSECOND)       AS inserted_at,
      IF(is_first_row, 'Tồn đầu dữ liệu', 'Chênh lệch hệ thống') AS row_source,
      CAST(NULL AS STRING)                                     AS table_name,
      CAST(NULL AS INT64)                                      AS note_type,
      IF(is_first_row, 'Tồn đầu dữ liệu', 'Chênh lệch hệ thống') AS type,
      CAST(NULL AS STRING)                                     AS ref_display_id,
      CAST(NULL AS STRING)                                     AS record_id,
      CAST(NULL AS STRING)                                     AS editor_id,
      CAST(NULL AS INT64)                                      AS supplier_products_id,
      gap_quantity                                             AS quantity,
      CAST(NULL AS INT64)                                      AS remain_quantity,
      wh_remain_quantity - quantity                            AS wh_remain_quantity,
      CAST(NULL AS INT64)                                      AS wh_actual_remain_quantity
    )
  FROM Chain
  WHERE gap_quantity <> 0
),

AllRows AS (
  SELECT * FROM Movement
  UNION ALL
  SELECT * FROM Adjustment
)

SELECT
  shop_id,
  country,
  id,
  inserted_at,
  DATETIME(inserted_at, 'Asia/Ho_Chi_Minh')                  AS inserted_at_vn,
  DATE(inserted_at, 'Asia/Ho_Chi_Minh')                      AS inserted_date_vn,
  row_source,
  table_name,
  note_type,
  type,
  ref_display_id,
  record_id,
  editor_id,
  supplier_products_id,
  warehouse_id,
  warehouse_name,
  variation_id,
  product_id,
  sku,
  barcode,
  product_name,
  is_composite,
  is_removed,
  is_in_catalog,
  quantity,
  IF(quantity > 0, quantity, 0)                              AS im_quantity,
  IF(quantity < 0, -quantity, 0)                             AS ex_quantity,
  remain_quantity,
  wh_remain_quantity,
  wh_actual_remain_quantity,
  cost_price,
  last_imported_price,
  retail_price,
  retail_price_after_discount
FROM AllRows
