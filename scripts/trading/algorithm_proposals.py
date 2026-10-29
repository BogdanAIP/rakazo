"""Untrusted model-proposed research programs enter only through this JSON gate.

NO arbitrary Python or JavaScript; no dynamic eval/exec, shell or network.
Rationales are metadata, not execution instructions. LLM only proposes
mathematical structures; deterministic validation/falsification tests them.
"""
from __future__ import annotations
import hashlib
import json
import re
from pathlib import Path

MAX_PROPOSALS=16
MAX_FILE_BYTES=32_768
SCHEMA="algorithm_discovery_proposals_v0"


def read_proposals(path):
    path=Path(path)
    if path.stat().st_size>MAX_FILE_BYTES:
        raise ValueError("Research proposal file too large")
    data=path.read_bytes()
    doc=json.loads(data.decode("utf-8-sig"))
    if not isinstance(doc,dict) or doc.get("schema")!=SCHEMA:
        raise ValueError("Unsupported proposal schema")
    records=doc.get("proposals")
    if not isinstance(records,list) or not 1<=len(records)<=MAX_PROPOSALS:
        raise ValueError("Need 1..16 model-proposed hypotheses")
    from algorithm_discovery_lab import validate_ast,identity
    from algorithm_discovery_lab import MAX_DEPTH
    ids=set()
    programs=set()
    result=[]
    for rec in records:
        if not isinstance(rec,dict) or set(rec)!={"id","hypothesis","program"}:
            raise ValueError("Unexpected proposal fields")
        label=rec["id"]
        hypothesis=rec["hypothesis"]
        prog=rec["program"]
        if not isinstance(label,str) or not re.fullmatch("[a-z0-9][a-z0-9_-]{0,63}",label):
            raise ValueError("Invalid proposal ID")
        if not isinstance(hypothesis,str) or not 20<=len(hypothesis)<=700:
            raise ValueError("Scientific rationale required")
        validate_ast(prog)
        pid=identity(prog)
        if label in ids or pid in programs:
            raise ValueError("Repeated model proposal/program")
        ids.add(label)
        programs.add(pid)
        result.append({"id":label,"hypothesis":hypothesis,
                       "program":prog,"program_sha256":pid})
    return {"source_sha256":hashlib.sha256(data).hexdigest(),
            "schema":SCHEMA,"proposals":result,
            "untrusted_model_text_is_instructions":False,
            "scientific_novelty_verified":False}
