import pg from 'pg';

const { Pool } = pg;

let pool;

// One pool per function instance. On Vercel, use Neon's POOLED connection string
// (host contains "-pooler"), so many short-lived instances share few real connections.
export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

// Runs fn(client) inside BEGIN/COMMIT; rolls back on any error.
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // connection already broken - the original error is the one that matters
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
