import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("esm-only packaging", () => {
  it("does not expose CommonJS export paths", () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as Record<string, any>;

    expect(packageJson.type).toBe("module");
    expect(packageJson.main).toBe("dist/node/pusher.js");
    expect(packageJson.browser).toBe("dist/web/pusher.mjs");
    expect(packageJson["react-native"]).toBe("dist/react-native/pusher.js");
    expect(JSON.stringify(packageJson.exports).includes(".cjs")).toBeFalse();
    expect(
      JSON.stringify(packageJson.exports).includes('"require"'),
    ).toBeFalse();
  });
});
