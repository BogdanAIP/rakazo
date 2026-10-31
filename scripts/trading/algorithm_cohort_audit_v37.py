#!/usr/bin/env python3
"""Metadata-only protected-tail audit; never reads market payload or claim outcomes."""
from datetime import datetime, timedelta, timezone
import hashlib
import json

UTC=timezone.utc


def archive_span(label):
    start=datetime.fromisoformat(label).replace(tzinfo=UTC)-timedelta(hours=8)
    return int(start.timestamp()*1000),int((start+timedelta(days=1)).timestamp()*1000)


def intersects(a,b):return a[0]<b[1] and b[0]<a[1]


def audit(manifests,labels,symbols):
    protected=[]
    for name,raw in manifests:
        z=json.loads(raw)
        n=z["closed_bars"];step=z["candle_interval_minutes"]*60000
        if (type(n) is not int or n<5 or z["last_open_ms"]-z["first_open_ms"]!=(n-1)*step):
            raise ValueError("Manifest range/count requires further audit")
        protected.append({"symbol":z["symbol"],"start_ms":z["first_open_ms"]+int(.8*n)*step,
            "end_ms":z["last_open_ms"]+step,"source_manifest":name,
            "manifest_sha":hashlib.sha256(raw).hexdigest(),"csv_sha":z["csv_sha256"],
            "basis":"Conservative declared final20% tail, not proof of claim or prior access"})
    explicit=[("ALL","2026-09-05","2026-09-06"),("ALL","2026-11-01","2026-11-13")]
    for symbol,a,b in explicit:
        protected.append({"symbol":symbol,"start_ms":int(datetime.fromisoformat(a).replace(tzinfo=UTC).timestamp()*1000),
                          "end_ms":int(datetime.fromisoformat(b).replace(tzinfo=UTC).timestamp()*1000),
                          "basis":"Explicit project reservation"})
    conflicts=[]
    for label in labels:
        span=archive_span(label)
        for p in protected:
            if p["symbol"] in symbols or p["symbol"]=="ALL":
                if intersects(span,(p["start_ms"],p["end_ms"])):
                    conflicts.append({"archive_day_label":label,"symbol":p["symbol"],
                                      "protected_from_utc":datetime.fromtimestamp(p["start_ms"]/1000,UTC).isoformat(),
                                      "basis":p["basis"]})
    return {"labels":labels,"status":"REJECTED_CONSERVATIVE_OVERLAP" if conflicts else "NO_KNOWN_OVERLAP_NOT_FULLY_CLEARED",
            "conflicts":conflicts,"protected_metadata":protected,
            "claim_registry_locations_fully_resolved":False,"payloads_opened":False,
            "independent_cohort_certified":False}
