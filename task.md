# Task Checklist - Telecom Intelligence Copilot (TIFM)

- [x] Create folder `backend/app/ai` and configure `__init__.py`
- [x] Create `backend/app/ai/knowledge_base.json` with structured signatures
- [x] Create `backend/app/ai/dataset_generator.py` for synthetic cases (criminal, drug, scam, trafficking, fraud)
- [x] Create `backend/app/ai/finetune_scaffold.py` to compile PEFT training datasets in JSONL format
- [x] Create `backend/app/ai/agents.py` implementing Attribution, Identity, Movement, Network, and Report agents
- [x] Create `backend/app/ai/orchestrator.py` to coordinate analytics and LLM prompts
- [x] Create `backend/app/api/ai.py` containing FastAPI routes
- [x] Register new router in `backend/app/main.py`
- [ ] Update frontend `backend/static/index.html` to configure backend AI mode
- [ ] Update frontend `backend/static/app.js` to query backend AI and handle synthetic generation pings
- [x] Implement backend test suite `backend/tests/test_ai.py`
- [x] Run test suite and verify UI functionality

## Completed Fixes
- Added missing `ai_router` registration in `main.py`
- Added missing `datetime` imports in `agents.py`, `api/ai.py`, `finetune_scaffold.py`
- Fixed `api/ai.py` IPDR loop (was iterating `cdr_records` twice)
- Fixed `model_to_dict()` to map DB column names (`a_party_number`, `b_party_number`, `start_time`, `duration_seconds`, `latitude`, `longitude`) to agent-friendly fields (`subject`, `counterpart`, `timestamp`, `duration`, `lat`, `lng`)
- Fixed `generate-synthetic` endpoint to use correct `CDRRecord`/`IPDRRecord`/`Tower` model field names
- Added `rat` field to synthetic IPDR records in `dataset_generator.py`
- Fixed `NetworkAgent` empty return dict to use consistent key names
- 33/33 AI unit tests passing
