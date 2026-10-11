import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlatformInputError } from '../../api/platform/errors.js';
import { bahtText, invoicePreview, isValidThaiTaxId, taxQuote, thaiDate } from '../../api/platform/thai_tax.js';
import { presignFile, presignUrl, r2ConfigFromEnv } from '../../api/platform/files.js';
import { parseEmailRequest, sendEmail } from '../../api/platform/email.js';

test('bahtText reads Thai baht amounts', () => {
  assert.equal(bahtText(0), 'ศูนย์บาทถ้วน');
  assert.equal(bahtText(1), 'หนึ่งบาทถ้วน');
  assert.equal(bahtText(11), 'สิบเอ็ดบาทถ้วน');
  assert.equal(bahtText(21), 'ยี่สิบเอ็ดบาทถ้วน');
  assert.equal(bahtText(101), 'หนึ่งร้อยเอ็ดบาทถ้วน');
  assert.equal(bahtText(1234.5), 'หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์');
  assert.equal(bahtText(1_000_001), 'หนึ่งล้านเอ็ดบาทถ้วน');
  assert.equal(bahtText(21_000_000), 'ยี่สิบเอ็ดล้านบาทถ้วน');
  assert.equal(bahtText(0.25), 'ยี่สิบห้าสตางค์');
});

test('tax quote handles exclusive, inclusive, and withholding', () => {
  const exclusive = taxQuote({ amount: 10000, withholding: 'service' });
  assert.equal(exclusive.vat, 700);
  assert.equal(exclusive.total, 10700);
  assert.equal(exclusive.withholding_amount, 300);
  assert.equal(exclusive.net_payable, 10400);
  assert.equal(exclusive.net_payable_text_th, 'หนึ่งหมื่นสี่ร้อยบาทถ้วน');

  const inclusive = taxQuote({ amount: 107, vat_mode: 'inclusive' });
  assert.equal(inclusive.subtotal, 100);
  assert.equal(inclusive.vat, 7);
  assert.equal(inclusive.total, 107);

  assert.equal(taxQuote({ amount: 500, vat_mode: 'exempt' }).vat, 0);
  assert.throws(() => taxQuote({ amount: -1 }), PlatformInputError);
  assert.throws(() => taxQuote({ amount: 1, withholding: 'bogus' }), PlatformInputError);
});

test('invoice preview totals lines and validates tax IDs', () => {
  assert.ok(isValidThaiTaxId('0994000165510'));
  assert.ok(!isValidThaiTaxId('0994000165511'));
  assert.equal(thaiDate('2026-10-04'), '4 ตุลาคม 2569');

  const invoice = invoicePreview({
    seller: { name: 'Seller Co., Ltd.', tax_id: '0994000165510' },
    buyer: { name: 'Buyer' },
    lines: [
      { description: 'Website', quantity: 1, unit_price: 30000 },
      { description: 'Hosting', quantity: 12, unit_price: 500.5 },
    ],
    withholding: 'service',
    issue_date: '2026-10-04',
  });
  assert.equal(invoice.document_type, 'tax_invoice');
  assert.equal(invoice.seller.branch, 'สำนักงานใหญ่');
  assert.equal(invoice.subtotal, 36006);
  assert.equal(invoice.vat, 2520.42);
  assert.equal(invoice.total, 38526.42);
  assert.equal(invoice.withholding_amount, 1080.18);
  assert.equal(invoice.issue_date_th, '4 ตุลาคม 2569');

  assert.throws(() => invoicePreview({ seller: { name: 'A', tax_id: '123' }, buyer: { name: 'B' }, lines: [] }));
  assert.throws(
    () => invoicePreview({ seller: { name: 'A' }, buyer: { name: 'B' }, lines: [{ description: 'x', unit_price: 'free' }] }),
    PlatformInputError,
  );
});

test('presignUrl matches the published SigV4 query-string example', () => {
  // Public example values from the AWS S3 SigV4 documentation, not a real account.
  const url = presignUrl({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    expiresSeconds: 86400,
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.ok(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'), url);
});

test('presignFile issues app-scoped keys and enforces limits', () => {
  assert.equal(r2ConfigFromEnv({}), null);
  const config = r2ConfigFromEnv({
    R2_ACCOUNT_ID: 'acct',
    R2_BUCKET: 'bucket',
    R2_ACCESS_KEY_ID: 'id',
    R2_SECRET_ACCESS_KEY: 'example-only',
    R2_MAX_UPLOAD_BYTES: '1000',
  });
  assert.ok(config);
  const now = new Date('2026-10-04T00:00:00Z');
  const uuid = () => '00000000-0000-4000-8000-000000000000';
  const upload = presignFile(
    { app: 'scanpop', filename: 'ใบเสร็จ May 2026.pdf', content_type: 'application/pdf', size_bytes: 500 },
    config,
    now,
    uuid,
  );
  assert.equal(upload.method, 'PUT');
  assert.match(upload.key, /^scanpop\/2026\/10\/0{8}-0{4}-4000-8000-0{12}-May-2026\.pdf$/);
  assert.ok(upload.url.startsWith('https://acct.r2.cloudflarestorage.com/bucket/scanpop/2026/10/'));
  assert.ok(upload.url.includes('X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost'));
  assert.equal(upload.expires_at, '2026-10-04T00:15:00.000Z');

  const download = presignFile({ action: 'download', key: upload.key }, config, now);
  assert.equal(download.method, 'GET');

  assert.throws(() => presignFile({ app: 'a', filename: 'f', size_bytes: 5000 }, config), (e: any) => e.status === 413);
  assert.throws(() => presignFile({ app: 'Bad App', filename: 'f', size_bytes: 1 }, config), PlatformInputError);
  assert.throws(() => presignFile({ action: 'download', key: '../other/secret' }, config), PlatformInputError);
});

test('email validates input and stays dry-run until enabled', async () => {
  assert.throws(() => parseEmailRequest({ to: 'not-an-email', subject: 's', text: 't' }), PlatformInputError);
  assert.throws(() => parseEmailRequest({ to: 'a@example.com', subject: 'a\nBcc: x', text: 't' }), PlatformInputError);
  assert.throws(() => parseEmailRequest({ to: 'a@example.com', subject: 's' }), PlatformInputError);

  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
  }) as typeof fetch;
  const message = { to: ['A@Example.com'], subject: 'Hello', text: 'Hi', app: 'scanpop' };

  const dry = await sendEmail(message, { sendEnabled: false, apiKey: '', from: '' }, fakeFetch);
  assert.equal(dry.status, 'dry_run');
  assert.equal(called, false);

  const sent = await sendEmail(message, { sendEnabled: true, apiKey: 'example-only', from: 'no-reply@example.com' }, fakeFetch);
  assert.equal(sent.status, 'sent');
  assert.equal('provider_message_id' in sent ? sent.provider_message_id : undefined, 'msg_1');
  assert.equal(called, true);

  const failing = (async () => new Response('{}', { status: 422 })) as typeof fetch;
  await assert.rejects(
    sendEmail(message, { sendEnabled: true, apiKey: 'example-only', from: 'no-reply@example.com' }, failing),
    (e: any) => e.status === 502,
  );
});
