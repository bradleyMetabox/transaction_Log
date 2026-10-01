import express from 'express';
import { requireAdmin, requireTenant } from './auth.js';
import {
  getTransaction,
  importTransactions,
  listTransactions,
  logTransaction,
  recordOutcome,
  verifyChains,
} from './chain.js';
import { query } from './db.js';
import { HttpError } from './errors.js';
import { createTenant, getTenant, rotateKey, setActive } from './tenants.js';
import { docType, logInput, outcomeInput } from './validate.js';

// Express app (no listen). Used by api/index.js on Vercel and scripts/dev.js locally.
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/health', wrap(async (_req, res) => {
  const started = Date.now();
  await query('select 1');
  res.json({ ok: true, db: 'up', dbMs: Date.now() - started });
}));

// ---------- client API (x-api-key) ----------
const v1 = express.Router();
v1.use(requireTenant);

// Log a document and get its invoiceCounter + previousNoteHash.
v1.post('/transactions', wrap(async (req, res) => {
  const result = await logTransaction(req.orgId, logInput(req.body));
  res.status(result.created ? 201 : 200).json({ ok: true, ...result });
}));

// Record MRA's answer.
v1.post('/transactions/:systemId/outcome', wrap(async (req, res) => {
  const result = await recordOutcome(req.orgId, req.params.systemId, outcomeInput(req.body));
  res.json({ ok: true, ...result });
}));

v1.get('/transactions/:systemId', wrap(async (req, res) => {
  res.json({ ok: true, transaction: await getTransaction(req.orgId, req.params.systemId) });
}));

// ?status=FAILED|NOT_YET_FISCALIZED|FISCALIZED&type=STD&limit=50&afterCounter=0
v1.get('/transactions', wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
  if (status && !['NOT_YET_FISCALIZED', 'FISCALIZED', 'FAILED'].includes(status)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'status must be NOT_YET_FISCALIZED, FISCALIZED or FAILED');
  }
  const type = req.query.type ? docType(req.query.type) : undefined;
  const transactions = await listTransactions(req.orgId, {
    status,
    type,
    limit: req.query.limit,
    afterCounter: Number(req.query.afterCounter) || 0,
  });
  res.json({ ok: true, count: transactions.length, transactions });
}));

app.use('/v1', v1);

// ---------- admin API (x-admin-key) ----------
const admin = express.Router();
admin.use(requireAdmin);

admin.post('/tenants', wrap(async (req, res) => {
  res.status(201).json({ ok: true, ...(await createTenant(req.body?.orgId, req.body?.name)) });
}));
admin.get('/tenants/:orgId', wrap(async (req, res) => {
  res.json({ ok: true, tenant: await getTenant(req.params.orgId) });
}));
admin.post('/tenants/:orgId/rotate-key', wrap(async (req, res) => {
  res.json({ ok: true, ...(await rotateKey(req.params.orgId)) });
}));
admin.post('/tenants/:orgId/active', wrap(async (req, res) => {
  res.json({ ok: true, tenant: await setActive(req.params.orgId, req.body?.active !== false) });
}));
admin.post('/tenants/:orgId/import', wrap(async (req, res) => {
  const result = await importTransactions(req.params.orgId, req.body, { force: req.query.force === 'true' });
  res.json({ ok: true, ...result });
}));
admin.get('/tenants/:orgId/verify', wrap(async (req, res) => {
  const type = req.query.type ? docType(req.query.type) : undefined;
  res.json({ ok: true, ...(await verifyChains(req.params.orgId, { type, limit: req.query.limit })) });
}));

app.use('/admin', admin);

// ---------- errors ----------
app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') {
    err = new HttpError(400, 'VALIDATION_ERROR', 'Body is not valid JSON');
  }
  if (err?.code === '55P03') {
    // lock_timeout: another request held this client's chain for too long
    err = new HttpError(503, 'BUSY', 'The chain is busy - retry in a moment');
  }
  if (err?.code === '23505') {
    err = new HttpError(409, 'DUPLICATE', err.detail || 'Duplicate value');
  }
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    ok: false,
    error: {
      code: err instanceof HttpError ? err.code : 'INTERNAL_ERROR',
      message: err instanceof HttpError ? err.message : 'Unexpected server error',
      details: err instanceof HttpError ? err.details : undefined,
    },
  });
});

export default app;
