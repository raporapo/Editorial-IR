/**
 * Just enough XML to check that what an adapter wrote is a document.
 *
 * The adapter tests assert on substrings, which means an unbalanced tag, a
 * stray `<`, or a `continue` in the wrong branch produces a file that passes
 * every one of them and that Premiere refuses to open. Parsing is the only
 * check that catches that, and the interchange file is the last artefact in the
 * whole pipeline: everything upstream is worthless if it will not import.
 *
 * Deliberately not a dependency. This handles exactly what these adapters emit —
 * a declaration, a doctype, elements, attributes and text — and throws on
 * anything it does not understand rather than guessing, which is the right
 * behaviour for a checker. It is not an XML parser and must not grow into one.
 */
export interface XmlNode {
  tag: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const NAME = /[A-Za-z_][\w.:-]*/y;
const ATTRIBUTE = /\s*([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/y;

/**
 * An `&` that does not begin a recognised entity reference.
 *
 * Checked rather than shrugged at, because this is the exact failure the
 * adapters' escaping exists to prevent — "one unescaped ampersand makes the
 * whole file unopenable" — and a checker that reads `R&D` as text would let the
 * escaping be deleted without a single test noticing. It is also the commonest
 * one: file names and event descriptions are user content.
 */
const LOOSE_AMPERSAND = /&(?!(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9A-Fa-f]+);)/;

function rejectLooseAmpersand(value: string, where: string): void {
  const at = value.search(LOOSE_AMPERSAND);
  if (at !== -1) {
    throw new Error(`unescaped "&" in ${where}: ${JSON.stringify(value.slice(at, at + 24))}`);
  }
}

export function parseXml(source: string): XmlNode {
  let at = 0;

  const skipTrivia = (): void => {
    for (;;) {
      const before = at;
      while (at < source.length && /\s/.test(source[at]!)) at++;
      if (source.startsWith('<?', at)) at = closeOf('?>');
      else if (source.startsWith('<!--', at)) at = closeOf('-->');
      else if (source.startsWith('<!', at)) at = closeOf('>');
      if (at === before) return;
    }
  };

  const closeOf = (terminator: string): number => {
    const end = source.indexOf(terminator, at);
    if (end === -1) throw new Error(`unterminated ${terminator} at ${at}`);
    return end + terminator.length;
  };

  const readName = (): string => {
    NAME.lastIndex = at;
    const match = NAME.exec(source);
    if (!match) throw new Error(`expected a tag name at ${at}: ${context(source, at)}`);
    at = NAME.lastIndex;
    return match[0];
  };

  const readElement = (): XmlNode => {
    if (source[at] !== '<') throw new Error(`expected "<" at ${at}: ${context(source, at)}`);
    at++;
    const tag = readName();
    const attributes: Record<string, string> = {};

    for (;;) {
      ATTRIBUTE.lastIndex = at;
      const match = ATTRIBUTE.exec(source);
      if (!match) break;
      rejectLooseAmpersand(match[2]!, `the ${match[1]!} attribute of <${tag}>`);
      attributes[match[1]!] = match[2]!;
      at = ATTRIBUTE.lastIndex;
    }

    while (at < source.length && /\s/.test(source[at]!)) at++;

    if (source.startsWith('/>', at)) {
      at += 2;
      return { tag, attributes, children: [], text: '' };
    }
    if (source[at] !== '>') throw new Error(`unclosed <${tag}> at ${at}: ${context(source, at)}`);
    at++;

    const children: XmlNode[] = [];
    let text = '';
    for (;;) {
      const nextTag = source.indexOf('<', at);
      if (nextTag === -1) throw new Error(`<${tag}> is never closed`);
      text += source.slice(at, nextTag);
      at = nextTag;

      if (source.startsWith('</', at)) {
        at += 2;
        const closing = readName();
        if (closing !== tag) throw new Error(`<${tag}> closed by </${closing}>`);
        while (at < source.length && /\s/.test(source[at]!)) at++;
        if (source[at] !== '>') throw new Error(`unclosed </${tag}> at ${at}`);
        at++;
        rejectLooseAmpersand(text, `the text of <${tag}>`);
        return { tag, attributes, children, text: text.trim() };
      }
      if (source.startsWith('<!--', at)) {
        at = closeOf('-->');
        continue;
      }
      children.push(readElement());
      while (at < source.length && /\s/.test(source[at]!)) at++;
    }
  };

  skipTrivia();
  const root = readElement();
  skipTrivia();
  if (at < source.length) throw new Error(`trailing content after the root element at ${at}`);
  return root;
}

/** Every element with this tag, at any depth. */
export function findAll(node: XmlNode, tag: string): XmlNode[] {
  const found: XmlNode[] = [];
  const walk = (current: XmlNode): void => {
    if (current.tag === tag) found.push(current);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return found;
}

/** The text of the first child with this tag. */
export function childText(node: XmlNode, tag: string): string | undefined {
  return node.children.find((child) => child.tag === tag)?.text;
}

function context(source: string, at: number): string {
  return JSON.stringify(source.slice(Math.max(0, at - 20), at + 20));
}
