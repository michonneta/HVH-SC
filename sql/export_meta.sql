-- Thông tin đối soát: phạm vi dữ liệu và phần bị loại khỏi báo cáo tồn.
SELECT
  FORMAT_DATE('%F', MIN(inserted_date_vn))                        AS data_from,
  FORMAT_DATE('%F', MAX(inserted_date_vn))                        AS data_to,
  FORMAT_TIMESTAMP('%FT%TZ', MAX(inserted_at))                    AS last_txn_at,
  COUNT(*)                                                        AS total_rows,
  COUNTIF(NOT is_in_catalog)                                      AS rows_not_in_catalog,
  COUNTIF(is_in_catalog AND IFNULL(is_composite, FALSE))          AS rows_composite,
  SUM(IF(NOT is_in_catalog, quantity, 0))                         AS qty_not_in_catalog
FROM `{{TABLE}}`
