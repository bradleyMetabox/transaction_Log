import { timingSafeEqual } from 'node:crypto';
import { query } from './db.js';
import { HttpError } from './errors.js';
import { sha256Hex } from './hash.js';

// Client calls: header x-api-key = the key issued for that organisation.
// Only its SHA-256 is stored, so a database leak does not expose working keys.
export async function requireTenant(req, _res, next) {
  try {
    const key = req.get('x-api-key');
    if (!key) throw new HttpError(401, 'UNAUTHORIZED', 'x-api-key header is required');
    const res = await query('select org_id from tenants where api_key_hash = $1 and active', [sha256Hex(key)]);
    if (res.rowCount === 0) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or inactive API key');
    req.orgId = res.rows[0].org_id;
    next();
  } catch (err) {
    next(err);
  }
}

// Admin calls: header x-admin-key = ADMIN_API_KEY.
export function requireAdmin(req, _res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return next(new HttpError(503, 'ADMIN_DISABLED', 'ADMIN_API_KEY is not configured'));
  const given = req.get('x-admin-key') ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return next(new HttpError(401, 'UNAUTHORIZED', 'Invalid admin key'));
  }
  next();
}
