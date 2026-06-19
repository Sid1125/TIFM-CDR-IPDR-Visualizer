# Development Guide

## Project Setup

```bash
# Clone and enter project
git clone <repo-url>
cd cdripdr-investigation-visualizer

# Backend setup
cd backend
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\Activate.ps1
pip install -r requirements.txt

# Generate sample data
python scripts/generate_sample_data.py

# Run development server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Project Structure

```
backend/
├── app/
│   ├── main.py              # FastAPI app creation, router registration
│   ├── api/                  # Route handlers (one per domain)
│   ├── core/                 # Config, database engine
│   ├── models/               # SQLAlchemy ORM models
│   ├── schemas/              # Pydantic request/response schemas
│   ├── services/             # Business logic
│   ├── utils/                # Helpers and validators
│   └── scripts/              # Utility scripts
├── static/                   # Frontend SPA files
├── sample_data/              # Generated sample CSVs
├── .env                      # Environment configuration
└── requirements.txt          # Python dependencies
```

## Code Style Guidelines

### Python

- **Formatting:** Follow PEP 8. Use `black` if desired (no config provided).
- **Imports:** Standard library → third-party → local, separated by blank lines.
- **Type hints:** Use Python type hints for all function parameters and return values.
- **Docstrings:** Use docstrings for public functions describing purpose, params, and returns.
- **Naming:**
  - Functions/variables: `snake_case`
  - Classes: `PascalCase`
  - Constants: `UPPER_SNAKE_CASE`
  - Private functions: `_leading_underscore`

### JavaScript

- **Formatting:** ES5-compatible syntax (no transpiler/build step).
- **Naming:**
  - Functions/variables: `camelCase`
  - Constants/maps: `UPPER_SNAKE_CASE`
  - Global state: `camelCase` (`state.cdr`, `allRows`, `recPage`)
  - DOM cache object: `D` with `camelCase` keys
- **Patterns:**
  - Use `const` for DOM refs and constants, `let` for mutable state
  - Avoid `var`
  - Use arrow functions for callbacks where `this` binding isn't needed
  - Wrap async calls in try/catch with user-facing error messages

### CSS

- **Custom properties:** Use `--var-name` for all colors and repeated values.
- **Naming:** `kebab-case` class names.
- **Layout:** Flexbox preferred over float/grid.
- **Scoping:** Prefix component classes (`.tl-*`, `.ai-*`, `.rec-*`, `.dash-*`).

## Adding a New API Endpoint

1. **Create/update the route handler** in `backend/app/api/` — define a new function with the FastAPI decorator
2. **Add the service function** in `backend/app/services/` — implement business logic
3. **Add Pydantic schemas** if new request/response shapes are needed — in `backend/app/schemas/`
4. **Register the router** in `backend/app/main.py` — add `app.include_router()`
5. **Add the endpoint documentation** to `docs/api.md`

Example:

```python
# backend/app/api/example.py
from fastapi import APIRouter, Depends
from app.services.auth_service import get_current_user
from app.models.auth import User

router = APIRouter()

@router.get("/example")
def example_endpoint(current_user: User = Depends(get_current_user)):
    return {"message": f"Hello, {current_user.username}"}
```

## Adding a New Database Model

1. Create the model file in `backend/app/models/`
2. Define the SQLAlchemy class extending `Base`
3. Create corresponding Pydantic schemas in `backend/app/schemas/`
4. Import the model in `backend/app/main.py` (line ~24) to ensure it's registered
5. Run the app — tables are auto-created on startup

## Frontend Development

### Adding a New Tab

1. **Add section HTML** in `index.html` before the profile modal:
   ```html
   <section id="myTab" class="tab-content">
     <div class="my-tab-content">
       ... your HTML ...
     </div>
   </section>
   ```
2. **Add tab button** in the `.topbar-tabs` div:
   ```html
   <button class="topbar-tab" data-tab="myTab">My Tab</button>
   ```
3. **Add CSS** in `styles.css` for your tab's layout
4. **Add render function** in `app.js`:
   ```javascript
   function renderMyTab(){
     // Your rendering logic
   }
   ```
5. **Add tab switch handler** in the tabs event listener section:
   ```javascript
   if(id==='myTab') renderMyTab();
   ```

### Key Frontend Patterns

**Loading data on tab switch:**
```javascript
function switchTab(id){
  // ... existing tab switch logic ...
  if(id==='records' && !state.cdr.length) loadRecords();
  if(id==='myTab' && !allRows.length) return;
  if(id==='myTab') renderMyTab();
}
```

**Safe Chart.js lifecycle:**
```javascript
function renderMyChart(canvas, config){
  try{ window.myChart.destroy() }catch(e){}
  window.myChart = null;
  window.myChart = new Chart(canvas.getContext('2d'), config);
}
```

**API call pattern:**
```javascript
async function getData(){
  try{
    const res=await fetch('/api/endpoint',{ credentials:'include' });
    if(!res.ok) throw new Error(await res.text());
    return await res.json();
  }catch(e){
    console.error('Failed to load data:',e);
    return null;
  }
}
```

## Database

### Schema Migrations

The app uses SQLAlchemy's `Base.metadata.create_all()` on startup — this creates tables if they don't exist but does NOT handle schema changes. For production with existing data:

- Manually write ALTER TABLE statements
- Or use a migration tool like Alembic

### SQLite vs PostgreSQL

Development is easiest with SQLite (no setup required). Production should use PostgreSQL.

Key differences to be aware of:
- SQLite has limited ALTER TABLE support
- SQLite doesn't enforce foreign key constraints by default
- Date/time functions differ slightly

## Testing

Currently no test framework is configured. To add tests:

1. Install pytest: `pip install pytest httpx`
2. Create `tests/` directory in `backend/`
3. Follow FastAPI's testing guide using `TestClient`

Example test structure:
```
backend/tests/
├── conftest.py        # Test fixtures (test DB, client, auth)
├── test_auth.py       # Authentication tests
├── test_records.py    # Records endpoint tests
└── test_frontend/     # Future: Selenium/Playwright E2E tests
```

## Sample Data

The generator script `backend/scripts/generate_sample_data.py` produces deterministic sample data (seeded with `random.seed(42)`). After modifying models, update the generator to produce valid test data.

```bash
cd backend
python scripts/generate_sample_data.py
```

Generated files appear in `backend/sample_data/`:
- `towers_sample.csv` — 60 towers across 10 Indian cities
- `cdr_sample.csv` — 1200 call records
- `ipdr_sample.csv` — 1800 IP session records

## Common Tasks

### Reset All Data

Via API:
```bash
curl -X DELETE http://localhost:8000/records/reset \
  -b "gpcssi_session=<token>"
```

Manual:
```bash
rm backend/cdrdb.sqlite3
```

### View Database

```bash
sqlite3 backend/cdrdb.sqlite3
.tables
SELECT COUNT(*) FROM cdr_records;
```

### Debug API Calls

All endpoints are documented at `http://localhost:8000/docs` (Swagger UI) when the server is running.

## Contribution Workflow

1. Create a feature branch from `main`
2. Make changes following code style guidelines
3. Test with sample data
4. Update documentation if adding/modifying features
5. Submit a pull request

## Documentation

Documentation files live in `docs/`:
- `api.md` — Full API reference
- `architecture.md` — System design
- `frontend.md` — Frontend guide
- `deployment.md` — Deployment instructions
- `development.md` — This guide

Keep documentation in sync with code changes.
