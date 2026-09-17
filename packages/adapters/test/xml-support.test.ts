import { describe, expect, it } from 'vitest';
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
