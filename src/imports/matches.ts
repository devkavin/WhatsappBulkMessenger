import type { ContactRow } from './contacts.ts';

export type TicketImage = {
  id: string;
  filename: string;
  contentType: 'image/png' | 'image/jpeg';
};

export type ImageMatch = {
  contact: ContactRow;
  status: 'missing' | 'matched' | 'conflict';
  images: TicketImage[];
};

export function matchImages(contacts: ContactRow[], images: TicketImage[]) {
  const byStem = new Map<string, TicketImage[]>();
  const stems = new Set(contacts.map(contact => contact.ticketNumber).filter(Boolean));
  const unmatched: TicketImage[] = [];

  for (const image of images) {
    const stem = image.filename.slice(0, image.filename.lastIndexOf('.'));
    if (!stems.has(stem)) {
      unmatched.push(image);
      continue;
    }

    const matches = byStem.get(stem) ?? [];
    matches.push(image);
    byStem.set(stem, matches);
  }

  const rows = contacts.map((contact): ImageMatch => {
    const matches = byStem.get(contact.ticketNumber) ?? [];
    return {
      contact,
      images: matches,
      status: matches.length > 1 ? 'conflict' : matches.length === 1 ? 'matched' : 'missing',
    };
  });

  return { rows, unmatched };
}
