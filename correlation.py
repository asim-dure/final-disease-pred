import pandas as pd, numpy as np, json
TARGET="MAL - Malaria cases confirmed (number)"
df=pd.read_parquet("agg_lga_pop.parquet")
df=df[(df.year>=2023)&(df[TARGET].notna())].copy()
# numeric cols
num=df.select_dtypes('number').columns.tolist()
drop={'year','month'}
num=[c for c in num if c not in drop]
# coverage: fraction non-null & non-zero
cov=df[num].notna().mean()
# correlations vs target
corP={}; corS={}
t=df[TARGET]
for c in num:
    if c==TARGET: continue
    s=df[c]
    mask=s.notna()&t.notna()
    if mask.sum()<500 or s[mask].nunique()<5: continue
    corP[c]=np.corrcoef(s[mask],t[mask])[0,1]
    corS[c]=s[mask].rank().corr(t[mask].rank())
res=pd.DataFrame({'pearson':corP,'spearman':corS})
res['abs_pearson']=res['pearson'].abs()
res['coverage']=cov.reindex(res.index)
res=res.sort_values('abs_pearson',ascending=False)
res.to_csv("feature_correlation.csv")
pd.set_option('display.width',160)
print("TOP 25 features by |Pearson| vs confirmed cases:\n")
print(res.head(25).round(3).to_string())
print("\nWeather correlations:")
for w in ['rainfall_mm_day','temperature_mean_c','humidity_pct','solar_kwh_m2_day','wind_speed_ms','temperature_max_c','temperature_min_c']:
    if w in res.index: print(f"  {w:22s} pearson={res.loc[w,'pearson']:+.3f} spearman={res.loc[w,'spearman']:+.3f}")
print("\npopulation pearson:", round(res.loc['population','pearson'],3) if 'population' in res.index else 'NA')
