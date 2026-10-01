import { describe, expect, it } from 'vitest';
import type { MaterialProfile, MediaAsset } from '@editorial-ir/contracts';
import { materialLines } from '../src/commands/analyze.js';

/**
 * What `oea analyze` says each file was taken to be.
 *
 * The section exists so a wrong guess can be seen and overruled. Listing every
 * photograph as "a still image (a still image)" buried the one guess in a folder
 * that mattered.
 */
function profile(id: string, kind: MaterialProfile['kind'], evidence: string): MaterialProfile {
  return {
    asset_id: id,
    kind,
    confidence: kind === 'still' ? 1 : 0.9,
    provenance: 'inferred',
    evidence: [evidence],
    signals: {},
  };
}

function asset(id: string, fileName: string): MediaAsset {
  return {
    id,
    path: fileName,
    file_name: fileName,
    kind: fileName.endsWith('.jpg') ? 'image' : 'video',
    sha256: 'a'.repeat(64),
    byte_size: 1,
    duration_ms: fileName.endsWith('.jpg') ? 0 : 60_000,
    metadata: {},
  };
}

describe('the material section', () => {
  it('names the file taken for an edit, even behind forty photographs that sort first', () => {
    const photos = Array.from({ length: 40 }, (_, i) => {
      const id = `asset_${String(i + 1).padStart(3, '0')}`;
      return { asset: asset(id, `IMG_${1000 + i}.jpg`), profile: profile(id, 'still', 'a still') };
    });
    const edit = {
      asset: asset('asset_041', 'final_v3.mp4'),
      profile: profile('asset_041', 'edited', '16 cuts a minute over 60 s'),
    };
    const lines = materialLines(
      [...photos.map((p) => p.profile), edit.profile],
      [...photos.map((p) => p.asset), edit.asset],
    );
    expect(lines).toEqual([
      '40 still image(s)',
      'final_v3.mp4: already edited (16 cuts a minute over 60 s)',
      'wrong? set it in context.yaml: background.materials: { "<file name>": raw }',
    ]);
  });

  it('names what the user set, and does not ask whether it is wrong', () => {
    const set = { ...profile('asset_001', 'raw', ''), provenance: 'user_provided' as const };
    expect(materialLines([set], [asset('asset_001', 'final_v3.mp4')])).toEqual([
      'final_v3.mp4: a camera recording (as you said)',
    ]);
  });
});
