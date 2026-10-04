/**
 * Thai VAT / withholding-tax quotes and invoice previews (catalog ids: tax, invoice).
 *
 * Stateless calculation with the standard Revenue Department rates only. It does
 * not issue tax invoices, allocate document numbers, or file returns; those stay
 * with the accounting partner. All money is computed in integer satang.
 */
import { PlatformInputError, optionalString, requireObject, requireString } from './errors.js';

export const THAI_VAT_RATE = 0.07;

/** Standard withholding rates for payments made by a Thai juristic person. */
export const WITHHOLDING_RATES = {
  none: 0,
  transport: 0.01,
  advertising: 0.02,
  service: 0.03,
  professional_fee: 0.03,
  rent: 0.05,
  prize: 0.05,
} as const;

export type WithholdingType = keyof typeof WITHHOLDING_RATES;
export type VatMode = 'exclusive' | 'inclusive' | 'exempt';

const MAX_LINES = 200;
const MAX_SATANG = 100_000_000_000 * 100; // 100 billion baht

function toSatang(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PlatformInputError(`${field} must be a non-negative number`);
  }
  const satang = Math.round(value * 100);
  if (satang > MAX_SATANG) throw new PlatformInputError(`${field} is too large`);
  return satang;
}

const fromSatang = (satang: number) => satang / 100;

function vatMode(value: unknown): VatMode {
  if (value === undefined) return 'exclusive';
  if (value === 'exclusive' || value === 'inclusive' || value === 'exempt') return value;
  throw new PlatformInputError('vat_mode must be exclusive, inclusive, or exempt');
}

function withholdingType(value: unknown): WithholdingType {
  if (value === undefined) return 'none';
  if (typeof value === 'string' && value in WITHHOLDING_RATES) return value as WithholdingType;
  throw new PlatformInputError(`withholding must be one of ${Object.keys(WITHHOLDING_RATES).join(', ')}`);
}

export interface TaxQuote {
  vat_mode: VatMode;
  vat_rate: number;
  withholding: WithholdingType;
  withholding_rate: number;
  subtotal: number;
  vat: number;
  total: number;
  withholding_amount: number;
  net_payable: number;
  total_text_th: string;
  net_payable_text_th: string;
}

/** Split an amount (satang) into pre-VAT base, VAT, and gross for the given mode. */
function splitVat(amount: number, mode: VatMode): { base: number; vat: number } {
  if (mode === 'exempt') return { base: amount, vat: 0 };
  if (mode === 'inclusive') {
    const base = Math.round(amount / (1 + THAI_VAT_RATE));
    return { base, vat: amount - base };
  }
  return { base: amount, vat: Math.round(amount * THAI_VAT_RATE) };
}

function quoteFromSatang(amount: number, mode: VatMode, wht: WithholdingType): TaxQuote {
  const { base, vat } = splitVat(amount, mode);
  const total = base + vat;
  // Withholding applies to the pre-VAT amount.
  const withholding = Math.round(base * WITHHOLDING_RATES[wht]);
  const net = total - withholding;
  return {
    vat_mode: mode,
    vat_rate: mode === 'exempt' ? 0 : THAI_VAT_RATE,
    withholding: wht,
    withholding_rate: WITHHOLDING_RATES[wht],
    subtotal: fromSatang(base),
    vat: fromSatang(vat),
    total: fromSatang(total),
    withholding_amount: fromSatang(withholding),
    net_payable: fromSatang(net),
    total_text_th: bahtText(fromSatang(total)),
    net_payable_text_th: bahtText(fromSatang(net)),
  };
}

/** POST /api/platform/commerce/tax/quote body: { amount, vat_mode?, withholding? } */
export function taxQuote(input: unknown): TaxQuote {
  const body = requireObject(input);
  return quoteFromSatang(toSatang(body.amount, 'amount'), vatMode(body.vat_mode), withholdingType(body.withholding));
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

/**
 * POST /api/platform/billing/invoices/preview body:
 * { seller, buyer, lines: [{ description, quantity, unit_price }], vat_mode?, withholding?, issue_date? }
 */
export function invoicePreview(input: unknown) {
  const body = requireObject(input);
  const party = (field: 'seller' | 'buyer') => {
    const value = requireObject(body[field], field);
    const taxId = optionalString(value, 'tax_id', 13);
    if (taxId !== undefined && !isValidThaiTaxId(taxId)) {
      throw new PlatformInputError(`${field}.tax_id must be a valid 13-digit Thai tax ID`);
    }
    return {
      name: requireString(value, 'name', 200),
      tax_id: taxId,
      branch: optionalString(value, 'branch', 50) ?? (taxId ? 'สำนักงานใหญ่' : undefined),
      address: optionalString(value, 'address', 500),
    };
  };
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    throw new PlatformInputError('lines must be a non-empty array');
  }
  if (body.lines.length > MAX_LINES) throw new PlatformInputError(`lines must have at most ${MAX_LINES} items`);

  let sum = 0;
  const lines: InvoiceLine[] = body.lines.map((raw, index) => {
    const line = requireObject(raw, `lines[${index}]`);
    const quantity = line.quantity === undefined ? 1 : line.quantity;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      throw new PlatformInputError(`lines[${index}].quantity must be a positive number`);
    }
    const unit = toSatang(line.unit_price, `lines[${index}].unit_price`);
    const amount = Math.round(unit * quantity);
    sum += amount;
    if (sum > MAX_SATANG) throw new PlatformInputError('invoice total is too large');
    return {
      description: requireString(line, 'description', 500),
      quantity,
      unit_price: fromSatang(unit),
      amount: fromSatang(amount),
    };
  });

  const issueDate = optionalString(body, 'issue_date', 10) ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || Number.isNaN(Date.parse(issueDate))) {
    throw new PlatformInputError('issue_date must be YYYY-MM-DD');
  }
  const seller = party('seller');
  const mode = vatMode(body.vat_mode);
  return {
    document_type: mode !== 'exempt' && seller.tax_id ? 'tax_invoice' : 'invoice',
    preview: true,
    issue_date: issueDate,
    issue_date_th: thaiDate(issueDate),
    currency: 'THB',
    seller,
    buyer: party('buyer'),
    lines,
    ...quoteFromSatang(sum, mode, withholdingType(body.withholding)),
  };
}

/** Thai citizen / juristic tax ID checksum (mod 11 over the first 12 digits). */
export function isValidThaiTaxId(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(value[12]);
}

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

/** 2026-10-04 -> 4 ตุลาคม 2569 (Buddhist era). */
export function thaiDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return `${day} ${THAI_MONTHS[month - 1]} ${year + 543}`;
}

const DIGITS = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

/** Read a non-negative integer below one million in Thai. */
function readGroup(value: number, hasHigher: boolean): string {
  const digits = String(value).split('').reverse().map(Number);
  let text = '';
  for (let place = digits.length - 1; place >= 0; place--) {
    const digit = digits[place];
    if (digit === 0) continue;
    if (place === 1 && digit === 1) text += 'สิบ';
    else if (place === 1 && digit === 2) text += 'ยี่สิบ';
    else if (place === 0 && digit === 1 && (digits.length > 1 || hasHigher)) text += 'เอ็ด';
    else text += DIGITS[digit] + PLACES[place];
  }
  return text;
}

function readInteger(value: number): string {
  if (value === 0) return 'ศูนย์';
  let text = '';
  const groups: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 1_000_000)) groups.push(rest % 1_000_000);
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i]) text += readGroup(groups[i], i < groups.length - 1 && text !== '');
    if (i > 0) text += 'ล้าน';
  }
  return text;
}

/** 1234.5 -> หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์ */
export function bahtText(amount: number): string {
  const satangTotal = Math.round(amount * 100);
  const baht = Math.floor(satangTotal / 100);
  const satang = satangTotal % 100;
  if (baht === 0 && satang === 0) return 'ศูนย์บาทถ้วน';
  const bahtPart = baht > 0 ? `${readInteger(baht)}บาท` : '';
  return satang === 0 ? `${bahtPart}ถ้วน` : `${bahtPart}${readGroup(satang, false)}สตางค์`;
}
