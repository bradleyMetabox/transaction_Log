-- MRA chain service schema. Safe to run more than once.

-- One row per client organisation (Zoho organization_id).
-- last_counter is the global invoiceCounter: it is shared by every document type
-- and locked FOR UPDATE on every new transaction, which puts a client's sales in
-- a single order. That lock is what makes the per-type hash chain race-free.
create table if not exists tenants (
  org_id        text primary key,
  name          text not null,
  api_key_hash  text not null unique,
  last_counter  bigint not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The transaction log. Each document gets its counter and previousNoteHash once,
-- and they never change afterwards.
-- The four hash inputs (issued_date_time, total_amount, brn, transaction_number)
-- are stored as TEXT and hashed verbatim - never reformatted.
create table if not exists transactions (
  id                 bigserial primary key,
  org_id             text not null references tenants(org_id),
  system_id          text not null,
  doc_type           text not null check (doc_type in ('STD','CRN','DRN','PRF','TRN')),
  counter            bigint not null,
  transaction_number text not null,
  total_amount       text not null,
  brn                text not null default '',
  currency           text not null default 'MUR',
  issued_date_time   text not null,
  previous_note_hash text not null,
  status             text not null default 'NOT_YET_FISCALIZED'
                     check (status in ('NOT_YET_FISCALIZED','FISCALIZED','FAILED')),
  irn                text,
  last_error         text,
  attempts           integer not null default 0,
  source             text not null default 'api' check (source in ('api','import')),
  fiscalized_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint transactions_org_system_uq  unique (org_id, system_id),
  constraint transactions_org_counter_uq unique (org_id, counter)
);

-- Finds the previous document of the same type in one index lookup.
create index if not exists transactions_chain_idx
  on transactions (org_id, doc_type, counter desc);

-- Retry lists (failed / not yet fiscalised, oldest first).
create index if not exists transactions_status_idx
  on transactions (org_id, status, counter);
