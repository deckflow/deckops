import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from 'saxes';
import { DeckParseError } from '../errors/index.js';
import type { LocalLimits } from './limits.js';

export interface XmlNode {
  local: string;
  uri: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}
/** Bounded namespace-aware SAX parse into a deliberately tiny tree. */
export function parseXml(data: Uint8Array | string, limits: LocalLimits, part: string): XmlNode {
  const xml = typeof data === 'string' ? data : new TextDecoder().decode(data);
  if (/<!DOCTYPE\b/i.test(xml) || /<!ENTITY\b/i.test(xml)) {
    throw DeckParseError.input(`${part} contains a forbidden DTD or entity declaration.`);
  }
  const root: XmlNode = { local: '#document', uri: '', attributes: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let events = 0;
  let textBytes = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag: SaxesTagNS) => {
    guardEvent();
    if (stack.length > limits.xmlDepth) throw DeckParseError.input(`${part} exceeds the XML depth limit.`);
    const attrs: Record<string, string> = {};
    const values = Object.values(tag.attributes) as SaxesAttributeNS[];
    if (values.length > limits.xmlAttributes) throw DeckParseError.input(`${part} has too many attributes on one element.`);
    for (const attr of values) {
      attrs[attr.name] = attr.value;
      attrs[attr.local] ??= attr.value;
    }
    const node: XmlNode = { local: tag.local, uri: tag.uri, attributes: attrs, children: [], text: '' };
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on('text', (text: string) => {
    guardEvent();
    textBytes += Buffer.byteLength(text);
    if (textBytes > limits.xmlTextBytes) throw DeckParseError.input(`${part} exceeds the XML text limit.`);
    stack.at(-1)!.text += text;
  });
  parser.on('cdata', (text: string) => {
    guardEvent();
    textBytes += Buffer.byteLength(text);
    if (textBytes > limits.xmlTextBytes) throw DeckParseError.input(`${part} exceeds the XML text limit.`);
    stack.at(-1)!.text += text;
  });
  parser.on('closetag', () => {
    guardEvent();
    stack.pop();
  });
  parser.on('error', (error: Error) => {
    throw DeckParseError.input(`${part} is not valid XML: ${error.message}`, { cause: error });
  });
  parser.write(xml).close();
  return root;

  function guardEvent(): void {
    events += 1;
    if (events > limits.xmlEvents) throw DeckParseError.input(`${part} exceeds the XML event limit.`);
  }
}

export function children(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter((child) => child.local === local);
}

export function descendants(node: XmlNode, local: string): XmlNode[] {
  const found: XmlNode[] = [];
  const visit = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.local === local) found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
}

export function first(node: XmlNode, local: string): XmlNode | undefined {
  return node.children.find((child) => child.local === local);
}

export function textContent(node: XmlNode): string {
  return `${node.text}${node.children.map(textContent).join('')}`;
}
