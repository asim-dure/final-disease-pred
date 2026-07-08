from dotenv import load_dotenv; load_dotenv()
import warehouse as wh
r = wh.safe_select("""
  select f.year, f.month, round(sum(f.indicator_value)) confirmed
  from malaria.fact_indicator_data f
  join public.dim_indicator_master d on d.indicator_key=f.indicator_key
  where d.indicator_name='MAL - Malaria cases confirmed (number)' and f.year=2026
  group by 1,2 order by 1,2""")
print(r.to_string(index=False))
