/**
 * A small XML writer: enough for ISO 20022 messages, where element order is
 * fixed by the schema and every value is text. Optional elements are written
 * as `undefined` and dropped, so a builder reads like the schema it follows.
 */
export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly (XmlElement | string)[];
}

type Child = XmlElement | string | undefined | false | readonly Child[];

function flatten(children: readonly Child[]): (XmlElement | string)[] {
  const out: (XmlElement | string)[] = [];
  for (const child of children) {
    if (child === undefined || child === false) continue;
    if (Array.isArray(child)) out.push(...flatten(child));
    else out.push(child as XmlElement | string);
  }
  return out;
}

/** An element; `attrs` may be omitted. Undefined children are dropped. */
export function el(name: string, ...rest: Child[] | [Readonly<Record<string, string>>, ...Child[]]): XmlElement {
  const [first, ...others] = rest;
  const hasAttrs =
    first !== undefined && typeof first === "object" && !Array.isArray(first) && !("name" in (first as object));
  return {
    name,
    attrs: hasAttrs ? (first as Record<string, string>) : {},
    children: flatten((hasAttrs ? others : rest) as Child[]),
  };
}

/** An element holding text, or nothing at all when the value is undefined. */
export function text(name: string, value: string | undefined, attrs: Record<string, string> = {}): XmlElement | undefined {
  return value === undefined ? undefined : { name, attrs, children: [value] };
}

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function render(node: XmlElement, depth: number): string {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${escape(v)}"`)
    .join("");
  if (node.children.length === 0) return `${pad}<${node.name}${attrs}/>`;
  if (node.children.every((c) => typeof c === "string")) {
    return `${pad}<${node.name}${attrs}>${escape(node.children.join(""))}</${node.name}>`;
  }
  const inner = node.children.map((c) => (typeof c === "string" ? `${pad}  ${escape(c)}` : render(c, depth + 1)));
  return `${pad}<${node.name}${attrs}>\n${inner.join("\n")}\n${pad}</${node.name}>`;
}

/** The document as UTF-8 XML text, with a declaration, two-space indents, and a final newline. */
export function toXml(root: XmlElement): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${render(root, 0)}\n`;
}
