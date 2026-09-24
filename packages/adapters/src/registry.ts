import { EditorialError, type AdapterCapabilities } from '@editorial-ir/contracts';
import type { EditorAdapter } from './types.js';
import { OtioAdapter } from './otio.js';
import { PremiereAdapter } from './premiere.js';
import { AviUtl2Adapter } from './aviutl2.js';

const ADAPTERS: Record<string, () => EditorAdapter> = {
  otio: () => new OtioAdapter(),
  premiere: () => new PremiereAdapter(),
  aviutl2: () => new AviUtl2Adapter(),
};

/** Every adapter shipped with the project, by id. */
export function createAdapter(id: string): EditorAdapter {
  const make = ADAPTERS[id];
  if (!make) {
    throw new EditorialError('unsupported', `there is no adapter called "${id}"`, {
      available: listAdapters().map((a) => a.id),
    });
  }
  return make();
}

export function listAdapters(): AdapterCapabilities[] {
  return Object.values(ADAPTERS).map((make) => make().capabilities);
}
