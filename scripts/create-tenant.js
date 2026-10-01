// Register a client organisation and print its API key (shown once):
//   npm run create-tenant -- <zoho organization_id> "<client name>"
import { closePool } from '../src/db.js';
import { createTenant } from '../src/tenants.js';

const [orgId, ...nameParts] = process.argv.slice(2);
if (!orgId) {
  console.error('Usage: npm run create-tenant -- <orgId> "<name>"');
  process.exit(1);
}
try {
  const { tenant, apiKey } = await createTenant(orgId, nameParts.join(' ') || orgId);
  console.log(`Created ${tenant.org_id} (${tenant.name})`);
  console.log(`API key (store it now, it is not shown again): ${apiKey}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
