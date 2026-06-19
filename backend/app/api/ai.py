from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.models.case import Case
from app.ai.orchestrator import TelecomIntelligenceOrchestrator
from app.ai.dataset_generator import generate_synthetic_case
from app.ai.finetune_scaffold import export_to_jsonl, generate_peft_guide
from app.ai.investigator import PoliceInvestigator
from app.ai.inference import load_model as load_ft_model, generate_answer

router = APIRouter()
orchestrator = TelecomIntelligenceOrchestrator()

# Helper to serialize DB model to agent-compatible dict
def model_to_dict(model_instance):
    if not model_instance:
        return {}
    d = {}
    for column in model_instance.__table__.columns:
        val = getattr(model_instance, column.name)
        if isinstance(val, bytes):
            val = val.decode("utf-8", errors="ignore")
        elif hasattr(val, "isoformat"):
            val = val.isoformat()
        d[column.name] = val

    # Map DB column names to agent-friendly field names
    # CDRRecord: a_party_number -> subject, b_party_number -> counterpart
    if hasattr(model_instance, "a_party_number"):
        d["subject"] = d.get("a_party_number", d.get("msisdn", ""))
        d["counterpart"] = d.get("b_party_number", "")
        d["timestamp"] = d.get("start_time", d.get("timestamp", ""))
        d["duration"] = d.get("duration_seconds", 0)
        d["lat"] = d.get("latitude")
        d["lng"] = d.get("longitude")
    # IPDRRecord: msisdn -> subject, destination_ip -> counterpart
    if hasattr(model_instance, "source_ip"):
        d["subject"] = d.get("msisdn", "")
        d["counterpart"] = d.get("destination_ip", "")
        d["timestamp"] = d.get("start_time", d.get("timestamp", ""))
        d["duration"] = d.get("duration_seconds", 0)
        d["lat"] = d.get("latitude")
        d["lng"] = d.get("longitude")
    return d

@router.post("/analyze")
def analyze_case(case_id: str | None = Query(default=None), db: Session = Depends(get_db)):
    """
    Runs multi-agent structural analysis on the active case records.
    """
    try:
        cdr_query = db.query(CDRRecord)
        ipdr_query = db.query(IPDRRecord)
        if case_id:
            cdr_query = cdr_query.filter(CDRRecord.case_id == case_id)
            ipdr_query = ipdr_query.filter(IPDRRecord.case_id == case_id)
            
        cdr_records = [model_to_dict(r) for r in cdr_query.all()]
        ipdr_records = [model_to_dict(r) for r in ipdr_query.all()]
        
        analytics = orchestrator.analyze_case(cdr_records, ipdr_records)
        return {"success": True, "analytics": analytics}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/generate-report")
def generate_report(report_type: str = "full", case_id: str | None = Query(default=None), db: Session = Depends(get_db)):
    """
    Compiles structured agent analytics into a comprehensive markdown report.
    """
    try:
        cdr_query = db.query(CDRRecord)
        ipdr_query = db.query(IPDRRecord)
        if case_id:
            cdr_query = cdr_query.filter(CDRRecord.case_id == case_id)
            ipdr_query = ipdr_query.filter(IPDRRecord.case_id == case_id)
            
        cdr_records = [model_to_dict(r) for r in cdr_query.all()]
        ipdr_records = [model_to_dict(r) for r in ipdr_query.all()]
        
        analytics = orchestrator.analyze_case(cdr_records, ipdr_records)
        report_md = orchestrator.generate_report(analytics, report_type=report_type)
        return {"success": True, "report": report_md}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/knowledge-base")
def get_knowledge_base():
    """
    Exposes the structured application knowledge base.
    """
    kb_path = Path(__file__).parent.parent / "ai" / "knowledge_base.json"
    if not kb_path.exists():
        raise HTTPException(status_code=404, detail="Knowledge base template not found")
    with open(kb_path, "r", encoding="utf-8") as f:
        return json.load(f)

@router.post("/generate-synthetic")
def generate_synthetic(scenario: str = "criminal", case_name: str | None = None, db: Session = Depends(get_db)):
    """
    Generates synthetic case scenarios and inserts them directly into the DB.
    """
    try:
        # Create a new case
        c_name = case_name or f"Synthetic {scenario.capitalize()} Case"
        new_case = Case(name=c_name)
        db.add(new_case)
        db.commit()
        db.refresh(new_case)

        # Generate synthetic records
        data = generate_synthetic_case(scenario=scenario)

        # Add Towers (Upsert)
        for t in data["towers"]:
            existing = db.query(Tower).filter(Tower.tower_id == t["tower_id"]).first()
            if not existing:
                db.add(Tower(
                    tower_id=t["tower_id"],
                    latitude=t.get("lat"),
                    longitude=t.get("lng"),
                    city=t.get("city"),
                    state=t.get("state")
                ))
        db.commit()

        # Add CDR Records
        for c in data["cdr"]:
            ts = c.get("timestamp")
            if isinstance(ts, str):
                try:
                    ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except Exception:
                    ts = datetime.utcnow()
            end_ts = ts
            dur = c.get("duration", 0)
            if dur:
                end_ts = ts + timedelta(seconds=dur)
            db.add(CDRRecord(
                start_time=ts,
                end_time=end_ts,
                duration_seconds=dur,
                msisdn=c.get("msisdn") or c.get("subject"),
                a_party_number=c.get("subject"),
                b_party_number=c.get("counterpart"),
                call_type=c.get("call_type", "Voice"),
                direction=c.get("direction", "MO"),
                tower_id=c.get("tower_id"),
                cell_id=str(c.get("cell_id", "")),
                lac=str(c.get("lac", "")),
                imsi=c.get("imsi"),
                imei=c.get("imei"),
                technology=c.get("technology", "LTE"),
                latitude=c.get("lat"),
                longitude=c.get("lng"),
                case_id=str(new_case.id)
            ))

        # Add IPDR Records
        for i in data["ipdr"]:
            ts = i.get("timestamp")
            if isinstance(ts, str):
                try:
                    ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except Exception:
                    ts = datetime.utcnow()
            end_ts = ts
            dur = i.get("duration", 0)
            if dur:
                end_ts = ts + timedelta(seconds=dur)
            db.add(IPDRRecord(
                start_time=ts,
                end_time=end_ts,
                duration_seconds=dur,
                msisdn=i.get("msisdn") or i.get("subject"),
                source_ip=i.get("counterpart") if i.get("counterpart") and "." in str(i.get("counterpart")) else "10.0.0.1",
                destination_ip=i.get("destination_ip") or i.get("counterpart", ""),
                protocol=i.get("protocol", "TCP"),
                source_port=i.get("source_port", 0),
                destination_port=i.get("destination_port", 0),
                apn=i.get("apn", "internet"),
                imsi=i.get("imsi"),
                imei=i.get("imei"),
                bytes_uploaded=i.get("bytes_uploaded", 0),
                bytes_downloaded=i.get("bytes_downloaded", 0),
                tower_id=i.get("tower_id"),
                cell_id=str(i.get("cell_id", "")),
                lac=str(i.get("lac", "")),
                latitude=i.get("lat"),
                longitude=i.get("lng"),
                rat=i.get("rat", "LTE"),
                case_id=str(new_case.id)
            ))

        db.commit()
        return {
            "success": True,
            "case_id": str(new_case.id),
            "case_name": new_case.name,
            "cdr_inserted": len(data["cdr"]),
            "ipdr_inserted": len(data["ipdr"]),
            "towers_inserted": len(data["towers"])
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/investigate")
def investigate_case(case_id: str | None = Query(default=None), db: Session = Depends(get_db)):
    """
    Runs the full Police Investigator model — all analytics + evidence aggregation.
    """
    try:
        cdr_query = db.query(CDRRecord)
        ipdr_query = db.query(IPDRRecord)
        tower_query = db.query(Tower)

        if case_id:
            cdr_query = cdr_query.filter(CDRRecord.case_id == case_id)
            ipdr_query = ipdr_query.filter(IPDRRecord.case_id == case_id)

        cdr_records = [model_to_dict(r) for r in cdr_query.all()]
        ipdr_records = [model_to_dict(r) for r in ipdr_query.all()]

        # Build towers lookup
        towers = {}
        for t in tower_query.all():
            towers[t.tower_id] = {"tower_id": t.tower_id, "lat": t.latitude, "lng": t.longitude, "city": t.city, "state": t.state}

        investigator = PoliceInvestigator()
        result = investigator.investigate(cdr_records, ipdr_records, towers)
        return {"success": True, "investigation": result}
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat")
def chat_with_finetuned(
    query: str = Query(...),
    context: str | None = Query(default=None),
    case_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    """
    Answers an investigator's question using the fine-tuned TIFM model.
    First runs multi-agent analytics, then feeds analytics + question to the model.
    """
    try:
        cdr_query = db.query(CDRRecord)
        ipdr_query = db.query(IPDRRecord)
        if case_id:
            cdr_query = cdr_query.filter(CDRRecord.case_id == case_id)
            ipdr_query = ipdr_query.filter(IPDRRecord.case_id == case_id)

        cdr_records = [model_to_dict(r) for r in cdr_query.all()]
        ipdr_records = [model_to_dict(r) for r in ipdr_query.all()]

        analytics = orchestrator.analyze_case(cdr_records, ipdr_records)

        context_chips = context.split(",") if context else None

        load_ft_model()
        answer = generate_answer(analytics, query, context_chips=context_chips)
        return {"success": True, "answer": answer, "model": "tifm-finetuned"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/finetune-dataset")
def export_dataset(case_id: str | None = Query(default=None), db: Session = Depends(get_db)):
    """
    Compiles active case records into a training JSONL dataset for QLoRA.
    """
    try:
        cdr_query = db.query(CDRRecord)
        ipdr_query = db.query(IPDRRecord)
        if case_id:
            cdr_query = cdr_query.filter(CDRRecord.case_id == case_id)
            ipdr_query = ipdr_query.filter(IPDRRecord.case_id == case_id)
            
        cdr_records = [model_to_dict(r) for r in cdr_query.all()]
        ipdr_records = [model_to_dict(r) for r in ipdr_query.all()]
        
        # Merge both collections
        records = []
        for c in cdr_records:
            records.append({
                "subject": c["subject"],
                "counterpart": c["counterpart"],
                "tower_id": c["tower_id"],
                "timestamp": c["timestamp"],
                "service": "Voice Call" if c["call_type"] == "Voice" else "SMS"
            })
        for i in ipdr_records: # IPDR conversion
            records.append({
                "subject": i["subject"],
                "counterpart": i.get("destination_ip"),
                "tower_id": i["tower_id"],
                "timestamp": i.get("start_time"),
                "service": "IPDR App"
            })
            
        output_file = Path(__file__).parent.parent / "ai" / "telecom_train.jsonl"
        count_written = export_to_jsonl(records, output_file)
        
        peft_guide = generate_peft_guide()
        
        return {
            "success": True,
            "file_written": str(output_file),
            "records_count": count_written,
            "peft_guide": peft_guide
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
