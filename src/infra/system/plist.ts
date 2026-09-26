export type PlistValue = string | number | boolean | Date | Buffer | PlistValue[] | { [key: string]: PlistValue };

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';

/** Serializes a value into an XML property list (exportOptions.plist etc.). */
export function buildPlist(value: PlistValue): string {
  return `${HEADER}${serialize(value, 0)}\n</plist>\n`;
}

function serialize(value: PlistValue, depth: number): string {
  const indent = '\t'.repeat(depth);
  if (typeof value === 'string') return `${indent}<string>${escapeXml(value)}</string>`;
  if (typeof value === 'boolean') return `${indent}<${value}/>`;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `${indent}<integer>${value}</integer>` : `${indent}<real>${value}</real>`;
  }
  if (value instanceof Date) return `${indent}<date>${value.toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>`;
  if (Buffer.isBuffer(value)) return `${indent}<data>${value.toString('base64')}</data>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}<array/>`;
    return `${indent}<array>\n${value.map((v) => serialize(v, depth + 1)).join('\n')}\n${indent}</array>`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return `${indent}<dict/>`;
  const body = entries
    .map(([k, v]) => `${indent}\t<key>${escapeXml(k)}</key>\n${serialize(v, depth + 1)}`)
    .join('\n');
  return `${indent}<dict>\n${body}\n${indent}</dict>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Minimal XML plist parser — enough for decoded provisioning profiles
 * (`security cms -D`) without shelling out to plutil. Binary plists are not
 * supported.
 */
export function parsePlist(xml: string): PlistValue {
  const tokens = tokenize(xml);
  let pos = tokens.findIndex((t) => t.tag === 'plist' && !t.closing);
  if (pos === -1) throw new Error('not an XML property list');
  pos++;

  const parseValue = (): PlistValue => {
    const token = tokens[pos++];
    if (!token || token.closing) throw new Error('unexpected end of plist');
    switch (token.tag) {
      case 'string':
      case 'integer':
      case 'real':
      case 'date':
      case 'data': {
        const text = token.selfClosing ? '' : readText(token.tag);
        if (token.tag === 'string') return text;
        if (token.tag === 'integer' || token.tag === 'real') return Number(text);
        if (token.tag === 'date') return new Date(text);
        return Buffer.from(text.replace(/\s+/g, ''), 'base64');
      }
      case 'true':
        return true;
      case 'false':
        return false;
      case 'array': {
        const items: PlistValue[] = [];
        if (token.selfClosing) return items;
        while (!(tokens[pos]?.tag === 'array' && tokens[pos]?.closing)) items.push(parseValue());
        pos++;
        return items;
      }
      case 'dict': {
        const dict: Record<string, PlistValue> = {};
        if (token.selfClosing) return dict;
        while (!(tokens[pos]?.tag === 'dict' && tokens[pos]?.closing)) {
          const keyToken = tokens[pos++];
          if (keyToken?.tag !== 'key') throw new Error('expected <key> in <dict>');
          dict[readText('key')] = parseValue();
        }
        pos++;
        return dict;
      }
      default:
        throw new Error(`unsupported plist element <${token.tag}>`);
    }
  };

  const readText = (tag: string): string => {
    const token = tokens[pos];
    let text = '';
    if (token?.text !== undefined) {
      text = token.text;
      pos++;
    }
    const closing = tokens[pos++];
    if (!closing || closing.tag !== tag || !closing.closing) throw new Error(`unterminated <${tag}>`);
    return unescapeXml(text);
  };

  return parseValue();
}

interface Token {
  tag?: string;
  closing?: boolean;
  selfClosing?: boolean;
  text?: string;
}

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  const re = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>|<\?[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    if (match[2]) {
      tokens.push({ tag: match[2], closing: match[1] === '/', selfClosing: match[3] === '/' });
    } else if (match[4] !== undefined) {
      // Whitespace between elements is insignificant; text inside
      // <string>/<key> is attached to the preceding open tag.
      const prev = tokens[tokens.length - 1];
      if (prev && !prev.closing && !prev.selfClosing && TEXT_TAGS.has(prev.tag ?? '')) tokens.push({ text: match[4] });
    }
  }
  return tokens;
}

const TEXT_TAGS = new Set(['string', 'key', 'integer', 'real', 'date', 'data']);
