// Creates/updates the tables: npm run migrate  (uses DATABASE_URL from .env)
// For migrations on Neon, the DIRECT (non-pooled) connection string is the safer choice.
import { readFile } from 'node:fs/promises';
import { closePool, query } from '../src/db.js';

const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
await query(sql);
console.log('Schema applied.');
await closePool();
