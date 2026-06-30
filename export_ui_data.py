import pandas as pd, numpy as np, json, os
from population_data import state_population
TARGET="MAL - Malaria cases confirmed (number)"
OUT=f"ui/public/data/{os.environ.get('MAL_VARIANT','after')}"; os.makedirs(OUT,exist_ok=True)

fc=pd.read_parquet("forecast_lga.parquet")
fc['cases']=fc['cases'].round(0)
metrics=json.load(open("model_metrics.json"))
fi=pd.read_csv("feature_importance.csv")
corr=pd.read_csv("feature_correlation.csv",index_col=0)

def date_str(y,m): return f"{int(y)}-{int(m):02d}"

# ---- national monthly ----
nat=fc.groupby(['ym','year','month','is_forecast'],as_index=False).agg(cases=('cases','sum'),population=('population','sum'))
nat=nat.sort_values('ym')
nat_json=[{"date":date_str(r.year,r.month),"year":int(r.year),"month":int(r.month),
           "cases":int(r.cases),"forecast":bool(r.is_forecast),
           "incidence":round(r.cases/r.population*1000,3)} for r in nat.itertuples()]

# ---- state monthly ----
st=fc.groupby(['state','ym','year','month','is_forecast'],as_index=False).agg(cases=('cases','sum'),population=('population','sum'))
st=st.sort_values(['state','ym'])
state_json={}
for s,g in st.groupby('state'):
    state_json[s]=[{"date":date_str(r.year,r.month),"cases":int(r.cases),
                    "forecast":bool(r.is_forecast),
                    "incidence":round(r.cases/r.population*1000,3)} for r in g.itertuples()]

# ---- lga monthly (compact) ----
lga=fc.sort_values(['state','lga','ym'])
lga_json={}
for (s,l),g in lga.groupby(['state','lga']):
    key=f"{s}|||{l}"
    lga_json[key]=[{"d":date_str(r.year,r.month),"c":int(r.cases),
                    "f":1 if r.is_forecast else 0} for r in g.itertuples()]

# ---- geo tree + summary stats per state/lga ----
# annual totals 2023-2028 per state, per lga
def annual(df,grp):
    a=df.groupby(grp+['year'])['cases'].sum().reset_index()
    return a
states=sorted(fc['state'].unique())
geo={}
lga_pop=fc[fc.year==2025].groupby(['state','lga'])['population'].mean().round(0)
for s in states:
    sub=fc[fc.state==s]
    lgas=sorted(sub['lga'].unique())
    geo[s]={"lgas":lgas}

# summary cards
def yr_total(df,y): return int(df[df.year==y]['cases'].sum())
summary={
  "n_states":len(states),
  "n_lgas":int(fc.groupby(['state','lga']).ngroups),
  "national_annual":{str(int(y)):int(v) for y,v in fc.groupby('year')['cases'].sum().items()},
  "peak_year":int(fc.groupby('year')['cases'].sum().idxmax()),
}

# state ranking (2025 actual + 2028 forecast)
rank=[]
for s in states:
    sub=fc[fc.state==s]
    pop25=state_population(s,2025)   # state total population (annual incidence base)
    c25=yr_total(sub,2025); c28=yr_total(sub,2028)
    rank.append({"state":s,"cases_2025":c25,"cases_2028":c28,
                 "incidence_2025":round(c25/pop25*1000,1) if pop25 else None,
                 "change_pct":round((c28-c25)/c25*100,1) if c25 else None})
rank=sorted(rank,key=lambda x:-x["cases_2025"])

# top LGA hotspots (2025)
lh=fc[fc.year==2025].groupby(['state','lga']).agg(cases=('cases','sum'),pop=('population','mean')).reset_index()
lh['incidence']=(lh['cases']/lh['pop']*1000).round(1)
lh['cases']=lh['cases'].astype(int)
hotspots=lh.sort_values('cases',ascending=False).head(40)[['state','lga','cases','incidence']].to_dict('records')

# correlation top (concurrent indicators) — exclude target
ct=corr.reset_index().rename(columns={'index':'feature'})
ct=ct[ct['feature']!=TARGET].head(20)
corr_json=[{"feature":r['feature'][:55],"pearson":round(r['pearson'],3),
            "spearman":round(r['spearman'],3)} for _,r in ct.iterrows()]

fi_json=[{"feature":r['feature'],"importance":round(r['importance'],4)} for _,r in fi.head(15).iterrows()]

json.dump(nat_json,open(f"{OUT}/national.json","w"))
json.dump(state_json,open(f"{OUT}/states.json","w"))
json.dump(lga_json,open(f"{OUT}/lgas.json","w"))
json.dump(geo,open(f"{OUT}/geo.json","w"))
json.dump({"summary":summary,"ranking":rank,"hotspots":hotspots,
           "metrics":metrics,"feature_importance":fi_json,"correlation":corr_json},
          open(f"{OUT}/meta.json","w"))
print("Wrote:",os.listdir(OUT))
for fn in os.listdir(OUT):
    print(f"  {fn}: {os.path.getsize(OUT+'/'+fn)/1024:.0f} KB")
