-- Tỷ giá quy đổi tiền địa phương -> VND theo ngày (CTE đã thống nhất).
WITH ExchangeRate AS (
  SELECT
    c.Code AS country,
    ex.exchange_date,
    MAX(COALESCE(ex.base_fx_rate, 1)) AS fx_rate
  FROM `hv-data.a_dwh.DimExchangeRate` ex
  LEFT JOIN `hv-data.mdm_prod_dwh.markets` c
    ON ex.country_id = c.ExternalId
  WHERE c.IsActive = TRUE
  GROUP BY 1, 2
)
SELECT
  country                             AS c,
  FORMAT_DATE('%F', exchange_date)    AS d,
  fx_rate                             AS fx
FROM ExchangeRate
WHERE country IN (SELECT DISTINCT country FROM `{{TABLE}}`)
  AND exchange_date BETWEEN (SELECT MIN(inserted_date_vn) FROM `{{TABLE}}`)
                        AND CURRENT_DATE('Asia/Ho_Chi_Minh')
