import { describe, expect, it } from "vitest";

import { buildVertexSource } from "../src/shader/sources.js";

const prelude = "uniform mat4 u_projection_matrix;\nvec4 projectTile(vec2 p);";

describe("buildVertexSource", () => {
  it("reconstructs relative-to-centre positions under mercator", () => {
    const source = buildVertexSource({
      variantName: "mercator",
      vertexShaderPrelude: prelude,
      define: "#define PROJECTION_MERCATOR",
    });
    expect(source).toContain("uniform vec2 u_origin_high;");
    expect(source).toContain("uniform vec2 u_origin_low;");
    expect(source).toContain(
      "(a_pos_high - u_origin_high) + (a_pos_low - u_origin_low)",
    );
    expect(source).toContain("projectTile(rel)");
    expect(source).toContain("#define PROJECTION_MERCATOR");
  });

  it("feeds absolute positions to projectTile under globe", () => {
    const source = buildVertexSource({
      variantName: "globe",
      vertexShaderPrelude: prelude,
      define: "#define GLOBE",
    });
    // The globe prelude's sphere mapping is non-linear, so there is no origin
    // to fold into the matrix: positions go in whole.
    expect(source).toContain("projectTile(a_pos_high + a_pos_low)");
    expect(source).not.toContain("u_origin");
    expect(source).toContain("#define GLOBE");
  });

  it("refuses a variant it has no shader for", () => {
    expect(() =>
      buildVertexSource({
        variantName: "vertical-perspective",
        vertexShaderPrelude: prelude,
        define: "",
      }),
    ).toThrow(/vertical-perspective/);
  });
});
