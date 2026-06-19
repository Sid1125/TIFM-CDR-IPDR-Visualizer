# Telecom Intelligence Copilot (TIFM) Architecture

This plan introduces a dedicated AI module (`app/ai`) to establish a domain-specific **Telecom Investigation Copilot** for GPCSSI. It follows a multi-tiered architecture that combines deterministic rule engines and structured domain-specific telecom knowledge with LLM-based reasoning and multi-agent report generation.

## User Review Required

> [!IMPORTANT]
> The AI Insights tab currently points directly to local Ollama endpoints (port 11434) from the frontend client. We propose adding backend API endpoints (`/api/ai/*`) that run our Multi-Agent intelligence orchestrator. This allows GPCSSI to process data locally, run graph and spatial engines on the server, and then pass consolidated evidence to a local LLM.

## Open Questions
No immediate blocker questions. We will implement standard ports, protocols, and signatures based on telecom investigation guidelines.

---

## Proposed Changes

We will create a new package `app/ai` under `backend/app` containing the knowledge base, dataset generator, fine-tuning script, multi-agent engine, and backend routers.

### 1. New Folder Structure: `backend/app/ai`

#### [NEW] [__init__.py](file:///d:/GPCSSI_NEW/backend/app/ai/__init__.py)
Exposes the core AI orchestrator and agents.

#### [NEW] [knowledge_base.json](file:///d:/GPCSSI_NEW/backend/app/ai/knowledge_base.json)
Contains deterministic signatures (ports, protocols, domains, ASN, traffic indicators, confidence levels) for key apps:
- WhatsApp, Telegram, Signal, Discord, Instagram, Facebook, Google Meet, Zoom, MS Teams, FaceTime, Steam, VPNs (OpenVPN, WireGuard), CDNs (Cloudflare), Torrents, Gaming, etc.

#### [NEW] [dataset_generator.py](file:///d:/GPCSSI_NEW/backend/app/ai/dataset_generator.py)
Generates high-fidelity synthetic CDR/IPDR datasets mapping criminal network patterns:
- **Criminal Network:** Leader, Courier, Lookout, Runner.
- **Drug Network:** Night activity, burner phones, frequent SIM swaps.
- **Scam Network:** One-to-many communication, mass victim contacts.
- **Human Trafficking Pattern:** Movement corridors, multiple devices.
- **Financial Fraud:** Call clusters, disposable numbers.

#### [NEW] [finetune_scaffold.py](file:///d:/GPCSSI_NEW/backend/app/ai/finetune_scaffold.py)
Provides prompt templates and dataset formatting utilities (producing JSONL training samples) for Qwen 3 (8B/14B), Llama 3.1 8B, and Mistral 7B using LoRA/QLoRA/PEFT parameters.

#### [NEW] [agents.py](file:///d:/GPCSSI_NEW/backend/app/ai/agents.py)
Implements five specialized telecom investigation agents:
- **Service Attribution Agent:** Evaluates app-usage confidence based on ports, protocols, and data packets.
- **Identity Agent:** Detects SIM swaps, device swaps, burner phone cycles, and identity clusters.
- **Movement Agent:** Calculates home/work towers, travel patterns, and co-location/meeting probability.
- **Network Agent:** Identifies community structures, centrality metrics, kingpins, and bridge nodes using NetworkX.
- **Report Agent:** Consolidates agent findings into polished digital forensics summaries (Executive, Communication, Location, Subject, Full Report).

#### [NEW] [orchestrator.py](file:///d:/GPCSSI_NEW/backend/app/ai/orchestrator.py)
Coordinates the analytical engines, invokes the multi-agent system, builds the LLM prompt context, and queries the local LLM to get the final copilot report.

---

### 2. Integration with FastAPI Backend

#### [NEW] [ai.py](file:///d:/GPCSSI_NEW/backend/app/api/ai.py)
FastAPI router containing the following endpoints:
- `POST /ai/analyze` - Runs the agent orchestrator on current case data.
- `POST /ai/generate-report` - Generates a forensic markdown report.
- `GET /ai/knowledge-base` - Returns the structured knowledge base.
- `POST /ai/generate-synthetic` - Generates and seeds synthetic case data.
- `GET /ai/finetune-dataset` - Exports active/synthetic case data in JSONL format.

#### [MODIFY] [main.py](file:///d:/GPCSSI_NEW/backend/app/main.py)
Imports and registers the new `ai_router` under `/ai`.

---

### 3. Frontend UI Integration

#### [MODIFY] [index.html](file:///d:/GPCSSI_NEW/backend/static/index.html)
Adds a toggle/dropdown in the AI Insights configuration panel to select the model source:
- **Local Ollama** (direct browser query)
- **Telecom Copilot Backend** (uses the backend orchestrator and agents)
Adds a button/dialog to trigger synthetic case seeding.

#### [MODIFY] [app.js](file:///d:/GPCSSI_NEW/backend/static/app.js)
Integrates the backend `/ai/` endpoints, allowing seamless switching between local browser Ollama queries and backend multi-agent queries.

---

## Verification Plan

### Automated Tests
We will add a new test file:
- `backend/tests/test_ai.py`
To verify:
1. Dynamic generation of synthetic network cases.
2. Knowledge base parsing.
3. Multi-agent analytical outputs.
4. FastAPI endpoints.

### Manual Verification
1. Run backend server: `uvicorn app.main:app --reload`
2. Open AI Insights tab in browser, toggle connection to "Telecom Copilot Backend".
3. Trigger an AI Analysis and verify the multi-agent report compiles correctly.
4. Export a fine-tuning dataset and check the generated JSONL structures.
