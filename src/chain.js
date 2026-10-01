import { query, withTransaction } from './db.js';
import { HttpError } from './errors.js';
import { noteHash } from './hash.js';
import { importRow, sameAmount, DOC_TYPES } from './validate.js';

// Shape returned to callers (camelCase, counter as a number).
export function present(row) {
  return {
    systemId: row.system_id,
    type: row.doc_type,
    counter: Number(row.counter),
    previousNoteHash: row.previous_note_hash,
    issuedDateTime: row.issued_date_time,
    number: row.transaction_number,
    totalAmount: row.total_amount,
    brn: row.brn,
    currency: row.currency,
    status: row.status,
    irn: row.irn,
    lastError: row.last_error,
    attempts: row.attempts,
    source: row.source,
    fiscalizedAt: row.fiscalized_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Locks the tenant row. Every write that can affect a chain takes this lock first,
// so a client's transactions are handled strictly one at a time.
async function lockTenant(client, orgId) {
  await client.query("set local lock_timeout = '8s'");
  const res = await client.query(
    'select org_id, last_counter from tenants where org_id = $1 and active for update',
    [orgId],
  );
  if (res.rowCount === 0) throw new HttpError(403, 'TENANT_INACTIVE', `Organisation ${orgId} is not active`);
  return res.rows[0];
}

async function latestOfType(client, orgId, type) {
  const res = await client.query(
    `select * from transactions
      where org_id = $1 and doc_type = $2
      order by counter desc
      limit 1`,
    [orgId, type],
  );
  return res.rows[0] ?? null;
}

// Log a transaction (or return the one already logged for this systemId).
//  - new: counter = last_counter + 1, previousNoteHash from the latest SAME-TYPE row ("0" if first).
//  - already logged + unchanged: same counter/hash/date returned (safe to retry).
//  - already logged + changed number/total/BRN: refreshed only while not fiscalised AND no later
//    same-type document has been chained to it; otherwise 409 CHAIN_LOCKED.
export async function logTransaction(orgId, input) {
  return withTransaction(async (client) => {
    const tenant = await lockTenant(client, orgId);

    const existing = await client.query(
      'select * from transactions where org_id = $1 and system_id = $2',
      [orgId, input.systemId],
    );
    if (existing.rowCount > 0) {
      return handleExisting(client, orgId, existing.rows[0], input);
    }

    const prev = await latestOfType(client, orgId, input.type);
    const previousNoteHash = prev ? noteHash(prev) : '0';
    const counter = BigInt(tenant.last_counter) + 1n;

    const inserted = await client.query(
      `insert into transactions
         (org_id, system_id, doc_type, counter, transaction_number, total_amount, brn, currency,
          issued_date_time, previous_note_hash, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'api')
       returning *`,
      [
        orgId,
        input.systemId,
        input.type,
        counter.toString(),
        input.number,
        input.totalAmount,
        input.brn,
        input.currency,
        input.issuedDateTime,
        previousNoteHash,
      ],
    );
    await client.query('update tenants set last_counter = $2, updated_at = now() where org_id = $1', [
      orgId,
      counter.toString(),
    ]);

    return {
      created: true,
      refreshed: false,
      transaction: present(inserted.rows[0]),
      predecessor: prev ? { number: prev.transaction_number, counter: Number(prev.counter) } : null,
    };
  });
}

async function handleExisting(client, orgId, row, input) {
  if (row.doc_type !== input.type) {
    throw new HttpError(
      409,
      'TYPE_MISMATCH',
      `${row.transaction_number} is already logged as ${row.doc_type}; it cannot move to the ${input.type} chain`,
      { logged: present(row) },
    );
  }

  const changes = [];
  if (row.transaction_number !== input.number) changes.push({ field: 'number', from: row.transaction_number, to: input.number });
  if (!sameAmount(row.total_amount, input.totalAmount)) changes.push({ field: 'totalAmount', from: row.total_amount, to: input.totalAmount });
  if (row.brn.trim() !== input.brn) changes.push({ field: 'brn', from: row.brn, to: input.brn });

  if (changes.length === 0) {
    return { created: false, refreshed: false, transaction: present(row), predecessor: null };
  }

  if (row.status === 'FISCALIZED') {
    // Already accepted by MRA: the logged values stand. The caller sees status FISCALIZED and stops.
    return {
      created: false,
      refreshed: false,
      warning: 'CHANGED_AFTER_FISCALISATION',
      changes,
      transaction: present(row),
      predecessor: null,
    };
  }

  const successor = await client.query(
    `select transaction_number, counter from transactions
      where org_id = $1 and doc_type = $2 and counter > $3
      order by counter
      limit 1`,
    [orgId, row.doc_type, row.counter],
  );
  if (successor.rowCount > 0) {
    const next = successor.rows[0];
    throw new HttpError(
      409,
      'CHAIN_LOCKED',
      `${row.transaction_number} changed after logging (${changes.map((c) => `${c.field} '${c.from}' -> '${c.to}'`).join('; ')}), ` +
        `and ${next.transaction_number} (counter ${next.counter}) is already chained to the logged values. ` +
        'Restore the original values, or rebuild the chain.',
      { changes, successor: { number: next.transaction_number, counter: Number(next.counter) }, logged: present(row) },
    );
  }

  const updated = await client.query(
    `update transactions
        set transaction_number = $3, total_amount = $4, brn = $5, updated_at = now()
      where org_id = $1 and system_id = $2
      returning *`,
    [orgId, row.system_id, input.number, input.totalAmount, input.brn],
  );
  return { created: false, refreshed: true, changes, transaction: present(updated.rows[0]), predecessor: null };
}

// Record what MRA answered. FISCALIZED is final.
export async function recordOutcome(orgId, systemId, outcome) {
  return withTransaction(async (client) => {
    const res = await client.query(
      'select * from transactions where org_id = $1 and system_id = $2 for update',
      [orgId, systemId],
    );
    if (res.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', `No transaction logged for systemId ${systemId}`);
    const row = res.rows[0];

    if (row.status === 'FISCALIZED') {
      if (outcome.status === 'FISCALIZED' && outcome.irn === row.irn) {
        return { transaction: present(row), unchanged: true };
      }
      throw new HttpError(409, 'ALREADY_FISCALIZED', `${row.transaction_number} is already fiscalised (IRN ${row.irn})`, {
        logged: present(row),
      });
    }

    const updated =
      outcome.status === 'FISCALIZED'
        ? await client.query(
            `update transactions
                set status = 'FISCALIZED', irn = $3, last_error = null, attempts = attempts + 1,
                    fiscalized_at = now(), updated_at = now()
              where org_id = $1 and system_id = $2
              returning *`,
            [orgId, systemId, outcome.irn],
          )
        : await client.query(
            `update transactions
                set status = 'FAILED', last_error = $3, attempts = attempts + 1, updated_at = now()
              where org_id = $1 and system_id = $2
              returning *`,
            [orgId, systemId, outcome.error || 'Failed (no detail given)'],
          );
    return { transaction: present(updated.rows[0]), unchanged: false };
  });
}

export async function getTransaction(orgId, systemId) {
  const res = await query('select * from transactions where org_id = $1 and system_id = $2', [orgId, systemId]);
  if (res.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', `No transaction logged for systemId ${systemId}`);
  return present(res.rows[0]);
}

// Oldest first, so a retry job sends documents back in counter order.
export async function listTransactions(orgId, { status, type, limit = 50, afterCounter = 0 }) {
  const params = [orgId, afterCounter];
  let where = 'org_id = $1 and counter > $2';
  if (status) {
    params.push(status);
    where += ` and status = $${params.length}`;
  }
  if (type) {
    params.push(type);
    where += ` and doc_type = $${params.length}`;
  }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
  const res = await query(`select * from transactions where ${where} order by counter limit $${params.length}`, params);
  return res.rows.map(present);
}

// Seed a client's existing chain (e.g. from Zoho's cm_transaction_log) so the service continues it.
// At minimum send the LAST row of each type plus lastCounter = the highest counter used so far.
export async function importTransactions(orgId, body, { force = false } = {}) {
  const rows = Array.isArray(body?.transactions) ? body.transactions : null;
  if (!rows) throw new HttpError(400, 'VALIDATION_ERROR', 'transactions must be an array');
  const parsed = rows.map((r, i) => importRow(r, i));

  const seenSystem = new Set();
  const seenCounter = new Set();
  for (const r of parsed) {
    if (seenSystem.has(r.systemId)) throw new HttpError(400, 'VALIDATION_ERROR', `systemId ${r.systemId} appears twice`);
    if (seenCounter.has(r.counter)) throw new HttpError(400, 'VALIDATION_ERROR', `counter ${r.counter} appears twice`);
    seenSystem.add(r.systemId);
    seenCounter.add(r.counter);
  }
  const lastCounterIn = body.lastCounter === undefined ? 0 : Number(body.lastCounter);
  if (!Number.isSafeInteger(lastCounterIn) || lastCounterIn < 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'lastCounter must be a non-negative integer');
  }

  return withTransaction(async (client) => {
    const tenant = await lockTenant(client, orgId);
    const live = await client.query(
      "select count(*)::int as n, min(counter) as min_counter from transactions where org_id = $1 and source = 'api'",
      [orgId],
    );
    if (live.rows[0].n > 0 && !force) {
      throw new HttpError(
        409,
        'IMPORT_AFTER_LIVE',
        `This organisation already has ${live.rows[0].n} transaction(s) logged by the service. ` +
          'Importing now could reorder its chains; pass ?force=true only if every imported counter is lower than ' +
          `${live.rows[0].min_counter}.`,
      );
    }

    let imported = 0;
    for (const r of parsed) {
      const res = await client.query(
        `insert into transactions
           (org_id, system_id, doc_type, counter, transaction_number, total_amount, brn, currency,
            issued_date_time, previous_note_hash, status, irn, source,
            fiscalized_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'import',
                 case when $11 = 'FISCALIZED' then now() else null end)
         on conflict (org_id, system_id) do nothing`,
        [
          orgId,
          r.systemId,
          r.type,
          String(r.counter),
          r.number,
          r.totalAmount,
          r.brn,
          r.currency,
          r.issuedDateTime,
          r.previousNoteHash,
          r.status,
          r.irn,
        ],
      );
      imported += res.rowCount;
    }

    const maxRow = await client.query('select coalesce(max(counter), 0) as m from transactions where org_id = $1', [orgId]);
    const newLast = [BigInt(tenant.last_counter), BigInt(lastCounterIn), BigInt(maxRow.rows[0].m)].reduce((a, b) =>
      a > b ? a : b,
    );
    await client.query('update tenants set last_counter = $2, updated_at = now() where org_id = $1', [
      orgId,
      newLast.toString(),
    ]);

    const heads = {};
    for (const type of DOC_TYPES) {
      const head = await latestOfType(client, orgId, type);
      if (head) {
        heads[type] = {
          number: head.transaction_number,
          counter: Number(head.counter),
          nextPreviousNoteHash: noteHash(head),
        };
      }
    }
    return { imported, skipped: parsed.length - imported, lastCounter: Number(newLast), heads };
  });
}

// Re-computes every link in the last `limit` documents of each type and reports mismatches.
export async function verifyChains(orgId, { type, limit = 1000 } = {}) {
  const types = type ? [type] : DOC_TYPES;
  const cap = Math.min(Math.max(Number(limit) || 1000, 2), 20000);
  const report = [];
  for (const t of types) {
    const res = await query(
      `select * from (
         select * from transactions where org_id = $1 and doc_type = $2 order by counter desc limit $3
       ) w order by counter`,
      [orgId, t, cap],
    );
    if (res.rowCount === 0) continue;
    const rows = res.rows;
    const firstOfType = await query(
      'select min(counter) as c from transactions where org_id = $1 and doc_type = $2',
      [orgId, t],
    );
    const mismatches = [];
    if (String(rows[0].counter) === String(firstOfType.rows[0].c) && rows[0].previous_note_hash !== '0' && rows[0].source === 'api') {
      mismatches.push({ counter: Number(rows[0].counter), number: rows[0].transaction_number, expected: '0', stored: rows[0].previous_note_hash });
    }
    for (let i = 1; i < rows.length; i++) {
      const expected = noteHash(rows[i - 1]);
      if (rows[i].previous_note_hash !== expected) {
        mismatches.push({
          counter: Number(rows[i].counter),
          number: rows[i].transaction_number,
          previous: rows[i - 1].transaction_number,
          expected,
          stored: rows[i].previous_note_hash,
        });
      }
    }
    report.push({
      type: t,
      checked: rows.length,
      from: { number: rows[0].transaction_number, counter: Number(rows[0].counter) },
      to: { number: rows.at(-1).transaction_number, counter: Number(rows.at(-1).counter) },
      ok: mismatches.length === 0,
      mismatches,
    });
  }
  return { ok: report.every((r) => r.ok), chains: report };
}
