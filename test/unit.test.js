import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashSource, noteHash } from '../src/hash.js';
import { canonicalAmount, docType, sameAmount } from '../src/validate.js';

test('hash matches the live Zoho chain (SI-5 -> SI-6, org 941108254)', () => {
  const si5 = { issued_date_time: '2026-09-29 11:55:21', total_amount: '201.25', brn: '', transaction_number: 'SI-5' };
  assert.equal(hashSource(si5), '20260929 11:55:21201.25SI-5');
  assert.equal(noteHash(si5), 'A68AFB9614D55457F87D62CDB24DD271B618D8AED8B5531CBBAF248525325B98');
});

test('canonical amounts use two decimals without float maths', () => {
  assert.equal(canonicalAmount('115'), '115.00');
  assert.equal(canonicalAmount('115.0'), '115.00');
  assert.equal(canonicalAmount(201.25), '201.25');
  assert.equal(canonicalAmount('0003990.5'), '3990.50');
  assert.equal(canonicalAmount('12.340'), '12.34');
  assert.throws(() => canonicalAmount('12.345'), /rounded to 2 decimals/);
  assert.throws(() => canonicalAmount('-5'), /non-negative/);
  assert.throws(() => canonicalAmount('abc'), /non-negative/);
  assert.ok(sameAmount('3990.0', '3990.00'));
  assert.ok(!sameAmount('3990.01', '3990.00'));
});

test('document types accept MRA codes and Zoho labels', () => {
  assert.equal(docType('std'), 'STD');
  assert.equal(docType('Standard Invoice'), 'STD');
  assert.equal(docType('Credit Note'), 'CRN');
  assert.equal(docType('Training Invoice'), 'TRN');
  assert.throws(() => docType('INVOICE'), /type must be one of/);
});
