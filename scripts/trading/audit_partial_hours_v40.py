"""Observe partial-hour minute geometry; causes and listing provenance stay UNKNOWN."""
from pathlib import Path
import argparse,json,datetime as dt
import audit_okx_bench_sources_v40 as audit
import okx_bench_archive_v40 as src

def geometry(minutes):
 m=set(minutes)
 if not m or min(m)<0 or max(m)>59:raise ValueError('Expected observed minute offsets in 0..59')
 first,last=min(m),max(m)
 return {'first_minute':first,'last_minute':last,'observed_minutes':len(m),'missing_minutes':60-len(m),'leading_missing':first,'trailing_missing':59-last,'internal_missing':last-first+1-len(m)}

def inspect(root,quality,out):
 if out.exists():raise FileExistsError(out)
 q=json.loads(quality.read_text());cases=[];days=[x['archive_date'] for x in q['per_archive_quality'] if x['incomplete_hours']]
 for day in days:
  date=src.DATE(day);p=src.file_at(root,'candles',date);receipt=json.loads((root/'receipts'/f'{day}.json').read_text())['candles']
  if src.sha_file(p)!=receipt['sha256']:raise ValueError('Original candle receipt mismatch')
  _,hours=audit.inspect_candles(root,date)
  begin=int(dt.datetime.combine(date,dt.time(),dt.timezone.utc).timestamp()*1000)-8*src.HOUR
  for (hour,symbol),minutes in sorted(hours.items()):
   if len(minutes)==60:continue
   row={'archive_date':day,'symbol':symbol,'hour_utc':dt.datetime.fromtimestamp(hour/1000,dt.timezone.utc).isoformat(),**geometry(minutes),'cause':'UNKNOWN'}
   for name,t in [('previous',hour-src.HOUR),('next',hour+src.HOUR)]:
    row[name+'_hour_in_same_archive']=((t,symbol) in hours) if begin<=t<begin+src.DAY else 'UNKNOWN_OUTSIDE_THIS_ARCHIVE'
   cases.append(row)
 result={'schema':'partial_hour_geometry_v1','mode':'DATA_QUALITY_DEVELOPMENT','source_quality_sha256':src.sha_file(quality),'archive_days_inspected':days,'cases':cases,'missing_minutes':sum(x['missing_minutes'] for x in cases),'internal_missing':sum(x['internal_missing'] for x in cases),'leading_missing':sum(x['leading_missing'] for x in cases),'trailing_missing':sum(x['trailing_missing'] for x in cases),'sources_changed':False,'cause_certified':False,'real_strategy_evaluations':0,'freeze_approved':False}
 if len(cases)!=q['incomplete_source_hours'] or result['missing_minutes']!=q['missing_minutes_in_observed_hours']:raise ValueError('Prior coverage totals not reproduced')
 with out.open('x',encoding='utf-8') as f:json.dump(result,f,indent=2)
 return result

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,required=True);p.add_argument('--quality',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();print(json.dumps(inspect(a.root,a.quality,a.out)))
