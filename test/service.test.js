// Integration tests against a real Postgres. Skipped unless TEST_DATABASE_URL is set.
//   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/chain_test npm test
// WARNING: drops and recreates the tables in that database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

const url = process.env.TEST_DATABASE_URL;

describe('chain service (integration)', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let base;
  let server;
  let db;
  const ADMIN = 'test-admin-key-0123456789';
  const ORG = '941108254';
  let key;

  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const asClient = (method, path, body) => call(method, path, body, { 'x-api-key': key });
  const asAdmin = (method, path, body) => call(method, path, body, { 'x-admin-key': ADMIN });
  const sale = (systemId, number, totalAmount, type = 'STD', extra = {}) =>
    asClient('POST', '/v1/transactions', {
      systemId,
      type,
      number,
      totalAmount,
      brn: '',
      currency: 'MUR',
      issuedDateTime: '2026-10-01 10:00:00',
      ...extra,
    });

  before(async () => {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_API_KEY = ADMIN;
    process.env.PG_POOL_MAX = '10';
    db = await import('../src/db.js');
    await db.query('drop table if exists transactions; drop table if exists tenants;');
    await db.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    const { default: app } = await import('../src/http.js');
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    await db?.closePool();
  });

  test('admin creates the tenant; keys are required and checked', async () => {
    const noAdmin = await call('POST', '/admin/tenants', { orgId: ORG });
    assert.equal(noAdmin.status, 401);
    const created = await asAdmin('POST', '/admin/tenants', { orgId: ORG, name: 'POS test org' });
    assert.equal(created.status, 201);
    key = created.body.apiKey;
    assert.match(key, /^mcs_/);
    const dup = await asAdmin('POST', '/admin/tenants', { orgId: ORG });
    assert.equal(dup.status, 409);
    const noKey = await call('POST', '/v1/transactions', {});
    assert.equal(noKey.status, 401);
    const badKey = await call('GET', '/v1/transactions', undefined, { 'x-api-key': 'mcs_wrong' });
    assert.equal(badKey.status, 401);
  });

  test('import seeds the existing Zoho chain; next sale continues it exactly like Zoho did', async () => {
    const imp = await asAdmin('POST', `/admin/tenants/${ORG}/import`, {
      lastCounter: 2,
      transactions: [
        { systemId: 'z-si5', type: 'Standard Invoice', counter: 2, number: 'SI-5', totalAmount: '201.25', brn: '',
          issuedDateTime: '2026-09-29 11:55:21', previousNoteHash: '0', status: 'FISCALIZED', irn: 'IRN-5' },
      ],
    });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.equal(imp.body.lastCounter, 2);
    assert.equal(imp.body.heads.STD.nextPreviousNoteHash, 'A68AFB9614D55457F87D62CDB24DD271B618D8AED8B5531CBBAF248525325B98');

    const si6 = await asClient('POST', '/v1/transactions', {
      systemId: '1538056000000095536', type: 'STD', number: 'SI-6', totalAmount: '115',
      brn: '', issuedDateTime: '2026-09-29 11:57:59',
    });
    assert.equal(si6.status, 201, JSON.stringify(si6.body));
    assert.equal(si6.body.created, true);
    assert.equal(si6.body.transaction.counter, 3);
    assert.equal(si6.body.transaction.totalAmount, '115.00');
    assert.equal(si6.body.transaction.previousNoteHash, 'A68AFB9614D55457F87D62CDB24DD271B618D8AED8B5531CBBAF248525325B98');
    assert.deepEqual(si6.body.predecessor, { number: 'SI-5', counter: 2 });
  });

  test('re-logging the same sale returns the same frozen values', async () => {
    const again = await asClient('POST', '/v1/transactions', {
      systemId: '1538056000000095536', type: 'STD', number: 'SI-6', totalAmount: '115.00',
      brn: '', issuedDateTime: '2026-10-05 09:00:00',
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(again.body.transaction.counter, 3);
    assert.equal(again.body.transaction.issuedDateTime, '2026-09-29 11:57:59');
  });

  test('first document of a new type gets hash "0"', async () => {
    const cn = await sale('cn-1', 'CN-1', '50', 'CRN');
    assert.equal(cn.body.transaction.counter, 4);
    assert.equal(cn.body.transaction.previousNoteHash, '0');
  });

  test('80 simultaneous sales: unique gap-free counters, every hash links to the true predecessor', async () => {
    const before = (await asAdmin('GET', `/admin/tenants/${ORG}`)).body.tenant.last_counter;
    const jobs = [];
    for (let i = 0; i < 80; i++) {
      const type = i % 4 === 0 ? 'CRN' : 'STD';
      jobs.push(sale(`burst-${i}`, `${type === 'CRN' ? 'CN' : 'SI'}-B${i}`, `${100 + i}.5`, type));
    }
    const results = await Promise.all(jobs);
    for (const r of results) assert.equal(r.status, 201, JSON.stringify(r.body));
    const counters = results.map((r) => r.body.transaction.counter).sort((a, b) => a - b);
    assert.equal(new Set(counters).size, 80, 'counters must be unique');
    assert.equal(counters[0], before + 1);
    assert.equal(counters.at(-1), before + 80, 'counters must be gap-free');
    const hashes = results.map((r) => r.body.transaction.previousNoteHash);
    assert.equal(new Set(hashes).size, 80, 'no two sales may share a previousNoteHash');

    const verify = await asAdmin('GET', `/admin/tenants/${ORG}/verify`);
    assert.equal(verify.status, 200);
    assert.equal(verify.body.ok, true, JSON.stringify(verify.body.chains, null, 1));
    const std = verify.body.chains.find((c) => c.type === 'STD');
    assert.equal(std.checked, 1 + 1 + 60); // SI-5 (imported) + SI-6 + 60 burst sales
  });

  test('a changed sale is refreshed only while nothing is chained to it', async () => {
    const last = await sale('edit-1', 'SI-E1', '10');
    assert.equal(last.status, 201);
    const refreshed = await sale('edit-1', 'SI-E1', '12');
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.refreshed, true);
    assert.equal(refreshed.body.transaction.totalAmount, '12.00');
    assert.equal(refreshed.body.transaction.counter, last.body.transaction.counter);

    await sale('edit-2', 'SI-E2', '20');
    const locked = await sale('edit-1', 'SI-E1', '13');
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error.code, 'CHAIN_LOCKED');
    assert.equal(locked.body.error.details.successor.number, 'SI-E2');

    const moved = await sale('edit-2', 'SI-E2', '20', 'DRN');
    assert.equal(moved.status, 409);
    assert.equal(moved.body.error.code, 'TYPE_MISMATCH');

    const verify = await asAdmin('GET', `/admin/tenants/${ORG}/verify?type=STD`);
    assert.equal(verify.body.ok, true);
  });

  test('outcomes: FAILED then FISCALIZED; fiscalised is final', async () => {
    const failed = await asClient('POST', '/v1/transactions/edit-2/outcome', { status: 'FAILED', error: 'Seller TAN mismatch' });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.transaction.status, 'FAILED');
    const list = await asClient('GET', '/v1/transactions?status=FAILED');
    assert.deepEqual(list.body.transactions.map((t) => t.systemId), ['edit-2']);

    const ok = await asClient('POST', '/v1/transactions/edit-2/outcome', { status: 'FISCALIZED', irn: 'IRN-E2' });
    assert.equal(ok.body.transaction.status, 'FISCALIZED');
    assert.equal(ok.body.transaction.attempts, 2);
    const same = await asClient('POST', '/v1/transactions/edit-2/outcome', { status: 'FISCALIZED', irn: 'IRN-E2' });
    assert.equal(same.body.unchanged, true);
    const back = await asClient('POST', '/v1/transactions/edit-2/outcome', { status: 'FAILED', error: 'x' });
    assert.equal(back.status, 409);
    assert.equal(back.body.error.code, 'ALREADY_FISCALIZED');

    const relog = await sale('edit-2', 'SI-E2', '25');
    assert.equal(relog.status, 200);
    assert.equal(relog.body.transaction.status, 'FISCALIZED');
    assert.equal(relog.body.warning, 'CHANGED_AFTER_FISCALISATION');
    assert.equal(relog.body.transaction.totalAmount, '20.00');
  });

  test('validation errors are explicit', async () => {
    const badDate = await sale('v-1', 'SI-V1', '10', 'STD', { issuedDateTime: '2026-10-01T10:00:00' });
    assert.equal(badDate.status, 400);
    assert.match(badDate.body.error.message, /yyyy-MM-dd HH:mm:ss/);
    const badAmt = await sale('v-2', 'SI-V2', '10.123');
    assert.equal(badAmt.status, 400);
    const badType = await sale('v-3', 'SI-V3', '10', 'INVOICE');
    assert.equal(badType.status, 400);
    const missing = await asClient('GET', '/v1/transactions/does-not-exist');
    assert.equal(missing.status, 404);
  });

  test('organisations are isolated; import after live logging needs force', async () => {
    const other = await asAdmin('POST', '/admin/tenants', { orgId: 'other-org', name: 'Other' });
    const otherKey = other.body.apiKey;
    const peek = await call('GET', '/v1/transactions/edit-2', undefined, { 'x-api-key': otherKey });
    assert.equal(peek.status, 404);
    const first = await call('POST', '/v1/transactions',
      { systemId: 'o-1', type: 'STD', number: 'INV-1', totalAmount: '1', issuedDateTime: '2026-10-01 10:00:00' },
      { 'x-api-key': otherKey });
    assert.equal(first.body.transaction.counter, 1);
    assert.equal(first.body.transaction.previousNoteHash, '0');

    const late = await asAdmin('POST', `/admin/tenants/${ORG}/import`, { transactions: [] });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'IMPORT_AFTER_LIVE');
  });

  test('health reports the database', async () => {
    const h = await call('GET', '/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.db, 'up');
  });
});
