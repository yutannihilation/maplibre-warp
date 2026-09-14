/**
 * A `DOMParser` stand-in for workers, covering exactly what
 * `@developmentseed/geotiff` needs to read the `GDAL_METADATA` tag: the root
 * element's name, `querySelectorAll("Item")`, `getAttribute` and
 * `textContent`. Workers have no DOM, and the library parses that tag eagerly
 * when a file is opened, so without this most DEMs cannot be opened off the
 * main thread.
 *
 * The parser is deliberately narrow: GDAL writes a flat
 * `<GDALMetadata><Item …>text</Item>…</GDALMetadata>` document, and anything
 * beyond that (nested elements, CDATA, namespaces) is not needed. Selectors
 * other than a bare element name throw rather than answer wrongly.
 */

export class MiniElement {
  readonly tagName: string;
  readonly textContent: string;
  private readonly attributes: ReadonlyMap<string, string>;
  private readonly childElements: MiniElement[];

  constructor(
    tagName: string,
    attributes: ReadonlyMap<string, string>,
    textContent: string,
    children: MiniElement[],
  ) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.textContent = textContent;
    this.childElements = children;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  /** Descendants named `selector`; only bare element names are supported. */
  querySelectorAll(selector: string): MiniElement[] {
    if (!/^[A-Za-z_][\w.-]*$/.test(selector)) {
      throw new Error(
        `MiniDOMParser supports element-name selectors only, got "${selector}"`,
      );
    }
    const out: MiniElement[] = [];
    const visit = (element: MiniElement): void => {
      for (const child of element.childElements) {
        if (child.tagName === selector) {
          out.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

export interface MiniDocument {
  documentElement: MiniElement;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (match, body: string) => {
    if (body.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return ENTITIES[body] ?? match;
  });
}

const TOKEN =
  /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export class MiniDOMParser {
  parseFromString(text: string, type: string): MiniDocument {
    if (type !== "text/xml" && type !== "application/xml") {
      throw new Error(`MiniDOMParser only parses XML, got "${type}"`);
    }
    interface Open {
      tagName: string;
      attributes: Map<string, string>;
      text: string;
      children: MiniElement[];
    }
    const stack: Open[] = [];
    let root: MiniElement | undefined;

    const close = (): void => {
      const open = stack.pop()!;
      const element = new MiniElement(
        open.tagName,
        open.attributes,
        decodeEntities(open.text),
        open.children,
      );
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(element);
      } else if (root) {
        throw new Error("XML document has more than one root element");
      } else {
        root = element;
      }
    };

    for (const match of text.matchAll(TOKEN)) {
      const [, closing, opening, attributeText, selfClosing, textRun] = match;
      if (closing !== undefined) {
        const open = stack[stack.length - 1];
        if (!open || open.tagName !== closing) {
          throw new Error(`unexpected closing tag </${closing}>`);
        }
        close();
      } else if (opening !== undefined) {
        const attributes = new Map<string, string>();
        for (const [, name, dq, sq] of (attributeText ?? "").matchAll(
          ATTRIBUTE,
        )) {
          attributes.set(name!, decodeEntities(dq ?? sq ?? ""));
        }
        stack.push({ tagName: opening, attributes, text: "", children: [] });
        if (selfClosing) {
          close();
        }
      } else if (textRun !== undefined) {
        const open = stack[stack.length - 1];
        if (open) {
          open.text += textRun;
        } else if (textRun.trim() !== "") {
          throw new Error("text outside the root element");
        }
      }
    }
    if (stack.length > 0) {
      throw new Error(`unclosed element <${stack[stack.length - 1]!.tagName}>`);
    }
    if (!root) {
      throw new Error("XML document has no root element");
    }
    return { documentElement: root };
  }
}

/**
 * Define `DOMParser` on `scope` when it has none. Returns whether it did.
 * Meant for the worker global; never touches a scope that has the real thing.
 */
export function installDOMParserShim(scope: Record<string, unknown>): boolean {
  if (typeof scope.DOMParser !== "undefined") {
    return false;
  }
  scope.DOMParser = MiniDOMParser;
  return true;
}
