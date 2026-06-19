# Deployment Guide

## Prerequisites

- Python 3.8+
- PostgreSQL 12+ (optional — SQLite fallback works for lightweight deployments)
- [Ollama](https://ollama.ai/) (optional — for AI Insights functionality)
- A Linux/macOS/Windows server

## Quick Start (Development)

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Linux/macOS
# or: .venv\Scripts\Activate.ps1  # Windows

pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Production Deployment

### 1. Environment Configuration

Create `backend/.env`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/cdrdb
AUTH_SESSION_COOKIE_NAME=gpcssi_session
AUTH_SESSION_TTL_HOURS=168
AUTH_BOOTSTRAP_USERNAME=admin
AUTH_BOOTSTRAP_PASSWORD=<strong-random-password>
AUTH_BOOTSTRAP_ROLE=admin
```

**Change the default password** to a strong random value immediately after first login.

### 2. Systemd Service (Linux)

Create `/etc/systemd/system/cdripdr.service`:

```ini
[Unit]
Description=CDR/IPDR Investigation Visualizer
After=network.target postgresql.service

[Service]
User=www-data
WorkingDirectory=/opt/cdripdr/backend
EnvironmentFile=/opt/cdripdr/backend/.env
ExecStart=/opt/cdripdr/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 4
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable cdripdr
sudo systemctl start cdripdr
```

### 3. Reverse Proxy with Nginx

```nginx
server {
    listen 443 ssl;
    server_name investigation.example.com;

    ssl_certificate /etc/ssl/certs/example.crt;
    ssl_certificate_key /etc/ssl/private/example.key;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 4. Docker Deployment

**Dockerfile:**

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**docker-compose.yml:**

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgresql://user:password@db:5432/cdrdb
      - AUTH_SESSION_COOKIE_NAME=gpcssi_session
      - AUTH_SESSION_TTL_HOURS=168
      - AUTH_BOOTSTRAP_USERNAME=admin
      - AUTH_BOOTSTRAP_PASSWORD=admin12345
    depends_on:
      - db
    volumes:
      - ./backend:/app
    restart: unless-stopped

  db:
    image: postgres:15
    environment:
      - POSTGRES_DB=cdrdb
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=password
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped

volumes:
  pgdata:
```

### 5. Setup Ollama for AI Insights

If using the AI Insights tab:

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull the default model (Gemma 4 E4B, 128K context)
ollama pull gemma4:e4b

# Run Ollama service (default port 11434)
ollama serve
```

The default model `gemma4:e4b` requires approximately 16GB VRAM/System RAM. Alternatives:

| Model | Context | RAM | Quality |
|-------|---------|-----|---------|
| `gemma4:e4b` | 128K | ~16GB | Excellent |
| `llama3.2:3b` | 128K | ~4GB | Good |
| `mistral` | 32K | ~8GB | Very Good |
| `phi3:mini` | 128K | ~4GB | Good |

> **Security note:** AI data is sent to the local Ollama instance only. No data leaves your network.

## Production Checklist

- [ ] Change default admin password
- [ ] Use strong `AUTH_SESSION_COOKIE_NAME` (obscure the cookie name)
- [ ] Set `AUTH_SESSION_TTL_HOURS` appropriately (default: 168 = 7 days)
- [ ] Run behind HTTPS (Nginx/Apache/Caddy reverse proxy)
- [ ] Configure firewall to restrict access to port 8000
- [ ] Use PostgreSQL with proper authentication
- [ ] Set up regular database backups
- [ ] Monitor disk space for CSV uploads and SQLite fallback file
- [ ] Set `--workers` to match CPU cores (production)

## Scaling Considerations

- **Database:** PostgreSQL with connection pooling (e.g., PgBouncer) for high concurrency
- **Static files:** Serve via Nginx directly, not through FastAPI
- **Upload size:** Configure `client_max_body_size` for large CSV files (default limit: 100MB)
- **AI queries:** Each report generation uses significant RAM during inference — consider request queuing for multi-user deployments
