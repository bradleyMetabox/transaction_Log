import { randomBytes } from 'node:crypto';
import { query } from './db.js';
import { HttpError } from './errors.js';
import { sha256Hex } from './hash.js';

function newKey() {
  return `mcs_${randomBytes(24).toString('base64url')}`;
}

// Returns the plain API key ONCE. Only its hash is stored.
export async function createTenant(orgId, name) {
  const id = String(orgId ?? '').trim();
  if (!id) throw new HttpError(400, 'VALIDATION_ERROR', 'orgId is required');
  const key = newKey();
  const res = await query(
    `insert into tenants (org_id, name, api_key_hash) values ($1, $2, $3)
     on conflict (org_id) do nothing
     returning org_id, name, last_counter, active, created_at`,
    [id, String(name ?? id).trim() || id, sha256Hex(key)],
  );
  if (res.rowCount === 0) throw new HttpError(409, 'TENANT_EXISTS', `Organisation ${id} already exists - rotate its key instead`);
  return { tenant: res.rows[0], apiKey: key };
}

export async function rotateKey(orgId) {
  const key = newKey();
  const res = await query(
    'update tenants set api_key_hash = $2, updated_at = now() where org_id = $1 returning org_id',
    [orgId, sha256Hex(key)],
  );
  if (res.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', `Organisation ${orgId} not found`);
  return { orgId, apiKey: key };
}

export async function setActive(orgId, active) {
  const res = await query(
    'update tenants set active = $2, updated_at = now() where org_id = $1 returning org_id, active',
    [orgId, active],
  );
  if (res.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', `Organisation ${orgId} not found`);
  return res.rows[0];
}

export async function getTenant(orgId) {
  const res = await query(
    `select t.org_id, t.name, t.last_counter, t.active, t.created_at,
            (select count(*)::int from transactions x where x.org_id = t.org_id) as transactions
       from tenants t where t.org_id = $1`,
    [orgId],
  );
  if (res.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', `Organisation ${orgId} not found`);
  const r = res.rows[0];
  return { ...r, last_counter: Number(r.last_counter) };
}
