import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.ts';
import { parseContacts } from '../src/imports/contacts.ts';
import { matchImages } from '../src/imports/matches.ts';

test('loads MySQL configuration from one URL without leaking invalid credentials', () => {
  const config = readConfig({
    DATABASE_URL: 'mysql://dinner_dance_app:p%40ss@mysql-host:3307/dinnerdance',
    APP_PASSWORD: 'a long local password',
    SESSION_SECRET: '12345678901234567890123456789012',
  });
  assert.deepEqual(config.database, {
    host: 'mysql-host', port: 3307, user: 'dinner_dance_app', password: 'p@ss', database: 'dinnerdance',
  });
  assert.throws(() => readConfig({ DATABASE_URL: 'http://user:secret@localhost/db' }), {
    message: 'Set DATABASE_URL to a valid MySQL connection URL.',
  });
});

test('imports reordered columns, BOM, quoted names, and ticket numbers as text', () => {
  const contacts = parseContacts('\uFEFFName,Contact,Ticket No,Extra\n"Perera, Mira",0771234567,0042,ignored\nRavi,0771234567,0043,ignored', 'LK');
  assert.equal(contacts.length, 2);
  assert.deepEqual(contacts[0], {
    row: 2, ticketNumber: '0042', name: 'Perera, Mira', rank: '', contact: '0771234567',
    phone: '+94771234567', issues: [],
  });
  assert.deepEqual(contacts[1].issues, []);
});

test('reports missing columns, invalid contacts, blank contacts, and duplicate tickets', () => {
  assert.throws(() => parseContacts('Name,Ticket No\nMira,0042', 'LK'), /Missing required column: Contact/);
  const contacts = parseContacts('Ticket No,Name,Contact,Rank\n0042,Mira,,Capt.\n0042,Ravi,invalid,Lt.', 'LK');
  assert.deepEqual(contacts[0].issues, ['Contact is blank', 'Duplicate ticket number']);
  assert.deepEqual(contacts[1].issues, ['Contact is invalid', 'Duplicate ticket number']);
  assert.equal(contacts[0].rank, 'Capt.');
});

test('reports the source line after skipped blanks and quoted multiline names', () => {
  const rows = parseContacts('Ticket No,Name,Contact\r\n\r\n0042,"Mira\r\nPerera",0771234567\r\n0043,Ravi,', 'LK');
  assert.deepEqual(rows.map(row => row.row), [3, 5]);
  assert.deepEqual(rows[1].issues, ['Contact is blank']);
});

test('matches exact filename stems and reports missing, unmatched, and conflicting images', () => {
  const rows = parseContacts('Ticket No,Name,Contact\n0042,Mira,0771234567\n0043,Ravi,0771234567', 'LK');
  const assets = [
    { id: 'one', filename: '0042.PNG', contentType: 'image/png' },
    { id: 'two', filename: '042.jpg', contentType: 'image/jpeg' },
  ];
  const basic = matchImages(rows, assets);
  assert.deepEqual(basic.rows.map(row => row.status), ['matched', 'missing']);
  assert.deepEqual(basic.unmatched.map(image => image.id), ['two']);
  const conflict = matchImages(rows, [...assets, { id: 'three', filename: '0042.jpg', contentType: 'image/jpeg' }]);
  assert.equal(conflict.rows[0].status, 'conflict');
  assert.equal(conflict.rows[0].images.length, 2);
});
