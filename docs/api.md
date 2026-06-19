# API Reference

All routes are prefixed under the FastAPI application at `http://localhost:8000`. Interactive documentation is available at `/docs` (Swagger UI) and `/redoc` (ReDoc) when the server is running.

## Authentication

All endpoints except those listed below require authentication via an HttpOnly session cookie named `gpcssi_session` (configurable).

**Public endpoints:**
- `POST /auth/login` — Login
- `GET /auth/me` — Check current session (used for cookie-based auth check)
- `GET /health` — Health check
- `GET /` — Serve the SPA
- `GET /static/*` — Static files

### Default Credentials

| Field | Value |
|-------|-------|
| Username | `admin` |
| Password | `admin12345` |

---

## Auth Router (`/auth`)

### `POST /auth/login`

Authenticate with username and password. Returns a session cookie.

**Request body:**
```json
{
  "username": "admin",
  "password": "admin12345"
}
```

**Response `200`:**
```json
{
  "user": {
    "id": 1,
    "username": "admin",
    "role": "admin",
    "is_active": true,
    "created_at": "2025-01-01T00:00:00",
    "last_login_at": null
  },
  "session": {
    "id": 1,
    "created_at": "2025-06-06T12:00:00",
    "expires_at": "2025-06-13T12:00:00",
    "last_seen_at": "2025-06-06T12:00:00",
    "revoked_at": null,
    "user_agent": "Mozilla/5.0 ...",
    "ip_address": "127.0.0.1",
    "is_current": true
  },
  "sessions": [
    { "... same shape as session ..." }
  ]
}
```

**Response `401`:**
```json
{
  "detail": "Invalid username or password"
}
```

---

### `GET /auth/me`

Get the current authenticated user and session info. Used by the frontend for auth state verification and health checks.

**Response `200`:**
```json
{
  "user": { "... AuthUserRead ..." },
  "session": { "... AuthSessionRead ..." },
  "sessions": [ "... list of AuthSessionRead ..." ]
}
```

**Response `401`:**
```json
{
  "detail": "Not authenticated"
}
```

---

### `POST /auth/logout`

Revoke the current session and clear the cookie.

**Response `200`:**
```json
{
  "success": true
}
```

---

### `GET /auth/sessions`

List all active sessions for the current user.

**Response `200`:**
```json
{
  "sessions": [ "... list of AuthSessionRead ..." ]
}
```

---

### `DELETE /auth/sessions`

Revoke all sessions for the current user (logout everywhere).

**Response `200`:**
```json
{
  "success": true
}
```

---

### `DELETE /auth/sessions/{session_id}`

Revoke a specific session by its ID.

**Parameters:** `session_id` (integer, path)

**Response `200`:**
```json
{
  "success": true
}
```

**Response `404`:**
```json
{
  "detail": "Session not found"
}
```

---

### `POST /auth/password`

Change the current user's password.

**Request body:**
```json
{
  "current_password": "old_password",
  "new_password": "new_password"
}
```

**Response `200`:**
```json
{
  "success": true
}
```

**Response `400`:**
```json
{
  "detail": "Current password is incorrect"
}
```

---

## Upload Router (`/upload`)

All upload endpoints accept multipart form data with a `file` field containing a CSV file.

### `POST /upload/cdr`

Upload a CDR CSV file. **Replaces** all existing CDR records (deletes old records before inserting new ones).

**CSV columns expected:**
```
case_id, msisdn, imsi, imei, a_party_number, b_party_number,
call_type, direction, start_time, end_time, duration_seconds,
tower_id, cell_id, lac, latitude, longitude, technology
```

**Response `200`:**
```json
{
  "success": true,
  "records_imported": 1200
}
```

---

### `POST /upload/ipdr`

Upload an IPDR CSV file. **Replaces** all existing IPDR records.

**CSV columns expected:**
```
case_id, msisdn, imsi, imei, start_time, end_time, duration_seconds,
source_ip, destination_ip, source_port, destination_port, protocol,
bytes_uploaded, bytes_downloaded, tower_id, cell_id, lac,
latitude, longitude, apn, rat
```

**Response `200`:**
```json
{
  "success": true,
  "records_imported": 1800
}
```

---

### `POST /upload/towers`

Upload a towers CSV file. **Merges** with existing towers (upserts by `tower_id`).

**CSV columns expected:**
```
tower_id, latitude, longitude, city, state
```

**Response `200`:**
```json
{
  "success": true,
  "records_imported": 60
}
```

---

## Records Router (`/records`)

### `GET /records/cdr`

List CDR records with optional filters.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start_date` | string (ISO) | — | Filter records after this date |
| `end_date` | string (ISO) | — | Filter records before this date |
| `tower_id` | string | — | Filter by tower ID |
| `search` | string | — | Search across msisdn, imsi, imei, a_party, b_party |
| `msisdn` | string | — | Filter by MSISDN |
| `imsi` | string | — | Filter by IMSI |
| `imei` | string | — | Filter by IMEI |
| `call_type` | string | — | Filter by call type (VOICE, SMS, VIDEO, etc.) |
| `direction` | string | — | Filter by direction (MO, MT, ROAMING) |
| `limit` | integer | 0 (unlimited) | Maximum records to return |
| `offset` | integer | 0 | Number of records to skip |

**Response `200`:**
```json
{
  "records": [
    {
      "id": 1,
      "case_id": "CASE-001",
      "msisdn": "91111111111",
      "imsi": "310150123456789",
      "imei": "359881234567890",
      "a_party_number": "91111111111",
      "b_party_number": "9000000120",
      "call_type": "VOICE",
      "direction": "MO",
      "start_time": "2025-06-01T10:30:00",
      "end_time": "2025-06-01T10:32:15",
      "duration_seconds": 135,
      "tower_id": "DEL-001",
      "cell_id": "CELL-A1",
      "lac": "31015",
      "latitude": 28.6129,
      "longitude": 77.2295,
      "technology": "4G"
    }
  ]
}
```

---

### `GET /records/ipdr`

List IPDR records with optional filters.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start_date` | string (ISO) | — | Filter records after this date |
| `end_date` | string (ISO) | — | Filter records before this date |
| `tower_id` | string | — | Filter by tower ID |
| `search` | string | — | Search across msisdn, imsi, imei, source_ip, destination_ip |
| `msisdn` | string | — | Filter by MSISDN |
| `imsi` | string | — | Filter by IMSI |
| `imei` | string | — | Filter by IMEI |
| `protocol` | string | — | Filter by protocol (TCP, UDP, TLS, etc.) |
| `apn` | string | — | Filter by APN (internet, wap, mms, etc.) |
| `rat` | string | — | Filter by RAT (LTE, UMTS, NR, etc.) |
| `limit` | integer | 0 (unlimited) | Maximum records to return |
| `offset` | integer | 0 | Number of records to skip |

**Response `200`:**
```json
{
  "records": [
    {
      "id": 1,
      "case_id": "CASE-001",
      "msisdn": "91111111111",
      "imsi": "310150123456789",
      "imei": "359881234567890",
      "start_time": "2025-06-01T10:30:00",
      "end_time": "2025-06-01T10:32:15",
      "duration_seconds": 135,
      "source_ip": "10.1.0.1",
      "destination_ip": "93.184.216.34",
      "source_port": 54321,
      "destination_port": 443,
      "protocol": "TLS",
      "bytes_uploaded": 2048,
      "bytes_downloaded": 16384,
      "tower_id": "DEL-001",
      "cell_id": "CELL-A1",
      "lac": "31015",
      "latitude": 28.6129,
      "longitude": 77.2295,
      "apn": "internet",
      "rat": "LTE"
    }
  ]
}
```

---

### `DELETE /records/reset`

Delete all CDR, IPDR, and Tower records from the database.

**Response `200`:**
```json
{
  "success": true,
  "message": "All records have been deleted"
}
```

---

## Geo Router (`/geo`)

### `GET /geo/records`

Get all geo-tagged CDR and IPDR records.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `subject` | string | — | Filter by subject (msisdn or source_ip) |

**Response `200`:**
```json
{
  "records": [
    {
      "id": 1,
      "type": "CDR",
      "subject": "91111111111",
      "counterpart": "9000000120",
      "latitude": 28.6129,
      "longitude": 77.2295,
      "tower_id": "DEL-001",
      "start_time": "2025-06-01T10:30:00",
      "call_type": "VOICE"
    }
  ]
}
```

---

### `GET /geo/subjects`

Get all unique subjects (phone numbers or IP addresses) with their record counts.

**Response `200`:**
```json
{
  "subjects": [
    "91111111111",
    "10.1.0.1"
  ]
}
```

---

### `GET /geo/towers`

Get all tower locations.

**Response `200`:**
```json
{
  "towers": [
    {
      "tower_id": "DEL-001",
      "latitude": 28.6129,
      "longitude": 77.2295,
      "city": "New Delhi",
      "state": "Delhi"
    }
  ]
}
```

---

## Investigation Router (`/investigation`)

### `GET /investigation/timeline`

Build a unified timeline of CDR calls, IPDR sessions, and tower events.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 100 | Maximum events to return |

**Response `200`:**
```json
{
  "events": [
    {
      "type": "CDR",
      "subject": "91111111111",
      "counterpart": "9000000120",
      "start_time": "2025-06-01T10:30:00",
      "end_time": "2025-06-01T10:32:15",
      "service": "voice",
      "tower_id": "DEL-001",
      "latitude": 28.6129,
      "longitude": 77.2295
    }
  ]
}
```

---

### `GET /investigation/services`

Summarize services detected in IPDR records.

**Response `200`:**
```json
{
  "services": [
    {
      "service": "web",
      "count": 450,
      "protocols": ["TLS", "TCP"]
    }
  ]
}
```

---

### `GET /investigation/towers`

List tower activity with event counts.

**Response `200`:**
```json
{
  "towers": [
    {
      "tower_id": "DEL-001",
      "latitude": 28.6129,
      "longitude": 77.2295,
      "city": "New Delhi",
      "cdr_count": 45,
      "ipdr_count": 120,
      "total": 165
    }
  ]
}
```

---

### `GET /investigation/colocation`

Find towers where multiple subjects appear (potential meet points).

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 50 | Maximum candidates to return |

**Response `200`:**
```json
{
  "candidates": [
    {
      "tower_id": "DEL-001",
      "latitude": 28.6129,
      "longitude": 77.2295,
      "subjects": ["91111111111", "9000000120"],
      "overlap_count": 12
    }
  ]
}
```

---

## Graph Router (`/graph`)

### `GET /graph/`

Build a connectivity graph from CDR records.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start_date` | string (ISO) | — | Filter records after this date |
| `end_date` | string (ISO) | — | Filter records before this date |

**Response `200`:**
```json
{
  "nodes": [
    {
      "id": "91111111111",
      "label": "91111111111",
      "type": "msisdn",
      "weight": 45
    }
  ],
  "edges": [
    {
      "source": "91111111111",
      "target": "9000000120",
      "weight": 12,
      "direction": "MO",
      "call_types": ["VOICE", "SMS"]
    }
  ]
}
```

---

### `GET /graph/metrics`

Get graph centrality and community metrics.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start_date` | string (ISO) | — | Filter records after this date |
| `end_date` | string (ISO) | — | Filter records before this date |

**Response `200`:**
```json
{
  "degree_centrality": { "91111111111": 0.85 },
  "betweenness_centrality": { "91111111111": 0.42 },
  "communities": [
    ["91111111111", "9000000120", "9000000121"]
  ],
  "bridges": [
    {
      "source": "91111111111",
      "target": "9000000120"
    }
  ]
}
```

---

## Timeline Router (`/timeline`)

### `GET /timeline/`

Get a sorted list of timeline events (CDR calls, IPDR sessions, tower registrations).

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 500 | Maximum events to return |

**Response `200`:**
```json
{
  "events": [
    {
      "type": "CDR",
      "timestamp": "2025-06-01T10:30:00",
      "subject": "91111111111",
      "counterpart": "9000000120",
      "details": { "... record data ..." }
    }
  ]
}
```

---

## Statistics Router (`/stats`)

### `GET /stats/top-contacts`

Get the top 10 most frequent contacts.

**Response `200`:**
```json
{
  "contacts": [
    {
      "msisdn": "9000000120",
      "count": 45
    }
  ]
}
```

---

### `GET /stats/cdr`

Get aggregate CDR statistics.

**Response `200`:**
```json
{
  "total_records": 1200,
  "total_duration_minutes": 4560,
  "avg_duration_seconds": 135,
  "call_types": { "VOICE": 800, "SMS": 300, "VIDEO": 100 },
  "directions": { "MO": 650, "MT": 550 },
  "technologies": { "4G": 600, "5G": 400, "3G": 200 },
  "unique_msisdns": 200,
  "unique_towers": 60
}
```

---

### `GET /stats/ipdr`

Get aggregate IPDR statistics.

**Response `200`:**
```json
{
  "total_records": 1800,
  "total_bytes_up": 52428800,
  "total_bytes_down": 209715200,
  "avg_duration_seconds": 300,
  "protocols": { "TCP": 800, "UDP": 600, "TLS": 400 },
  "apns": { "internet": 1200, "wap": 400, "mms": 200 },
  "rats": { "LTE": 1200, "NR": 400, "UMTS": 200 },
  "unique_ips": 180,
  "unique_towers": 60
}
```

---

## Other Routes

### `GET /health`

Simple health check endpoint (no auth required).

**Response `200`:**
```json
{
  "status": "ok"
}
```

### `GET /`

Serves the main SPA (`index.html`). No auth required — the SPA handles authentication client-side.

### `GET /static/*`

Serves static files from the `backend/static/` directory (CSS, JS, etc.).
