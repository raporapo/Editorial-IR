import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { parseCaptureTime } from '@editorial-ir/contracts';

/**
 * When a photograph was taken, read from the photograph.
 *
 * ffprobe gives a JPEG no tags at all, so every photo was an asset with no
 * capture time — and one asset without one switched the whole project to
 * file-name order. Measured: B.MOV at 10:00:00 and A.MOV at 10:00:10 were laid
 * out A, B as soon as a photo.jpg joined them. The camera did write the time,
 * in EXIF, and reading it needs a header walk, not a library: JPEG keeps it in
 * an APP1 segment, PNG in an `eXIf` chunk, WebP in an `EXIF` chunk, HEIF and
 * AVIF in an `Exif` item, TIFF in its own first directory. All of it is TIFF
 * underneath, and all of it is a few reads near the start of the file.
 *
 * Pure TypeScript, because the project has no native dependency and this is not
 * the place to acquire one; and in the compiler, not in either perception
 * runtime, so there is one implementation to keep right.
 */

/** Random access to bytes: a file on disk, or a buffer in a test. */
export interface ByteSource {
  readonly size: number;
  /** Up to `length` bytes from `offset`; fewer at the end, none past it. */
  read(offset: number, length: number): Uint8Array;
}

export function bufferSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) =>
      offset < 0 || offset >= bytes.length
        ? new Uint8Array(0)
        : bytes.subarray(offset, Math.min(bytes.length, offset + length)),
  };
}

function withFile<T>(path: string, use: (source: ByteSource) => T): T {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    return use({
      size,
      read: (offset, length) => {
        if (offset < 0 || offset >= size) return new Uint8Array(0);
        const buffer = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
        const read = readSync(fd, buffer, 0, buffer.length, offset);
        return buffer.subarray(0, read);
      },
    });
  } finally {
    closeSync(fd);
  }
}

export type StillContainer = 'jpeg' | 'png' | 'webp' | 'tiff' | 'heif' | 'avif';

/** HEIF brands that hold HEVC pictures (`mif1` is the generic image brand). */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

/** What kind of still a file is, from its first bytes rather than its name. */
export function sniffStill(source: ByteSource): StillContainer | undefined {
  const head = source.read(0, 64);
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (ascii(head, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp';
  if (ascii(head, 0, 4) === 'II*\0' || ascii(head, 0, 4) === 'MM\0*') return 'tiff';
  if (ascii(head, 4, 4) === 'ftyp') {
    const size = u32(head, 0, false);
    const brands = [ascii(head, 8, 4)];
    for (let at = 16; at + 4 <= Math.min(size, head.length); at += 4) {
      brands.push(ascii(head, at, 4));
    }
    // AVIF first: an AVIF lists `mif1` too, and it is not an HEVC picture.
    if (brands.some((brand) => AVIF_BRANDS.has(brand))) return 'avif';
    if (brands.some((brand) => HEIF_BRANDS.has(brand))) return 'heif';
  }
  return undefined;
}

/** Whether a file is a HEIF/HEIC picture, whatever it is called. Never throws. */
export function isHeifFile(path: string): boolean {
  try {
    return withFile(path, sniffStill) === 'heif';
  } catch {
    return false;
  }
}

/** A photo's capture time as written, and where in the file it was found. */
export interface PhotoDate {
  /**
   * The value, in a form `parseCaptureTime` reads: EXIF's own
   * `2026:05:17 18:00:00`, with `.123` from `SubSecTimeOriginal` and `+09:00`
   * from `OffsetTimeOriginal` appended when the camera wrote them.
   */
  value: string;
  source: 'exif' | 'xmp' | 'png';
}

/** The capture time of a photo on disk, or nothing. Never throws: a photo with no date is a photo. */
export function photoDateOf(path: string): PhotoDate | undefined {
  try {
    return withFile(path, readPhotoDate);
  } catch {
    return undefined;
  }
}

/**
 * The capture time written inside a still, in order of trust: EXIF's
 * `DateTimeOriginal` (when the shutter fired), then `DateTimeDigitized` (when a
 * scan was made), then XMP, then a PNG's `Creation Time`. EXIF's plain
 * `DateTime` is left out: it is when the file was last changed, and an edit in
 * a photo app moves it to the day of the edit.
 */
export function readPhotoDate(source: ByteSource): PhotoDate | undefined {
  const found = collect(source);
  if (!found) return undefined;
  const fromExif = found.exif ? tiffDate(bufferSource(found.exif)) : undefined;
  if (fromExif) return { value: fromExif, source: 'exif' };
  const fromTiff = found.tiffAt === undefined ? undefined : tiffDate(source, found.tiffAt);
  if (fromTiff) return { value: fromTiff, source: 'exif' };
  const fromXmp = found.xmp === undefined ? undefined : xmpDate(found.xmp);
  if (fromXmp) return { value: fromXmp, source: 'xmp' };
  const fromText = found.pngTime?.trim();
  if (fromText && parseCaptureTime(fromText)) return { value: fromText, source: 'png' };
  return undefined;
}

interface Found {
  /** A TIFF-structured EXIF block, already cut out of its container. */
  exif?: Uint8Array;
  /** Where the TIFF structure starts in the file itself, for a TIFF file. */
  tiffAt?: number;
  xmp?: string;
  pngTime?: string;
}

/** Nothing inside a photo's metadata is bigger than this; a length that says so is corrupt. */
const MAX_BLOCK = 4 * 1024 * 1024;

function collect(source: ByteSource): Found | undefined {
  switch (sniffStill(source)) {
    case 'jpeg':
      return fromJpeg(source);
    case 'png':
      return fromPng(source);
    case 'webp':
      return fromWebp(source);
    case 'tiff':
      return { tiffAt: 0 };
    case 'heif':
    case 'avif':
      return fromHeif(source);
    default:
      return undefined;
  }
}

const EXIF_HEADER = 'Exif\0\0';
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

/** JPEG: markers from the start up to the first scan, looking at APP1. */
function fromJpeg(source: ByteSource): Found {
  const found: Found = {};
  let at = 2;
  for (let guard = 0; guard < 4096 && at + 4 <= source.size; guard++) {
    const marker = source.read(at, 4);
    if (marker[0] !== 0xff) break;
    const code = marker[1]!;
    if (code === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (code === 0xd9 || code === 0xda) break; // end of image, start of scan
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = u16(marker, 2, false);
    if (length < 2) break;
    if (code === 0xe1 && length - 2 <= MAX_BLOCK) {
      const payload = source.read(at + 4, length - 2);
      if (!found.exif && ascii(payload, 0, 6) === EXIF_HEADER) found.exif = payload.subarray(6);
      else if (found.xmp === undefined && ascii(payload, 0, XMP_HEADER.length) === XMP_HEADER) {
        found.xmp = utf8(payload.subarray(XMP_HEADER.length));
      }
    }
    at += 2 + length;
  }
  return found;
}

/** PNG: every chunk header, since `eXIf` may come after the picture data. */
function fromPng(source: ByteSource): Found {
  const found: Found = {};
  let at = 8;
  for (let guard = 0; guard < 100_000 && at + 8 <= source.size; guard++) {
    const header = source.read(at, 8);
    const length = u32(header, 0, false);
    const type = ascii(header, 4, 4);
    if (type === 'IEND') break;
    if (length <= MAX_BLOCK && (type === 'eXIf' || type === 'tEXt' || type === 'iTXt')) {
      const data = source.read(at + 8, length);
      if (type === 'eXIf' && !found.exif) {
        // The chunk is the TIFF structure itself; some writers keep the JPEG
        // `Exif\0\0` in front of it anyway.
        found.exif = ascii(data, 0, 6) === EXIF_HEADER ? data.subarray(6) : data;
      } else if (type === 'tEXt') {
        const [keyword, text] = splitNul(data);
        if (keyword === 'Creation Time' && found.pngTime === undefined)
          found.pngTime = latin1(text);
      } else if (type === 'iTXt') {
        const text = internationalText(data);
        if (text?.keyword === 'XML:com.adobe.xmp' && found.xmp === undefined) found.xmp = text.text;
        if (text?.keyword === 'Creation Time' && found.pngTime === undefined) {
          found.pngTime = text.text;
        }
      }
    }
    at += 12 + length;
  }
  return found;
}

/** WebP: RIFF chunks, `EXIF` and `XMP ` usually after the picture. */
function fromWebp(source: ByteSource): Found {
  const found: Found = {};
  let at = 12;
  for (let guard = 0; guard < 10_000 && at + 8 <= source.size; guard++) {
    const header = source.read(at, 8);
    const type = ascii(header, 0, 4);
    const length = u32(header, 4, true);
    if (length <= MAX_BLOCK && (type === 'EXIF' || type === 'XMP ')) {
      const data = source.read(at + 8, length);
      if (type === 'EXIF') found.exif = ascii(data, 0, 6) === EXIF_HEADER ? data.subarray(6) : data;
      else found.xmp = utf8(data);
    }
    at += 8 + length + (length % 2);
  }
  return found;
}

/**
 * HEIF and AVIF: the `Exif` item, found through the `meta` box.
 *
 * `iinf` says which item is the EXIF, `iloc` where its bytes are — in the file
 * or in the `meta` box's own `idat` — and the item starts with the offset of the
 * TIFF header inside it. A phone writes the item at the end of the file as often
 * as at the start, so this reads where `iloc` points rather than scanning.
 */
function fromHeif(source: ByteSource): Found {
  const meta = topLevelBox(source, 'meta');
  if (!meta || meta.size > MAX_BLOCK) return {};
  const body = source.read(meta.start + 4, meta.size - 4); // a FullBox: skip version and flags
  const children = boxesIn(body);
  const exifId = exifItemId(children.get('iinf'));
  const locations = children.get('iloc');
  if (exifId === undefined || !locations) return {};
  const place = itemLocation(locations, exifId);
  if (!place) return {};

  const parts: Uint8Array[] = [];
  let total = 0;
  for (const extent of place.extents) {
    if (extent.length > MAX_BLOCK || total + extent.length > MAX_BLOCK) return {};
    const bytes =
      place.method === 1
        ? (children.get('idat') ?? new Uint8Array(0)).subarray(
            place.base + extent.offset,
            place.base + extent.offset + extent.length,
          )
        : place.method === 0
          ? source.read(place.base + extent.offset, extent.length)
          : new Uint8Array(0);
    parts.push(bytes);
    total += bytes.length;
  }
  const item = concat(parts);
  if (item.length < 4) return {};
  const tiffAt = 4 + u32(item, 0, false);
  return tiffAt < item.length ? { exif: item.subarray(tiffAt) } : {};
}

function topLevelBox(
  source: ByteSource,
  type: string,
): { start: number; size: number } | undefined {
  let at = 0;
  for (let guard = 0; guard < 1000 && at + 8 <= source.size; guard++) {
    const header = source.read(at, 16);
    let size = u32(header, 0, false);
    let headerSize = 8;
    if (size === 1) {
      size = u64(header, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = source.size - at;
    }
    if (size < headerSize) return undefined;
    if (ascii(header, 4, 4) === type) return { start: at + headerSize, size: size - headerSize };
    at += size;
  }
  return undefined;
}

/** The child boxes of a container box's body, by type (the first of each). */
function boxesIn(body: Uint8Array): Map<string, Uint8Array> {
  const boxes = new Map<string, Uint8Array>();
  let at = 0;
  while (at + 8 <= body.length) {
    const size = u32(body, at, false);
    if (size < 8 || at + size > body.length) break;
    const type = ascii(body, at + 4, 4);
    if (!boxes.has(type)) boxes.set(type, body.subarray(at + 8, at + size));
    at += size;
  }
  return boxes;
}

function exifItemId(iinf: Uint8Array | undefined): number | undefined {
  if (!iinf || iinf.length < 6) return undefined;
  const version = iinf[0]!;
  let at = 4 + (version === 0 ? 2 : 4);
  while (at + 8 <= iinf.length) {
    const size = u32(iinf, at, false);
    if (size < 8 || at + size > iinf.length) break;
    if (ascii(iinf, at + 4, 4) === 'infe') {
      const entry = iinf.subarray(at + 8, at + size);
      const entryVersion = entry[0]!;
      if (entryVersion >= 2) {
        const wide = entryVersion >= 3;
        const id = wide ? u32(entry, 4, false) : u16(entry, 4, false);
        const typeAt = 4 + (wide ? 4 : 2) + 2;
        if (ascii(entry, typeAt, 4) === 'Exif') return id;
      }
    }
    at += size;
  }
  return undefined;
}

interface ItemLocation {
  method: number;
  base: number;
  extents: { offset: number; length: number }[];
}

function itemLocation(iloc: Uint8Array, wanted: number): ItemLocation | undefined {
  const version = iloc[0]!;
  if (iloc.length < 8 || version > 2) return undefined;
  const offsetSize = iloc[4]! >> 4;
  const lengthSize = iloc[4]! & 0x0f;
  const baseSize = iloc[5]! >> 4;
  const indexSize = version >= 1 ? iloc[5]! & 0x0f : 0;
  let at = 6;
  const read = (bytes: number): number => {
    const value = sized(iloc, at, bytes);
    at += bytes;
    return value;
  };
  const count = read(version < 2 ? 2 : 4);
  for (let item = 0; item < count && at < iloc.length; item++) {
    const id = read(version < 2 ? 2 : 4);
    const method = version >= 1 ? read(2) & 0x0f : 0;
    read(2); // data_reference_index
    const base = read(baseSize);
    const extentCount = read(2);
    const extents: ItemLocation['extents'] = [];
    for (let e = 0; e < extentCount && at <= iloc.length; e++) {
      if (indexSize > 0) read(indexSize);
      const offset = read(offsetSize);
      const length = read(lengthSize);
      extents.push({ offset, length });
    }
    if (at > iloc.length) return undefined;
    if (id === wanted) return { method, base, extents };
  }
  return undefined;
}

/* --- TIFF, which every one of those containers holds ------------------------ */

const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_ORIGINAL = 0x9003;
const TAG_DATE_DIGITIZED = 0x9004;
const TAG_OFFSET_ORIGINAL = 0x9011;
const TAG_OFFSET_DIGITIZED = 0x9012;
const TAG_SUBSEC_ORIGINAL = 0x9291;
const TAG_SUBSEC_DIGITIZED = 0x9292;
const TYPE_ASCII = 2;

interface IfdEntry {
  type: number;
  count: number;
  /** Where the value's four bytes (or the offset to it) are, from the TIFF start. */
  at: number;
}

/**
 * The capture time in a TIFF structure starting at `base`: the Exif directory's
 * `DateTimeOriginal`, else its `DateTimeDigitized`, each with its own sub-second
 * and offset. A date that does not parse — cameras write `0000:00:00 00:00:00`
 * and blanks when the clock was never set — is no date.
 */
function tiffDate(source: ByteSource, base = 0): string | undefined {
  const header = source.read(base, 8);
  if (header.length < 8) return undefined;
  const little = ascii(header, 0, 2) === 'II';
  if (!little && ascii(header, 0, 2) !== 'MM') return undefined;
  if (u16(header, 2, little) !== 42) return undefined;
  const first = directory(source, base, u32(header, 4, little), little);
  const pointer = first.get(TAG_EXIF_IFD);
  if (!pointer) return undefined;
  const exif = directory(source, base, u32(source.read(base + pointer.at, 4), 0, little), little);
  const text = (tag: number): string | undefined => {
    const entry = exif.get(tag);
    if (!entry || entry.type !== TYPE_ASCII || entry.count === 0 || entry.count > 256) {
      return undefined;
    }
    const at = entry.count <= 4 ? entry.at : u32(source.read(base + entry.at, 4), 0, little);
    const value = latin1(source.read(base + at, entry.count))
      .replace(/\0.*$/s, '')
      .trim();
    return value.length > 0 ? value : undefined;
  };

  for (const [date, subsec, offset] of [
    [TAG_DATE_ORIGINAL, TAG_SUBSEC_ORIGINAL, TAG_OFFSET_ORIGINAL],
    [TAG_DATE_DIGITIZED, TAG_SUBSEC_DIGITIZED, TAG_OFFSET_DIGITIZED],
  ] as const) {
    const written = text(date);
    if (!written) continue;
    const fraction = text(subsec);
    const zone = text(offset);
    const value =
      written +
      (fraction && /^\d+$/.test(fraction) ? `.${fraction}` : '') +
      (zone && /^[+-]\d{2}:\d{2}$/.test(zone) ? zone : '');
    if (parseCaptureTime(value)) return value;
  }
  return undefined;
}

function directory(
  source: ByteSource,
  base: number,
  offset: number,
  little: boolean,
): Map<number, IfdEntry> {
  const entries = new Map<number, IfdEntry>();
  const count = u16(source.read(base + offset, 2), 0, little);
  if (count === 0 || count > 1000) return entries;
  const table = source.read(base + offset + 2, count * 12);
  for (let i = 0; i + 12 <= table.length; i += 12) {
    entries.set(u16(table, i, little), {
      type: u16(table, i + 2, little),
      count: u32(table, i + 4, little),
      at: offset + 2 + i + 8,
    });
  }
  return entries;
}

/* --- XMP ------------------------------------------------------------------- */

/**
 * The capture time in an XMP packet, as an attribute or an element: EXIF's own
 * property first, then Photoshop's (which macOS screenshots carry), then the
 * file's creation.
 */
function xmpDate(xmp: string): string | undefined {
  for (const name of ['exif:DateTimeOriginal', 'photoshop:DateCreated', 'xmp:CreateDate']) {
    const match =
      new RegExp(`${name}\\s*=\\s*"([^"]+)"`).exec(xmp) ??
      new RegExp(`<${name}>([^<]+)</${name}>`).exec(xmp);
    const value = match?.[1]?.trim();
    if (value && parseCaptureTime(value)) return value;
  }
  return undefined;
}

/* --- bytes ------------------------------------------------------------------ */

function internationalText(data: Uint8Array): { keyword: string; text: string } | undefined {
  const [keyword, rest] = splitNul(data);
  if (rest.length < 2) return undefined;
  const compressed = rest[0] === 1;
  const [, afterLanguage] = splitNul(rest.subarray(2));
  const [, body] = splitNul(afterLanguage);
  try {
    return { keyword, text: utf8(compressed ? inflateSync(body) : body) };
  } catch {
    return undefined;
  }
}

function splitNul(data: Uint8Array): [string, Uint8Array] {
  const nul = data.indexOf(0);
  if (nul < 0) return [latin1(data), new Uint8Array(0)];
  return [latin1(data.subarray(0, nul)), data.subarray(nul + 1)];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return latin1(bytes.subarray(at, at + length));
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function u16(bytes: Uint8Array, at: number, little: boolean): number {
  if (at + 2 > bytes.length) return 0;
  return little ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!;
}

function u32(bytes: Uint8Array, at: number, little: boolean): number {
  if (at + 4 > bytes.length) return 0;
  const [a, b, c, d] = little
    ? [bytes[at + 3]!, bytes[at + 2]!, bytes[at + 1]!, bytes[at]!]
    : [bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!];
  return a * 0x1000000 + ((b << 16) | (c << 8) | d);
}

function u64(bytes: Uint8Array, at: number): number {
  return u32(bytes, at, false) * 0x1_0000_0000 + u32(bytes, at + 4, false);
}

/** A big-endian unsigned integer of 0, 2, 4 or 8 bytes, as ISO BMFF sizes its fields. */
function sized(bytes: Uint8Array, at: number, size: number): number {
  if (size === 0) return 0;
  if (size === 2) return u16(bytes, at, false);
  if (size === 4) return u32(bytes, at, false);
  if (size === 8) return u64(bytes, at);
  return 0;
}
