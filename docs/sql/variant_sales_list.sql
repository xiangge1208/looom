SELECT
  v.display_order AS seq,
  v.child_asin    AS asin,
  a.title,
  a.price,
  a.score,
  a.rating_num,
  fx.size_text,
  tr.n_points,
  tr.latest_label,
  tr.trend_csv
FROM looom.rel_asin_variant v
LEFT JOIN looom.dim_asin a
       ON a.asin = v.child_asin AND a.country = v.country
LEFT JOIN (
  SELECT asin, country,
      GROUP_CONCAT(feature_value ORDER BY feature_name SEPARATOR ' / ') AS size_text
  FROM looom.dim_asin_feature
  GROUP BY asin, country
) fx ON fx.asin = v.child_asin AND fx.country = v.country
LEFT JOIN (
  SELECT asin, country,
   COUNT(*) AS n_points,
      MAX_BY(bought_label, stat_month) AS latest_label,
    GROUP_CONCAT(CONCAT(stat_month, ':', CAST(bought_lower_bound AS STRING))
      ORDER BY stat_month SEPARATOR ',') AS trend_csv
  FROM looom.fact_asin_bought_monthly
  GROUP BY asin, country
) tr ON tr.asin = v.child_asin AND tr.country = v.country
WHERE v.country = 'US' AND v.parent_asin = 'B0SEEDHDP0'
ORDER BY v.display_order;
