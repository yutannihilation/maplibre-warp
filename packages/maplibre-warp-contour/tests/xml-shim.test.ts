import { describe, expect, it } from "vitest";

import { installDOMParserShim, MiniDOMParser } from "../src/xml-shim.js";

const GDAL_METADATA = `<GDALMetadata>
  <Item name="STATISTICS_MAXIMUM" sample="0">2711.4</Item>
  <Item name="STATISTICS_MINIMUM" sample="0">612.05</Item>
  <Item name="UNITTYPE" sample="0" role="unittype">m</Item>
  <Item name="AREA_OR_POINT">Area</Item>
  <Item name="DESCRIPTION" sample="0" role="description">a &lt;b&gt; &amp; c</Item>
</GDALMetadata>`;

describe("MiniDOMParser", () => {
  it("exposes the root element name", () => {
    const doc = new MiniDOMParser().parseFromString(GDAL_METADATA, "text/xml");
    expect(doc.documentElement.tagName).toBe("GDALMetadata");
  });

  it("finds Item elements with their attributes and text", () => {
    const doc = new MiniDOMParser().parseFromString(GDAL_METADATA, "text/xml");
    const items = Array.from(doc.documentElement.querySelectorAll("Item"));
    expect(items).toHaveLength(5);
    expect(items[0]!.getAttribute("name")).toBe("STATISTICS_MAXIMUM");
    expect(items[0]!.getAttribute("sample")).toBe("0");
    expect(items[0]!.getAttribute("role")).toBeNull();
    expect(items[0]!.textContent).toBe("2711.4");
    expect(items[2]!.getAttribute("role")).toBe("unittype");
    expect(items[3]!.getAttribute("sample")).toBeNull();
  });

  it("decodes XML entities in text and attributes", () => {
    const doc = new MiniDOMParser().parseFromString(
      `<GDALMetadata><Item name="x &amp; y">1 &lt; 2 &quot;q&quot; &apos;a&apos; &#65;&#x42;</Item></GDALMetadata>`,
      "text/xml",
    );
    const [item] = Array.from(doc.documentElement.querySelectorAll("Item"));
    expect(item!.getAttribute("name")).toBe("x & y");
    expect(item!.textContent).toBe(`1 < 2 "q" 'a' AB`);
  });

  it("handles a declaration, comments and self-closing items", () => {
    const doc = new MiniDOMParser().parseFromString(
      `<?xml version="1.0"?><!-- c --><GDALMetadata><Item name="e"/><Item name="f"></Item></GDALMetadata>`,
      "text/xml",
    );
    const items = Array.from(doc.documentElement.querySelectorAll("Item"));
    expect(items.map((i) => i.getAttribute("name"))).toEqual(["e", "f"]);
    expect(items[0]!.textContent).toBe("");
  });

  it("only answers the selectors the metadata parser uses", () => {
    const doc = new MiniDOMParser().parseFromString(GDAL_METADATA, "text/xml");
    expect(() => doc.documentElement.querySelectorAll("Item > b")).toThrow();
    expect(() =>
      new MiniDOMParser().parseFromString("<a/>", "text/html"),
    ).toThrow();
  });
});

describe("installDOMParserShim", () => {
  it("installs only when DOMParser is missing and reports what it did", () => {
    const empty: Record<string, unknown> = {};
    expect(installDOMParserShim(empty)).toBe(true);
    expect(empty.DOMParser).toBe(MiniDOMParser);
    const native = { DOMParser: class {} };
    expect(installDOMParserShim(native)).toBe(false);
    expect(native.DOMParser).not.toBe(MiniDOMParser);
  });
});
