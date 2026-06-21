from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

# Fine-Tuning Instruct Prompt Templates
PROMPT_TEMPLATE = {
    "system": "You are a Telecom Intelligence Assistant. Analyze the provided Call Detail Records (CDR) and IP Detail Records (IPDR) metadata to identify operational patterns, device/SIM swaps, communication hierarchies, meeting locations, and risk assessments.",
    "instruction_format": "Analyze the subject {subject} communication and mobility profiles based on the metadata summary below."
}

def format_training_example(subject: str, summary_data: dict, analysis_report: str) -> dict:
    """
    Formulate a single dataset entry compatible with Llama 3.1 / Qwen 3 training.
    """
    user_input = {
        "subject": subject,
        "metrics": {
            "total_records": summary_data.get("total_records", 0),
            "unique_contacts": summary_data.get("unique_contacts", 0),
            "unique_towers": summary_data.get("unique_towers", 0),
            "sim_swaps": summary_data.get("sim_swaps", 0),
            "device_changes": summary_data.get("device_changes", 0),
            "night_activity_percentage": summary_data.get("night_activity_pct", 0)
        },
        "top_contacts": summary_data.get("top_contacts", []),
        "top_services": summary_data.get("top_services", [])
    }
    
    return {
        "instruction": PROMPT_TEMPLATE["instruction_format"].format(subject=subject),
        "input": json.dumps(user_input, indent=2),
        "output": analysis_report
    }

def generate_peft_guide() -> str:
    """
    Returns a markdown guide outlining the command line for QLoRA training.
    """
    return """# TIFM QLoRA Fine-Tuning Guide

## Quick Start (Recommended)
Run the full pipeline from the `backend/` directory:
```bash
# Install dependencies
pip install torch transformers accelerate peft bitsandbytes datasets trl

# Generate training data and train
python pipeline_tifm_finetune.py --train

# Or step by step:
python pipeline_tifm_finetune.py --generate-only
python pipeline_tifm_finetune.py --train-only
```

## What This Produces
- **Training data**: `app/ai/tifm_train.jsonl` -- high-quality Q&A pairs grounded in TIFM multi-agent analytics (7 question types, ~70 examples by default)
- **LoRA adapter**: `tifm_lora_output/` -- ready to load in `app/ai/inference.py`
- **Merged model**: `tifm_merged/` -- full weights merged for faster inference

## Using in the App
1. Restart the FastAPI server
2. In the AI Chat tab, select "FINE-TUNED TIFM" from the AI mode dropdown
3. Type any investigation question -- the model answers based on live TIFM analytics

## Customizing the Dataset
Edit `app/ai/training_data.py` to add more question types, adjust subjects,
or include real case data. Adjust `--count` to generate more examples per type:
```bash
python pipeline_tifm_finetune.py --generate-only --count 12
```

## Training Details
- Base model: Qwen/Qwen2.5-7B-Instruct
- Quantization: 4-bit NF4 (QLoRA)
- LoRA rank: 16, alpha: 32
- Max steps: 500, batch size: 2, grad accumulation: 4
- Context length: 4096 tokens

## Under the Hood
The pipeline wraps the 4-bit base model with a PEFT `LoraConfig` and trains it with
TRL's `SFTTrainer`:
```python
from peft import LoraConfig
from trl import SFTTrainer

peft_config = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM")
trainer = SFTTrainer(model=model, train_dataset=dataset, peft_config=peft_config, args=training_args)
trainer.train()
```
"""

def export_to_jsonl(records: list[dict], output_path: str | Path) -> int:
    """
    Exports a list of raw records/cases into a training JSONL format.
    Returns:
        int: Number of training examples written.
    """
    # Group records by subject
    subjects_data = {}
    for r in records:
        sub = r.get("subject")
        if not sub:
            continue
        if sub not in subjects_data:
            subjects_data[sub] = {
                "total_records": 0,
                "contacts": set(),
                "towers": set(),
                "sim_swaps": 0,
                "device_changes": 0,
                "night_count": 0,
                "services": {},
                "contacts_dict": {}
            }
        
        sd = subjects_data[sub]
        sd["total_records"] += 1
        
        # Track counterpart
        cnt = r.get("counterpart")
        if cnt:
            sd["contacts"].add(cnt)
            sd["contacts_dict"][cnt] = sd["contacts_dict"].get(cnt, 0) + 1
            
        # Track tower
        tow = r.get("tower_id")
        if tow:
            sd["towers"].add(tow)
            
        # Check night activity (23:00 - 05:00)
        ts = r.get("timestamp")
        if ts:
            if isinstance(ts, str):
                try:
                    ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except ValueError:
                    ts = None
            if ts:
                if ts.hour >= 23 or ts.hour < 5:
                    sd["night_count"] += 1
                    
        # Track service
        svc = r.get("service") or r.get("subtype") or "Unknown"
        sd["services"][svc] = sd["services"].get(svc, 0) + 1
        
    examples = []
    for sub, sd in subjects_data.items():
        # Compute percentages & details
        night_pct = int((sd["night_count"] / sd["total_records"]) * 100) if sd["total_records"] > 0 else 0
        sorted_contacts = sorted(sd["contacts_dict"].items(), key=lambda x: x[1], reverse=True)[:5]
        sorted_services = sorted(sd["services"].items(), key=lambda x: x[1], reverse=True)[:5]
        
        metrics = {
            "total_records": sd["total_records"],
            "unique_contacts": len(sd["contacts"]),
            "unique_towers": len(sd["towers"]),
            "sim_swaps": sd["sim_swaps"],
            "device_changes": sd["device_changes"],
            "night_activity_pct": night_pct,
            "top_contacts": [c[0] for c in sorted_contacts],
            "top_services": [s[0] for s in sorted_services]
        }
        
        # Construct synthetic analysis response summary
        behaviors = []
        if night_pct > 50:
            behaviors.append("dominant nocturnal activity pattern")
        if len(sd["towers"]) > 5:
            behaviors.append("high spatial mobility across towers")
        if len(sd["contacts"]) > 10:
            behaviors.append("hub network routing topology")
            
        behavior_str = ", ".join(behaviors) if behaviors else "standard communication usage"
        
        report = f"Subject {sub} displays a total of {sd['total_records']} activity instances. " \
                 f"Key signatures show {behavior_str}. " \
                 f"Top contact list includes: {', '.join(metrics['top_contacts'])}. " \
                 f"Primary network protocols are attributed to services: {', '.join(metrics['top_services'])}. " \
                 f"Further analysis suggests this node holds a coordination or routing role within the network."
                 
        examples.append(format_training_example(sub, metrics, report))
        
    with open(output_path, "w", encoding="utf-8") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
            
    return len(examples)
