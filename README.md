# MRA chain service

A small Express API that takes over the job of the Zoho `cm_transaction_log` module.
It stores each document's chain values, and hands out the `invoiceCounter` and the
per-type `previousNoteHash`. Zoho still builds the payload and posts it to
`api-einvoicing.metabox.technology` exactly as before. The middleware is not touched.

**Why:** in Zoho, each sale finds its predecessor by searching the log. Two sales a few
seconds apart can read the same predecessor and get the same hash, and the search gets
slower as the log grows. Here every new transaction for a client takes a row lock on
that client first. Sales are handled strictly one at a time, and the predecessor is one
index lookup. The test suite fires 80 sales at once and checks that every counter is
unique and every hash links to the true previous document.

Stack: Node 20+, Express 4, `pg`, Neon Postgres, deployed on Vercel.

---

## How a sale flows

```
Zoho POS/Books (Deluge)                    Chain service                       Middleware
 1. POST /v1/transactions  ───────────────▶ lock client, counter+1,
    {systemId,type,number,total,brn,...}    hash of previous same-type doc
                           ◀─────────────── {counter, previousNoteHash, ...}
 2. build payload from those values
 3. POST payload ─────────────────────────────────────────────────────────▶ api-einvoicing...
 4. POST /v1/transactions/:id/outcome ────▶ FISCALIZED + IRN  (or FAILED + error)
```

The hash is exactly the Deluge formula:
`UPPER(SHA-256(dateTime + totalAmtPaid + brn + invoiceIdentifier))` of the previous
document of the same type. `dateTime` is the stored `yyyy-MM-dd HH:mm:ss` with the
dashes removed. The test suite checks it against the live SI-5 → SI-6 link.

Rules that carry over from the Zoho logger:
- `invoiceCounter` is global per client. `previousNoteHash` is per document type
  (STD, CRN, DRN, PRF, TRN), and the first document of a type gets `"0"`.
- Hash inputs are stored as text and used verbatim. New totals are stored with exactly
  two decimals (`"115"` becomes `"115.00"`). Deluge must send back the returned
  `totalAmount` as `totalAmtPaid`, unchanged.
- **Logging the same `systemId` again returns the same counter, hash and date.**
  Retries and double-fired workflows are therefore safe.
- **A logged sale that changed** (number, total or BRN) is refreshed only while it is
  not fiscalised **and** no later document of its type is chained to it. Otherwise
  the service answers `409 CHAIN_LOCKED`. A change of type gives `409 TYPE_MISMATCH`.
- `FISCALIZED` is final.

---

## API

Every response is JSON with `ok: true|false`. Errors look like
`{ "ok": false, "error": { "code", "message", "details" } }`.

### Client endpoints: header `x-api-key: <the client's key>`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/transactions` | Log a document, or get the values it was already logged with |
| POST | `/v1/transactions/:systemId/outcome` | Record MRA's answer |
| GET | `/v1/transactions/:systemId` | Read one document |
| GET | `/v1/transactions?status=FAILED&type=STD&limit=50&afterCounter=0` | List documents, oldest first (for retries) |

**POST /v1/transactions**
```json
{
  "systemId": "1538056000000095536",
  "type": "STD",
  "number": "SI-6",
  "totalAmount": "115.00",
  "brn": "",
  "currency": "MUR",
  "issuedDateTime": "2026-09-29 11:57:59"
}
```
- `type` takes STD, CRN, DRN, PRF, TRN, or the Zoho labels ("Standard Invoice", "Credit Note"…).
- `201` means newly logged; `200` means it was already logged.

Response:
```json
{
  "ok": true,
  "created": true,
  "refreshed": false,
  "transaction": {
    "systemId": "1538056000000095536", "type": "STD", "counter": 3,
    "previousNoteHash": "A68AFB96…5B98", "issuedDateTime": "2026-09-29 11:57:59",
    "number": "SI-6", "totalAmount": "115.00", "brn": "", "currency": "MUR",
    "status": "NOT_YET_FISCALIZED", "irn": null
  },
  "predecessor": { "number": "SI-5", "counter": 2 }
}
```

**POST /v1/transactions/:systemId/outcome** takes either
`{ "status": "FISCALIZED", "irn": "…" }` or `{ "status": "FAILED", "error": "…" }`.

### Admin endpoints: header `x-admin-key: <ADMIN_API_KEY>`

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/tenants` `{orgId, name}` | Register a client; returns its API key **once** |
| GET | `/admin/tenants/:orgId` | Client summary (last counter, row count) |
| POST | `/admin/tenants/:orgId/rotate-key` | Issue a new key; the old one stops working |
| POST | `/admin/tenants/:orgId/active` `{active:false}` | Suspend a client, or reactivate it |
| POST | `/admin/tenants/:orgId/import` | Seed the client's existing chain (see go-live) |
| GET | `/admin/tenants/:orgId/verify?type=STD&limit=1000` | Recompute every hash link and report mismatches |

### Error codes
| HTTP | code | Meaning |
|---|---|---|
| 400 | VALIDATION_ERROR | Bad input, e.g. a date that isn't `yyyy-MM-dd HH:mm:ss` or an amount with 3 decimals |
| 401 | UNAUTHORIZED | Missing or wrong key |
| 403 | TENANT_INACTIVE | Client suspended |
| 404 | NOT_FOUND | Unknown `systemId` or route |
| 409 | CHAIN_LOCKED | Changed after logging, and a later document is already chained to it |
| 409 | TYPE_MISMATCH | Already logged in another type's chain |
| 409 | ALREADY_FISCALIZED | An outcome tried to change a fiscalised document |
| 409 | IMPORT_AFTER_LIVE | Import refused: the service has already logged sales for this client |
| 503 | BUSY | The chain lock waited more than 8 s; retry |

---

## Set up

### 1. Neon
1. Create a project. Pick a region close to your Vercel region; for Zoho's US data
   centre, AWS us-east-1 is a good fit.
2. Copy **two** connection strings:
   - the **pooled** one (host contains `-pooler`) for the running service;
   - the **direct** one for running migrations.
3. Neon suspends an idle database after a few minutes by default. The first request
   after a quiet spell is then slower (well under a second to a couple of seconds).
   For a POS, turn scale-to-zero off if your Neon plan allows it.

### 2. Local
```bash
npm install
cp .env.example .env      # DATABASE_URL = the DIRECT string for now, ADMIN_API_KEY = long random secret
npm run migrate           # creates the tables
npm run create-tenant -- 941108254 "Client name"   # prints the client's API key - store it
npm run dev               # http://localhost:3000/health
```

### 3. Vercel
1. Push this folder to a Git repository and import it in Vercel. No framework preset
   or build command is needed: `api/index.js` is the function, and `vercel.json`
   routes every path to it.
2. Environment variables (Production):
   - `DATABASE_URL` = the Neon **pooled** connection string
   - `ADMIN_API_KEY` = the same long random secret
   - optional `PG_POOL_MAX` (default 5)
3. Project Settings → Functions → Region: the same region as Neon (us-east-1 = `iad1`).
4. Deploy, then open `https://<project>.vercel.app/health`. It should answer
   `{"ok":true,"db":"up"}`.

Neon's integration in the Vercel marketplace can create the database and set
`DATABASE_URL` for you. If you use it, make sure the value is the pooled string.

---

## Go-live for a client

1. **Register the client:** `npm run create-tenant -- <orgId> "<name>"`, or
   `POST /admin/tenants`. Keep the API key.
2. **Freeze the old logger.** Disable the workflow, button or scheduler that writes to
   `cm_transaction_log`, so the Zoho log stops moving.
3. **Import the existing chain.** Run the Deluge function `Export_Chain_To_Service.dg`
   once in that Zoho organisation, after setting its constants. It sends:
   - the last document of each type;
   - every document not yet fiscalised;
   - the highest counter used so far.

   Check the returned `heads`: `nextPreviousNoteHash` is the hash the next document of
   that type will carry. For a brand-new client with no history, skip this step;
   chains then start at counter 1 and hash `"0"`.
4. **Switch the Deluge function.** Set `CHAIN_SERVICE_URL` and `CHAIN_SERVICE_KEY` at the
   top of `LogAndFiscalize_Invoice_POS.dg`. Alternatively, add the text fields
   `cf_chain_service_url` and `cf_chain_service_key` to the e-Invoicing Configuration;
   they take priority.
5. **Test one sale, then verify:** `GET /admin/tenants/<orgId>/verify` should return
   `"ok": true`.

Once the service has logged a client's first sale, it refuses further imports for that
client unless you pass `?force=true`. Importing older rows after live sales could
otherwise reorder a chain.

---

## Operations
- **Backups:** Neon keeps point-in-time history (restore window depends on the plan).
  This database is now the source of truth for the chains, so treat it like
  production accounting data.
- **Keys:** only SHA-256 hashes of client keys are stored. A lost key is replaced
  with `rotate-key`.
- **Retries:** `GET /v1/transactions?status=FAILED` lists failed documents in counter
  order, each with its original counter and hash, ready for a retry job.
- **Not covered:** the wait in Zoho's own workflow queue before the Deluge function
  starts. The service removes the work after that point and the shared-hash race, not
  Zoho's queue.

## Tests
```bash
npm test                                                          # unit tests
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/chain_test npm test   # + integration (DROPS the tables in that DB)
```
