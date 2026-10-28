import { describe, expect, test } from 'bun:test';
import {
  decodeCsvBytes, detectDecimal, detectDelimiter, guessMapping, hash53, headerRole, latestBalance, mappingProblems,
  parseAmount, parseCsv, parseDate, planCsv, rowsToTransactions, spanOf, transactionIds,
} from './bankCsv';

describe('decoding', () => {
  test('UTF-8 stays UTF-8, a BOM is dropped', () => {
    const bytes = new TextEncoder().encode('﻿Beløb;Tekst');
    expect(decodeCsvBytes(bytes)).toBe('Beløb;Tekst');
  });
  test('Windows-1252 bytes keep their Danish letters', () => {
    // "Føtex;Æble;Århus" in Windows-1252.
    const bytes = new Uint8Array([0x46, 0xf8, 0x74, 0x65, 0x78, 0x3b, 0xc6, 0x62, 0x6c, 0x65, 0x3b, 0xc5, 0x72, 0x68, 0x75, 0x73]);
    expect(decodeCsvBytes(bytes)).toBe('Føtex;Æble;Århus');
  });
});

describe('delimiter and cells', () => {
  test('semicolon files with decimal commas', () => {
    expect(detectDelimiter('"10.01.2026";"Netto";"-123,45";"10.000,00"\n"11.01.2026";"Løn";"25.000,00";"35.000,00"')).toBe(';');
  });
  test('comma files with ISO dates', () => {
    expect(detectDelimiter('Date,Text,Amount\n2026-01-10,Netto,-123.45\n2026-01-11,Salary,25000.00')).toBe(',');
  });
  test('tabs, and an Excel sep= hint', () => {
    expect(detectDelimiter('Dato\tTekst\tBeløb\n01-02-2026\tIrma\t-45,00')).toBe('\t');
    expect(detectDelimiter('sep=,\nDato,Tekst\n')).toBe(',');
  });
  test('quoted cells, doubled quotes and line breaks inside quotes', () => {
    const rows = parseCsv('"a;b";"say ""hi""";"two\nlines"\r\nx;y;z\n', ';');
    expect(rows).toEqual([['a;b', 'say "hi"', 'two\nlines'], ['x', 'y', 'z']]);
  });
  test('blank lines and the sep= line are dropped', () => {
    expect(parseCsv('sep=;\n\na;b\n;\n', ';')).toEqual([['a', 'b']]);
  });
});

describe('dates', () => {
  test('every form a Danish export writes', () => {
    expect(parseDate('24-10-2026')).toBe('2026-10-24');
    expect(parseDate('24.10.2026')).toBe('2026-10-24');
    expect(parseDate('24/10/2026')).toBe('2026-10-24');
    expect(parseDate('2026-10-24')).toBe('2026-10-24');
    expect(parseDate('2026/10/24')).toBe('2026-10-24');
    expect(parseDate('2026-10-24T08:12:00')).toBe('2026-10-24');
    expect(parseDate('4.1.26')).toBe('2026-01-04');
  });
  test('impossible days and words are not dates', () => {
    expect(parseDate('31.02.2026')).toBeNull();
    expect(parseDate('Netto')).toBeNull();
    expect(parseDate('13-13-2026')).toBeNull();
    expect(parseDate('')).toBeNull();
  });
});

describe('amounts', () => {
  test('decimal commas with thousands dots', () => {
    expect(parseAmount('-1.234,56', ',')).toBe(-1234.56);
    expect(parseAmount('25.000,00', ',')).toBe(25000);
    expect(parseAmount('45,5', ',')).toBe(45.5);
  });
  test('decimal dots with thousands commas', () => {
    expect(parseAmount('1,234.56', '.')).toBe(1234.56);
    expect(parseAmount('-12.30', '.')).toBe(-12.3);
  });
  test('a lone mark is read by its digits, whatever the file says', () => {
    expect(parseAmount('1.234', ',')).toBe(1234);
    expect(parseAmount('12.50', ',')).toBe(12.5);
    expect(parseAmount('1,234', '.')).toBe(1234);
  });
  test('signs, currency and spacing', () => {
    expect(parseAmount('−45,00', ',')).toBe(-45);
    expect(parseAmount('45,00-', ',')).toBe(-45);
    expect(parseAmount('(45.00)', '.')).toBe(-45);
    expect(parseAmount('kr. -45,00', ',')).toBe(-45);
    expect(parseAmount('1 234,56 DKK', ',')).toBe(1234.56);
    expect(parseAmount('+12', ',')).toBe(12);
  });
  test('words are not money', () => {
    expect(parseAmount('Udført', ',')).toBeNull();
    expect(parseAmount('', ',')).toBeNull();
    expect(parseAmount('1.2.3,4,5', ',')).toBeNull();
  });
  test('the file decides the decimal mark', () => {
    expect(detectDecimal(['-123,45', '10.000,00', '25,00'])).toBe(',');
    expect(detectDecimal(['-123.45', '1,000.00', '25.00'])).toBe('.');
    expect(detectDecimal(['100', '200'])).toBe(',');
  });
});

describe('headers and mapping', () => {
  test('known Danish and English header words', () => {
    expect(headerRole('Bogføringsdato')).toBe('date');
    expect(headerRole('"Beløb (DKK)"')).toBe('amount');
    expect(headerRole('Beløb i DKK')).toBe('amount');
    expect(headerRole('Saldo')).toBe('balance');
    expect(headerRole('Description')).toBe('text');
    expect(headerRole('Valuta')).toBe('currency');
    expect(headerRole('Afstemt')).toBeNull();
  });
  test('a Nordea-style header is known and maps itself', () => {
    const plan = planCsv('Bogføringsdato;Beløb;Afsender;Modtager;Navn;Beskrivelse;Saldo;Valuta\n2026/10/24;-45,00;;;Irma;Irma Fisketorvet;9.955,00;DKK\n');
    expect(plan.hasHeader).toBe(true);
    expect(plan.known).toBe(true);
    expect(plan.mapping[0]).toBe('date');
    expect(plan.mapping[1]).toBe('amount');
    expect(plan.mapping[6]).toBe('balance');
    expect(plan.mapping[7]).toBe('currency');
    const { txs } = rowsToTransactions(plan.rows, plan.mapping, plan.decimal);
    expect(txs[0]).toEqual({ booked_on: '2026-10-24', amount: -45, text: 'Irma · Irma Fisketorvet', balance_after: 9955, currency: 'DKK' });
  });
  test('a header-less Danske export is guessed and asks to be confirmed', () => {
    const csv = [
      '"24.10.2026";"Dankort-nota Netto 4421";"-123,45";"9.876,55";"Udført";"Nej"',
      '"23.10.2026";"Løn";"25.000,00";"10.000,00";"Udført";"Nej"',
      '"22.10.2026";"MobilePay Peter Hansen";"-150,00";"-15.000,00";"Udført";"Nej"',
    ].join('\n');
    const plan = planCsv(csv);
    expect(plan.hasHeader).toBe(false);
    expect(plan.known).toBe(false);
    expect(plan.headers[0]).toBe('Column 1');
    expect(plan.mapping.slice(0, 4)).toEqual(['date', 'text', 'amount', 'balance']);
    expect(mappingProblems(plan.mapping)).toEqual([]);
  });
  test('an unknown header falls back to the guess', () => {
    const plan = planCsv('When,What,How much\n2026-10-24,Netto,-45.00\n2026-10-25,Irma,-12.50\n');
    expect(plan.hasHeader).toBe(false);
    expect(plan.known).toBe(false);
    const guess = guessMapping(plan.rows.slice(1));
    expect(guess).toEqual(['date', 'text', 'amount']);
  });
  test('the mapping step names what is missing', () => {
    expect(mappingProblems(['ignore', 'text'])).toEqual(['Choose the column with the date.', 'Choose the column with the amount.']);
    expect(mappingProblems(['date', 'text', 'outflow'])).toEqual([]);
  });
});

describe('rows to transactions', () => {
  test('money in and money out columns make one signed amount', () => {
    const { txs, rejected } = rowsToTransactions([['01-10-2026', 'Rent', '', '8.500,00'], ['02-10-2026', 'Salary', '25.000,00', ''], ['bad', 'x', '1', '']], ['date', 'text', 'inflow', 'outflow'], ',');
    expect(txs.map((t) => t.amount)).toEqual([-8500, 25000]);
    expect(rejected).toBe(1);
  });
  test('ids repeat for the same rows and separate identical rows within a file', () => {
    const a = { booked_on: '2026-10-24', amount: -35, text: 'Espresso House', balance_after: null, currency: null };
    const ids = transactionIds('acct', [a, a, { ...a, amount: -36 }]);
    expect(new Set(ids).size).toBe(3);
    expect(transactionIds('acct', [a, a])).toEqual(ids.slice(0, 2));
    expect(transactionIds('other', [a])[0]).not.toBe(ids[0]);
    expect(ids[0].startsWith('csv-')).toBe(true);
    expect(hash53('x')).toBe(hash53('x'));
  });
  test('the latest balance is the end of the newest day, whatever the order', () => {
    const rows = [
      { booked_on: '2026-10-24', amount: -100, text: 'a', balance_after: 900, currency: null },
      { booked_on: '2026-10-24', amount: -50, text: 'b', balance_after: 850, currency: null },
      { booked_on: '2026-10-23', amount: 1000, text: 'c', balance_after: 1000, currency: null },
    ];
    expect(latestBalance(rows)).toEqual({ balance: 850, on: '2026-10-24' });
    expect(latestBalance([...rows].reverse())).toEqual({ balance: 850, on: '2026-10-24' });
    expect(latestBalance([{ ...rows[0], balance_after: null }])).toBeNull();
    expect(spanOf(rows)).toEqual({ from: '2026-10-23', to: '2026-10-24' });
  });
});
