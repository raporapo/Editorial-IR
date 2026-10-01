import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bufferSource, isHeifFile, photoDateOf, readPhotoDate, sniffStill } from '../src/exif.js';

/**
 * Reading when a photo was taken, from bytes built here field by field.
 *
 * ffprobe gives a JPEG no tags, so a photo had no capture time, and one photo
 * without one put a whole project in file-name order. Each container keeps the
 * same TIFF structure in a different place; each is built below the way a
 * camera or a phone writes it, and read back.
 */

type Tag = [tag: number, value: string];

/** A TIFF structure: IFD0 pointing at an Exif IFD holding ASCII tags. */
function tiff(exifTags: readonly Tag[], options: { big?: boolean; ifd0?: readonly Tag[] } = {}) {
  const little = !options.big;
  const ifd0Tags = options.ifd0 ?? [];
  const bytes: number[] = [];
  const u16 = (v: number) => (little ? bytes.push(v & 0xff, v >> 8) : bytes.push(v >> 8, v & 0xff));
  const u32 = (v: number) =>
    little
      ? bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24)
      : bytes.push(v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);

  const ifd0Count = ifd0Tags.length + 1;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifAt = 8 + ifd0Size;
  const exifSize = 2 + exifTags.length * 12 + 4;
  const dataAt = exifAt + exifSize;
  const data: number[] = [];
  const place = (value: string): { at: number } => {
    const at = dataAt + data.length;
    data.push(...Buffer.from(`${value}\0`, 'latin1'));
    if (data.length % 2) data.push(0);
    return { at };
  };
  const entry = (tag: number, value: string) => {
    const encoded = [...Buffer.from(`${value}\0`, 'latin1')];
    u16(tag);
    u16(2);
    u32(encoded.length);
    // Four bytes or fewer are the entry's own value field, as TIFF specifies.
    if (encoded.length <= 4) bytes.push(...encoded, ...new Array(4 - encoded.length).fill(0));
    else u32(place(value).at);
  };

  bytes.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]));
  u16(42);
  u32(8);
  u16(ifd0Count);
  // Values for IFD0 are placed after the Exif IFD's, so the data area starts
  // after both directories.
  const ifd0Values = ifd0Tags.map(([tag, value]) => ({ tag, value }));
  for (const { tag, value } of ifd0Values) entry(tag, value);
  u16(0x8769);
  u16(4);
  u32(1);
  u32(exifAt);
  u32(0);
  u16(exifTags.length);
  for (const [tag, value] of exifTags) entry(tag, value);
  u32(0);
  return Uint8Array.from([...bytes, ...data]);
}

const DATE_ORIGINAL = 0x9003;
const DATE_DIGITIZED = 0x9004;
const OFFSET_ORIGINAL = 0x9011;
const SUBSEC_ORIGINAL = 0x9291;
const DATE_TIME = 0x0132;

function be16(v: number): number[] {
  return [v >> 8, v & 0xff];
}
function be32(v: number): number[] {
  return [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}
function le32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];
}
function ascii(text: string): number[] {
  return [...Buffer.from(text, 'latin1')];
}

/** A JPEG: SOI, APP0 (JFIF), the given APP1 payloads, a scan that is never read, EOI. */
function jpeg(...app1: Uint8Array[]): Uint8Array {
  const out = [0xff, 0xd8];
  const jfif = [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  out.push(0xff, 0xe0, ...be16(jfif.length + 2), ...jfif);
  for (const payload of app1) out.push(0xff, 0xe1, ...be16(payload.length + 2), ...payload);
  out.push(0xff, 0xda, ...be16(4), 0, 0, 0x12, 0x34, 0xff, 0xd9);
  return Uint8Array.from(out);
}

const exifPayload = (structure: Uint8Array) =>
  Uint8Array.from([...ascii('Exif\0\0'), ...structure]);

function png(chunks: [type: string, data: Uint8Array][]): Uint8Array {
  const out = [0x89, ...ascii('PNG\r\n\x1a\n')];
  const ihdr = Uint8Array.from([...be32(1), ...be32(1), 8, 0, 0, 0, 0]);
  for (const [type, data] of [['IHDR', ihdr], ...chunks, ['IEND', new Uint8Array(0)]] as const) {
    out.push(...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0);
  }
  return Uint8Array.from(out);
}

function box(type: string, body: readonly number[] | Uint8Array): number[] {
  return [...be32(body.length + 8), ...ascii(type), ...body];
}
function fullBox(type: string, version: number, body: readonly number[]): number[] {
  return box(type, [version, 0, 0, 0, ...body]);
}

/**
 * A HEIF as a phone writes one: `ftyp`, then `meta` naming an `hvc1` picture and
 * an `Exif` item, whose bytes are either in the file (`iloc` method 0, the Exif
 * item at the end of `mdat`) or in the `meta` box's own `idat` (method 1).
 */
function heif(structure: Uint8Array, options: { inIdat?: boolean; brand?: string } = {}) {
  const item = [...be32(0), ...structure];
  const infe = (id: number, type: string) =>
    fullBox('infe', 2, [...be16(id), ...be16(0), ...ascii(type), 0]);
  const iinf = fullBox('iinf', 0, [...be16(2), ...infe(1, 'hvc1'), ...infe(2, 'Exif')]);
  const hdlr = fullBox('hdlr', 0, [0, 0, 0, 0, ...ascii('pict'), ...new Array(12).fill(0), 0]);
  const ftyp = box('ftyp', [...ascii(options.brand ?? 'heic'), ...be32(0), ...ascii('mif1heic')]);
  const iloc = (base: number) =>
    fullBox('iloc', 1, [
      0x44,
      0x00,
      ...be16(2),
      ...be16(1),
      ...be16(0),
      ...be16(0),
      ...be16(1),
      ...be32(base),
      ...be32(16),
      ...be16(2),
      ...be16(options.inIdat ? 1 : 0),
      ...be16(0),
      ...be16(1),
      ...be32(options.inIdat ? 0 : base + 16),
      ...be32(item.length),
    ]);
  const idat = options.inIdat ? box('idat', item) : [];
  const meta = (base: number) => fullBox('meta', 0, [...hdlr, ...iloc(base), ...iinf, ...idat]);
  const mdatStart = ftyp.length + meta(0).length + 8;
  const mdat = box('mdat', [...new Array(16).fill(0), ...(options.inIdat ? [] : item)]);
  return Uint8Array.from([...ftyp, ...meta(mdatStart), ...mdat]);
}

const read = (bytes: Uint8Array) => readPhotoDate(bufferSource(bytes));

describe('the capture time of a JPEG', () => {
  it('is DateTimeOriginal, from the APP1 segment ffprobe does not read', () => {
    expect(read(jpeg(exifPayload(tiff([[DATE_ORIGINAL, '2026:05:17 18:00:00']]))))).toEqual({
      value: '2026:05:17 18:00:00',
      source: 'exif',
    });
  });

  it('carries the offset and the sub-second when the camera wrote them', () => {
    const structure = tiff([
      [DATE_ORIGINAL, '2026:05:17 18:00:00'],
      [SUBSEC_ORIGINAL, '25'],
      [OFFSET_ORIGINAL, '+09:00'],
    ]);
    expect(read(jpeg(exifPayload(structure)))?.value).toBe('2026:05:17 18:00:00.25+09:00');
  });

  it('reads a big-endian structure the same as a little-endian one', () => {
    const structure = tiff([[DATE_ORIGINAL, '2026:05:17 18:00:00']], { big: true });
    expect(read(jpeg(exifPayload(structure)))?.value).toBe('2026:05:17 18:00:00');
  });

  it('never takes DateTime, which an edit moves to the day of the edit', () => {
    // IFD0's DateTime is when the file was last written. A photo edited a week
    // later would be laid on the timeline a week late.
    const edited = tiff([], { ifd0: [[DATE_TIME, '2026:05:24 09:00:00']] });
    expect(read(jpeg(exifPayload(edited)))).toBeUndefined();
    const scanned = tiff([[DATE_DIGITIZED, '2026:05:18 07:30:00']], {
      ifd0: [[DATE_TIME, '2026:05:24 09:00:00']],
    });
    expect(read(jpeg(exifPayload(scanned)))?.value).toBe('2026:05:18 07:30:00');
  });

  it('treats the blank date of a camera whose clock was never set as no date', () => {
    expect(read(jpeg(exifPayload(tiff([[DATE_ORIGINAL, '0000:00:00 00:00:00']]))))).toBeUndefined();
    expect(read(jpeg(exifPayload(tiff([[DATE_ORIGINAL, '    :  :     :  :  ']]))))).toBeUndefined();
  });

  it('falls back to XMP when there is no EXIF', () => {
    const xmp = Uint8Array.from(
      ascii(
        'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description ' +
          'photoshop:DateCreated="2026-05-17T18:00:00+09:00"/></x:xmpmeta>',
      ),
    );
    expect(read(jpeg(xmp))).toEqual({ value: '2026-05-17T18:00:00+09:00', source: 'xmp' });
  });

  it('says nothing, and never throws, for a JPEG cut short or lying about its lengths', () => {
    const whole = jpeg(exifPayload(tiff([[DATE_ORIGINAL, '2026:05:17 18:00:00']])));
    for (let length = 0; length < whole.length; length += 7) {
      expect(() => read(whole.subarray(0, length))).not.toThrow();
    }
    const lying = Uint8Array.from(whole);
    lying[whole.indexOf(0xe1) + 1] = 0xff; // APP1 claims 65 kB
    expect(() => read(lying)).not.toThrow();
  });
});

describe('the capture time of other stills', () => {
  const structure = tiff([
    [DATE_ORIGINAL, '2026:05:17 18:00:00'],
    [OFFSET_ORIGINAL, '+09:00'],
  ]);

  it('is read from a PNG eXIf chunk, with or without the JPEG header in front', () => {
    expect(read(png([['eXIf', structure]]))?.value).toBe('2026:05:17 18:00:00+09:00');
    expect(read(png([['eXIf', exifPayload(structure)]]))?.value).toBe('2026:05:17 18:00:00+09:00');
  });

  it("is read from a PNG's Creation Time text, plain or compressed", () => {
    const text = Uint8Array.from(ascii('Creation Time\0Sun, 17 May 2026 18:00:00 +0900'));
    expect(read(png([['tEXt', text]]))).toEqual({
      value: 'Sun, 17 May 2026 18:00:00 +0900',
      source: 'png',
    });
    const compressed = Uint8Array.from([
      ...ascii('Creation Time\0'),
      1,
      0,
      0,
      0,
      ...deflateSync(Buffer.from('2026-05-17T18:00:00+09:00')),
    ]);
    expect(read(png([['iTXt', compressed]]))?.value).toBe('2026-05-17T18:00:00+09:00');
  });

  it('is read from a WebP EXIF chunk, after the picture', () => {
    const chunk = (type: string, data: readonly number[]) => [
      ...ascii(type),
      ...le32(data.length),
      ...data,
      ...(data.length % 2 ? [0] : []),
    ];
    const body = [
      ...ascii('WEBP'),
      ...chunk('VP8L', [0x2f, 0, 0, 0, 0]),
      ...chunk('EXIF', [...structure]),
    ];
    const bytes = Uint8Array.from([...ascii('RIFF'), ...le32(body.length), ...body]);
    expect(sniffStill(bufferSource(bytes))).toBe('webp');
    expect(read(bytes)?.value).toBe('2026:05:17 18:00:00+09:00');
  });

  it('is read from a TIFF, which is its own EXIF', () => {
    expect(read(structure)?.value).toBe('2026:05:17 18:00:00+09:00');
  });

  it('is read from the Exif item of a HEIC, wherever iloc says its bytes are', () => {
    const inMdat = heif(structure);
    expect(sniffStill(bufferSource(inMdat))).toBe('heif');
    expect(read(inMdat)?.value).toBe('2026:05:17 18:00:00+09:00');
    expect(read(heif(structure, { inIdat: true }))?.value).toBe('2026:05:17 18:00:00+09:00');
  });

  it('tells an AVIF from a HEIC, though both list the generic image brand', () => {
    expect(sniffStill(bufferSource(heif(structure, { brand: 'avif' })))).toBe('avif');
    expect(read(heif(structure, { brand: 'avif' }))?.value).toBe('2026:05:17 18:00:00+09:00');
  });
});

describe('a photo on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oea-exif-'));

  it('is read without loading the file, and a HEIC is known by its bytes, not its name', () => {
    const path = join(dir, 'IMG_0001.jpg');
    writeFileSync(path, jpeg(exifPayload(tiff([[DATE_ORIGINAL, '2026:05:17 18:00:00']]))));
    expect(photoDateOf(path)).toEqual({ value: '2026:05:17 18:00:00', source: 'exif' });

    const heic = join(dir, 'renamed.jpg');
    writeFileSync(heic, heif(tiff([[DATE_ORIGINAL, '2026:05:17 18:00:00']])));
    expect(isHeifFile(heic)).toBe(true);
    expect(isHeifFile(path)).toBe(false);
  });

  it('is no date, not an error, when it cannot be read at all', () => {
    expect(photoDateOf(join(dir, 'missing.jpg'))).toBeUndefined();
    expect(isHeifFile(join(dir, 'missing.heic'))).toBe(false);
  });
});
