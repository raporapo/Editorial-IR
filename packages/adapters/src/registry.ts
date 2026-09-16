import { EditorialError, type AdapterCapabilities } from '@editorial-ir/contracts';
import type { EditorAdapter } from './types.js';
import { OtioAdapter } from './otio.js';
import { PremiereAdapter } from './premiere.js';
import { AviUtl2Adapter } from './aviutl2.js';

/** Every adapter shipped with the project, by id. */
export function createAdapter(id: string): EditorAdapter {
  switch (id) {
    case 'otio':
      return new OtioAdapter();
    case 'premiere':
      return new PremiereAdapter();
    case 'aviutl2':
      return new AviUtl2Adapter();
    default:
      throw new EditorialError('unsupported', `there is no adapter called "${id}"`, {
        available: listAdapters().map((a) => a.id),
      });
  }
}

export function listAdapters(): AdapterCapabilities[] {
  return [new OtioAdapter(), new PremiereAdapter(), new AviUtl2Adapter()].map((a) => a.capabilities);
}
