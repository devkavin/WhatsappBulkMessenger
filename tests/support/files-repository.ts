import type { ContactImport, FilesRepository } from '../../src/files/service.ts';
import type { TicketImage } from '../../src/imports/matches.ts';

export function memoryFilesRepository(onChange = () => {}) : FilesRepository {
  let csv: ContactImport | null = null;
  const current = new Map<string, TicketImage>();
  const versions = new Map<string, TicketImage>();

  return {
    async read() { return { csv, images: Array.from(current.values()) }; },
    async replaceCsv(next) { csv = next; onChange(); },
    async addImage(image, draft = true) {
      versions.set(image.id, image);
      if (draft) { current.set(image.filename, image); onChange(); }
    },
    async findImage(id) { return versions.get(id) ?? null; },
    async removeDraftImage(id) {
      const image = versions.get(id);
      if (!image || current.get(image.filename)?.id !== id) return false;
      current.delete(image.filename);
      onChange();
      return true;
    },
  };
}
