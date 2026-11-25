import { parse } from 'csv-parse/sync';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { CountryCode } from 'libphonenumber-js/max';

export type ContactRow = {
  row: number;
  ticketNumber: string;
  name: string;
  rank: string;
  contact: string;
  phone: string | null;
  issues: string[];
};

export class ImportError extends Error {}

type CsvRecord = { record: string[]; raw: string };

export function parseContacts(csv: string, defaultCountry: CountryCode): ContactRow[] {
  let records: CsvRecord[];
  try {
    // The library declarations describe plain records even when raw output is enabled.
    records = parse(csv, {
      bom: true, skip_empty_lines: true, max_record_size: 65_536, raw: true,
    }) as unknown as CsvRecord[];
  } catch {
    throw new ImportError('The CSV has invalid quoting or a row with a different number of columns.');
  }

  const [header, ...values] = records;
  if (!header) throw new ImportError('The CSV is empty.');

  const columns = header.record.map(label => label.trim().toLowerCase());
  const required = ['Ticket No', 'Name', 'Contact'];
  for (const header of [...required, 'Rank']) {
    const label = header.toLowerCase();
    if (columns.indexOf(label) !== columns.lastIndexOf(label)) throw new ImportError(`Duplicate column: ${header}`);
    if (required.includes(header) && !columns.includes(label)) throw new ImportError(`Missing required column: ${header}`);
  }

  const ticketIndex = columns.indexOf('ticket no');
  const nameIndex = columns.indexOf('name');
  const contactIndex = columns.indexOf('contact');
  const rankIndex = columns.indexOf('rank');

  const totals = new Map<string, number>();
  let nextLine = 1 + lineBreaks(header.raw);
  const contacts = values.map(({ record, raw }) => {
    const row = nextLine + lineBreaks(raw.match(/^[\r\n]*/)?.[0] ?? '');
    nextLine += lineBreaks(raw);
    const ticketNumber = record[ticketIndex].trim();
    const name = record[nameIndex].trim();
    const contact = record[contactIndex].trim();
    const rank = record[rankIndex]?.trim() ?? '';
    const number = parsePhoneNumberFromString(contact, { defaultCountry, extract: false });
    const phone = number?.isValid() && !number.ext ? number.number : null;
    const issues: string[] = [];

    if (!contact) issues.push('Contact is blank');
    else if (!phone) issues.push('Contact is invalid');
    if (!name) issues.push('Name is blank');
    if (!ticketNumber) issues.push('Ticket number is blank');
    else totals.set(ticketNumber, (totals.get(ticketNumber) ?? 0) + 1);

    return { row, ticketNumber, name, rank, contact, phone, issues };
  });

  for (const contact of contacts) {
    if ((totals.get(contact.ticketNumber) ?? 0) > 1) contact.issues.push('Duplicate ticket number');
  }

  return contacts;
}

function lineBreaks(value: string) {
  return value.match(/\r\n|\r|\n/g)?.length ?? 0;
}
