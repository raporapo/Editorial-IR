import { describe, expect, it } from 'vitest';
import { toFileUrl } from '../src/index.js';
import { childText, findAll, parseXml } from '../../../tests/support/xml.js';

/**
 * The checker the adapter tests rely on, checked itself.
 *
 * A test helper that quietly accepts a broken document is worse than no helper:
 * it turns a missing check into a passing one.
 */
describe('parseXml', () => {
  it('reads a document with a declaration and a doctype', () => {
    const root = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4"><sequence id="s1"><name>trip</name></sequence></xmeml>`);
    expect(root.tag).toBe('xmeml');
    expect(root.attributes.version).toBe('4');
    expect(childText(findAll(root, 'sequence')[0]!, 'name')).toBe('trip');
  });

  it('reads a self-closing element', () => {
    const root = parseXml('<a><file id="file-1"/></a>');
    expect(findAll(root, 'file')[0]!.attributes.id).toBe('file-1');
  });

  it('rejects an unbalanced tag', () => {
    // The failure every substring assertion in this suite would miss.
    expect(() => parseXml('<a><b></a>')).toThrow(/closed by/);
  });

  it('rejects an element that is never closed', () => {
    expect(() => parseXml('<a><b>text')).toThrow(/never closed/);
  });

  it('rejects content after the root element', () => {
    expect(() => parseXml('<a/><b/>')).toThrow(/trailing content/);
  });

  it('rejects a stray "<" in text, which is what an unescaped character produces', () => {
    expect(() => parseXml('<a>2 < 3</a>')).toThrow();
  });

  it('rejects an unescaped ampersand, the one that breaks these files in practice', () => {
    // File names and event descriptions are user content and routinely contain
    // ampersands. A checker that reads "R&D" as ordinary text would let the
    // adapters' escaping be deleted without a single test noticing.
    expect(() => parseXml('<a>R&D</a>')).toThrow(/unescaped/);
    expect(() => parseXml('<a name="R&D"/>')).toThrow(/unescaped/);
  });

  it('accepts the entities that are actually escaped', () => {
    const root = parseXml('<a name="one &amp; two">&lt;tag&gt; &#39; &#x2014;</a>');
    expect(root.attributes.name).toBe('one &amp; two');
  });
});

/**
 * A path, as a URL an editor will resolve.
 *
 * Every interchange format here points at media by `file://` URL, so the file a
 * cut refers to is exactly whatever this function says. When it is wrong the
 * clip imports offline, which looks like a missing file rather than a bug here.
 */
describe('toFileUrl', () => {
  /** What an importer would actually open. */
  function opened(path: string): { host: string; path: string } {
    const url = new URL(toFileUrl(path));
    return { host: url.hostname, path: decodeURIComponent(url.pathname) };
  }

  it('survives a space', () => {
    expect(opened('/media/trip/day one.mp4').path).toBe('/media/trip/day one.mp4');
  });

  it('survives a question mark, which starts a query string if left alone', () => {
    // `encodeURI` leaves the URL delimiters be, which is right for a URL and
    // wrong for a path becoming one: this read back as `/media/what`.
    expect(opened('/media/what? really.mp4').path).toBe('/media/what? really.mp4');
  });

  it('survives the other delimiters', () => {
    expect(opened('/media/a#b.mp4').path).toBe('/media/a#b.mp4');
    expect(opened('/media/[take 2].mp4').path).toBe('/media/[take 2].mp4');
    expect(opened('/media/50%off.mp4').path).toBe('/media/50%off.mp4');
  });

  it('survives characters outside ASCII', () => {
    expect(opened('/media/日本語.mp4').path).toBe('/media/日本語.mp4');
  });

  it('writes a Windows path with its drive letter', () => {
    expect(toFileUrl('C:\\Users\\me\\clip.mp4')).toBe('file:///C:/Users/me/clip.mp4');
  });

  it('puts a UNC server in the authority, where it belongs', () => {
    // As a plain path this produced `file:////server/share/clip.mp4`: an empty
    // authority and a path starting with two slashes, which resolvers refuse.
    const url = opened('\\\\server\\share\\clip.mp4');
    expect(url.host).toBe('server');
    expect(url.path).toBe('/share/clip.mp4');
  });
});
