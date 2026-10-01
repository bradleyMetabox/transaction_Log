import { createHash } from 'node:crypto';

// MRA previousNoteHash of the document that FOLLOWS `prev` in the same type chain:
//   UPPER( SHA-256( dateTime + totalAmtPaid + brn + invoiceIdentifier ) )
// dateTime is the stored "yyyy-MM-dd HH:mm:ss" with the dashes removed
// ("yyyyMMdd HH:mm:ss"). All four parts are the stored strings, used verbatim.
// This is byte-for-byte the Deluge logger's formula (verified on SI-5 -> SI-6).
export function hashSource(prev) {
  return (
    String(prev.issued_date_time).replaceAll('-', '') +
    String(prev.total_amount) +
    String(prev.brn ?? '') +
    String(prev.transaction_number)
  );
}

export function noteHash(prev) {
  return createHash('sha256').update(hashSource(prev), 'utf8').digest('hex').toUpperCase();
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}
