# Flux Server — Setup

**GitHub:** https://github.com/heimer-dev/flux_server

## Voraussetzungen

- [Docker](https://docs.docker.com/get-docker/) ≥ 24
- [Docker Compose](https://docs.docker.com/compose/) ≥ 2

---

## 1. Repository klonen

```bash
git clone https://github.com/heimer-dev/flux_server.git
cd flux_server
```

---

## 2. Umgebungsvariablen konfigurieren

```bash
cp .env.example .env
nano .env
```

Wichtige Werte anpassen:

```env
PORT=3000
DATABASE_URL=postgresql://flux:flux@postgres:5432/flux
REDIS_URL=redis://redis:6379

# Unbedingt ändern!
JWT_SECRET=dein-langer-zufaelliger-schluessel

# Öffentliche URL des Servers (für Medien-Links)
BASE_URL=http://DEINE-IP:3000

NODE_ENV=production
```

> **JWT_SECRET** sollte ein langer, zufälliger String sein:
> ```bash
> openssl rand -hex 32
> ```

---

## 3. Container starten

```bash
docker compose up -d
```

Startet drei Services:
| Service | Beschreibung |
|---|---|
| `app` | Flux API-Server (Port 3000) |
| `postgres` | PostgreSQL 16 Datenbank |
| `redis` | Redis 7 (Cache + WebSocket Pub/Sub) |

---

## 4. Datenbank initialisieren

**Einmalig nach dem ersten Start ausführen:**

```bash
docker compose exec app node -e "
const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = fs.readFileSync('/app/migrations/001_initial.sql', 'utf8');
pool.query(sql)
  .then(() => { console.log('Datenbank erfolgreich initialisiert'); process.exit(0); })
  .catch(e => { console.error('Fehler:', e.message); process.exit(1); });
"
```

---

## 5. Prüfen ob der Server läuft

```bash
curl http://localhost:3000/api/health
```

Erwartete Antwort:
```json
{"status":"ok","version":"1.0.0","checks":{"database":"ok","redis":"ok"}}
```

---

## Nützliche Befehle

```bash
# Logs anzeigen (live)
docker compose logs -f app

# Server neu starten
docker compose restart app

# Alle Container stoppen
docker compose down

# Alles stoppen + Daten löschen (Vorsicht!)
docker compose down -v
```

---

## Firewall

Port **3000** muss erreichbar sein:

```bash
# UFW (Ubuntu)
ufw allow 3000/tcp

# iptables
iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
```

---

## App verbinden

In der Flux-App beim Onboarding folgende URL eingeben:

```
http://DEINE-SERVER-IP:3000
```
