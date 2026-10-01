import { badRequest } from './errors.js';

export const DOC_TYPES = ['STD', 'CRN', 'DRN', 'PRF', 'TRN'];

// Zoho transaction-log labels are accepted too, so callers can send either.
const TYPE_LABELS = {
  'standard invoice': 'STD',
  standard: 'STD',
  'credit note': 'CRN',
  'debit note': 'DRN',
  'proforma invoice': 'PRF',
  proforma: 'PRF',
  'training invoice': 'TRN',
  training: 'TRN',
};

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const HASH_RE = /^(0|[0-9A-F]{64})$/;

export function docType(value) {
  const raw = String(value ?? '').trim();
  const upper = raw.toUpperCase();
  if (DOC_TYPES.includes(upper)) return upper;
  const mapped = TYPE_LABELS[raw.toLowerCase()];
  if (mapped) return mapped;
  throw badRequest(`type must be one of ${DOC_TYPES.join(', ')} (got '${raw}')`);
}

function requiredString(body, field, max) {
  const value = body[field];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw badRequest(`${field} is required`);
  }
  const s = String(value).trim();
  if (s.length > max) throw badRequest(`${field} is longer than ${max} characters`);
  return s;
}

function optionalString(body, field, max, fallback = '') {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  if (s.length > max) throw badRequest(`${field} is longer than ${max} characters`);
  return s;
}

function dateTime(value, field) {
  const s = String(value ?? '').trim();
  if (!DATE_TIME_RE.test(s)) {
    throw badRequest(`${field} must be "yyyy-MM-dd HH:mm:ss" (got '${s}')`);
  }
  return s;
}

// Canonical amount for NEW transactions: plain digits with exactly two decimals
// ("115" -> "115.00", "201.5" -> "201.50"). Done with string arithmetic, never floats.
// The caller must send the returned string as totalAmtPaid, unchanged.
export function canonicalAmount(value, field = 'totalAmount') {
  const s = String(value ?? '').trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw badRequest(`${field} must be a non-negative number (got '${s}')`);
  const intPart = BigInt(m[1]).toString();
  let frac = m[2] ?? '';
  if (frac.length > 2) {
    if (/^0*$/.test(frac.slice(2))) {
      frac = frac.slice(0, 2);
    } else {
      throw badRequest(`${field} must already be rounded to 2 decimals (got '${s}')`);
    }
  }
  return `${intPart}.${frac.padEnd(2, '0')}`;
}

// Numeric equality of two amount strings, without floats ("3990.0" == "3990.00").
export function sameAmount(a, b) {
  try {
    return canonicalAmount(a) === canonicalAmount(b);
  } catch {
    return String(a) === String(b);
  }
}

// POST /v1/transactions
export function logInput(body) {
  if (!body || typeof body !== 'object') throw badRequest('JSON body required');
  return {
    systemId: requiredString(body, 'systemId', 64),
    type: docType(body.type),
    number: requiredString(body, 'number', 100),
    totalAmount: canonicalAmount(body.totalAmount),
    brn: optionalString(body, 'brn', 50),
    currency: optionalString(body, 'currency', 3, 'MUR').toUpperCase() || 'MUR',
    issuedDateTime: dateTime(body.issuedDateTime, 'issuedDateTime'),
  };
}

// POST /v1/transactions/:systemId/outcome
export function outcomeInput(body) {
  if (!body || typeof body !== 'object') throw badRequest('JSON body required');
  const status = String(body.status ?? '').trim().toUpperCase();
  if (status !== 'FISCALIZED' && status !== 'FAILED') {
    throw badRequest("status must be 'FISCALIZED' or 'FAILED'");
  }
  const irn = optionalString(body, 'irn', 200);
  if (status === 'FISCALIZED' && irn === '') throw badRequest('irn is required when status is FISCALIZED');
  const error = String(body.error ?? '').trim().slice(0, 2000);
  return { status, irn, error };
}

// One row of POST /admin/tenants/:orgId/import. Hash inputs are kept VERBATIM:
// they must equal what MRA received for that document, so they are never reformatted.
export function importRow(row, index) {
  if (!row || typeof row !== 'object') throw badRequest(`transactions[${index}] must be an object`);
  const at = (msg) => badRequest(`transactions[${index}]: ${msg}`);
  const counter = Number(row.counter);
  if (!Number.isSafeInteger(counter) || counter <= 0) throw at('counter must be a positive integer');
  const total = String(row.totalAmount ?? '');
  if (!/^\d+(\.\d+)?$/.test(total)) throw at(`totalAmount '${total}' is not a stored amount string`);
  const issued = String(row.issuedDateTime ?? '');
  if (!DATE_TIME_RE.test(issued)) throw at(`issuedDateTime '${issued}' is not "yyyy-MM-dd HH:mm:ss"`);
  const hash = String(row.previousNoteHash ?? '').trim().toUpperCase();
  if (hash !== '' && !HASH_RE.test(hash)) throw at('previousNoteHash must be "0" or 64 hex characters');
  const status = String(row.status ?? 'FISCALIZED').trim().toUpperCase();
  if (!['NOT_YET_FISCALIZED', 'FISCALIZED', 'FAILED'].includes(status)) throw at(`unknown status '${status}'`);
  let type;
  try {
    type = docType(row.type);
  } catch (e) {
    throw at(e.message);
  }
  const systemId = String(row.systemId ?? '').trim();
  const number = String(row.number ?? '');
  if (!systemId) throw at('systemId is required');
  if (!number) throw at('number is required');
  return {
    systemId,
    type,
    counter,
    number,
    totalAmount: total,
    brn: String(row.brn ?? ''),
    currency: String(row.currency ?? 'MUR').trim().toUpperCase() || 'MUR',
    issuedDateTime: issued,
    previousNoteHash: hash,
    status,
    irn: String(row.irn ?? '').trim() || null,
  };
}
