import pandas as pd, numpy as np
from population_data import state_population, STATE_POP_2022, GROWTH_RATE, BASE_YEAR
TARGET="MAL - Malaria cases confirmed (number)"

lga=pd.read_parquet("agg_lga.parquet")
state=pd.read_parquet("agg_state.parquet")

# facility share within state (use max facilities seen per LGA as a stable size proxy)
fac=lga.groupby(['state','lga'])['n_facilities'].max().reset_index().rename(columns={'n_facilities':'lga_fac'})
sfac=fac.groupby('state')['lga_fac'].sum().reset_index().rename(columns={'lga_fac':'state_fac'})
fac=fac.merge(sfac,on='state')
fac['fac_share']=fac['lga_fac']/fac['state_fac']

def add_pop(df, level):
    df=df.copy()
    df['state_population']=[state_population(s,y) for s,y in zip(df['state'],df['year'])]
    if level=='lga':
        df=df.merge(fac[['state','lga','fac_share']],on=['state','lga'],how='left')
        df['population']=df['state_population']*df['fac_share']
    else:
        df['population']=df['state_population']
    # incidence per 1000 (monthly confirmed cases / pop *1000)
    df['incidence_per_1000']=df[TARGET]/df['population']*1000
    return df

lga2=add_pop(lga,'lga')
state2=add_pop(state,'state')
lga2.to_parquet("agg_lga_pop.parquet",index=False)
state2.to_parquet("agg_state_pop.parquet",index=False)

print("Unmatched states (no pop):", sorted(set(state['state'])-set(STATE_POP_2022)))
print("\nState pop check 2025 (top 5 by pop):")
chk=state2[state2.year==2025][['state','population',TARGET,'incidence_per_1000']].sort_values('population',ascending=False).head(5)
print(chk.to_string(index=False))
print("\nLGA sample 2025 (top 5 incidence, pop>50k):")
l=lga2[(lga2.year==2025)&(lga2.population>50000)].groupby(['state','lga']).agg(pop=('population','mean'),cases=(TARGET,'sum'))
l['inc_per_1000_annual']=l['cases']/l['pop']*1000
print(l.sort_values('inc_per_1000_annual',ascending=False).head(5).to_string())
