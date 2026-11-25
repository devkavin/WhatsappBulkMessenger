import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CountryCode } from 'libphonenumber-js/max';
import sharp from 'sharp';
import { ImportError, parseContacts } from '../imports/contacts.ts';
import type { ContactRow } from '../imports/contacts.ts';
import { matchImages } from '../imports/matches.ts';
import type { TicketImage } from '../imports/matches.ts';

export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_BATCH_SIZE = 8;

export type ContactImport = { filename: string; contacts: ContactRow[] };
export type IncomingImage = { filename: string; bytes: Buffer };
export type UploadIssue = { filename: string; reason: string };
type FilesData = { csv: ContactImport | null; images: TicketImage[] };

export interface FilesRepository {
  read(): Promise<FilesData>;
  replaceCsv(csv: ContactImport): Promise<void>;
  addImage(image: TicketImage, draft?: boolean): Promise<void>;
  findImage(id: string): Promise<TicketImage | null>;
  removeDraftImage(id: string): Promise<boolean>;
}

export class FilesService {
  private readonly repository: FilesRepository;
  private readonly directory: string;
  private readonly country: CountryCode;

  constructor(repository: FilesRepository, directory: string, country: CountryCode) {
    this.repository = repository;
    this.directory = directory;
    this.country = country;
  }

  async read() {
    const data = await this.repository.read();
    return { ...data, matches: matchImages(data.csv?.contacts ?? [], data.images) };
  }

  async replaceCsv(filename: string, bytes: Buffer): Promise<void> {
    if (!safeFilename(filename) || !/\.csv$/i.test(filename)) throw new ImportError('Choose a file with a .csv extension.');
    if (bytes.length > CSV_MAX_BYTES) throw new ImportError('The CSV must be 2 MB or smaller.');

    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ImportError('Save the CSV using UTF-8 encoding and try again.');
    }
    const contacts = parseContacts(content, this.country);
    if (!contacts.length) throw new ImportError('The CSV needs at least one contact row.');
    await this.repository.replaceCsv({ filename, contacts });
  }

  async uploadImages(files: IncomingImage[]) {
    const uploaded: string[] = [];
    const errors: UploadIssue[] = [];
    const selectedNames = new Set<string>();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });

    for (const { filename, bytes } of files) {
      const inspection = selectedNames.has(filename)
        ? { error: 'This filename appears more than once in the selection.' }
        : await inspectImage(filename, bytes);
      selectedNames.add(filename);
      if ('error' in inspection) {
        errors.push({ filename, reason: inspection.error });
        continue;
      }

      await this.storeImage(filename, bytes, inspection.contentType, true);
      uploaded.push(filename);
    }
    return { uploaded, errors };
  }

  async saveTestImage({ filename, bytes }: IncomingImage) {
    const inspection = await inspectImage(filename, bytes);
    if ('error' in inspection) throw new ImportError(inspection.error);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return this.storeImage(filename, bytes, inspection.contentType, false);
  }

  private async storeImage(filename: string, bytes: Buffer, contentType: TicketImage['contentType'], draft: boolean) {
    const id = randomUUID();
    const path = join(this.directory, id);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await this.repository.addImage({ id, filename, contentType }, draft);
    } catch (error) {
      // A server can commit and lose its connection before the acknowledgement arrives.
      if (!(await this.repository.findImage(id))) {
        await unlink(path);
        throw error;
      }
    }
    return id;
  }

  async openImage(id: string) {
    if (!isImageId(id)) return null;
    const image = await this.repository.findImage(id);
    return image && { ...image, path: join(this.directory, id) };
  }

  async removeDraftImage(id: string) {
    return isImageId(id) && this.repository.removeDraftImage(id);
  }
}

function safeFilename(name: string) {
  return /^[^/\\\u0000-\u001F\u007F]{1,255}$/u.test(name) && name === name.trim();
}

function isImageId(value: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
}

async function inspectImage(filename: string, bytes: Buffer): Promise<{ contentType: TicketImage['contentType'] } | { error: string }> {
  const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (!safeFilename(filename) || filename.startsWith('.') || !['.png', '.jpg', '.jpeg'].includes(extension)) {
    return { error: 'Use a ticket filename ending in .png, .jpg, or .jpeg.' };
  }
  if (bytes.length > IMAGE_MAX_BYTES) return { error: 'Images must be 5 MB or smaller.' };

  const expected = extension === '.png' ? 'png' : 'jpeg';
  try {
    const input = sharp(bytes, { limitInputPixels: 25_000_000 });
    const metadata = await input.metadata();
    if (metadata.format !== expected || (metadata.pages ?? 1) !== 1) {
      return { error: 'The file content does not match its image extension.' };
    }
    await input.stats();
    return { contentType: expected === 'png' ? 'image/png' : 'image/jpeg' };
  } catch {
    return { error: 'The file is damaged or larger than 25 megapixels.' };
  }
}
