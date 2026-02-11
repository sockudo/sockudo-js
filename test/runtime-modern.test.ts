import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("node runtime modern surface", () => {
  it("uses native WebSocket and fetch-first APIs", () => {
    const runtimeSource = readFileSync(
      join(import.meta.dir, "..", "src", "runtimes", "node", "runtime.ts"),
      "utf8",
    );

    expect(runtimeSource).toContain("globalThis.WebSocket");
    expect(runtimeSource).toContain("isXHRSupported(): boolean");
    expect(runtimeSource).toContain("return false;");
    expect(runtimeSource).toContain("createXHR()");
    expect(runtimeSource).toContain("fetchAuth");
    expect(runtimeSource).toContain("fetchTimeline");
    expect(runtimeSource.includes("faye-websocket")).toBeFalse();
  });
});

describe("web runtime modern surface", () => {
  it("uses fetch auth and websocket-first strategy without legacy fallbacks", () => {
    const webRuntimeSource = readFileSync(
      join(import.meta.dir, "..", "src", "runtimes", "web", "runtime.ts"),
      "utf8",
    );
    const webStrategySource = readFileSync(
      join(
        import.meta.dir,
        "..",
        "src",
        "runtimes",
        "web",
        "default_strategy.ts",
      ),
      "utf8",
    );

    expect(webRuntimeSource).toContain("fetchAuth");
    expect(webRuntimeSource).toContain("fetchTimeline");
    expect(webRuntimeSource.includes("jsonpAuth")).toBeFalse();
    expect(webRuntimeSource.includes("xhrAuth")).toBeFalse();

    expect(webStrategySource.includes("sockjs")).toBeFalse();
    expect(webStrategySource.includes("xhr_streaming")).toBeFalse();
    expect(webStrategySource.includes("xhr_polling")).toBeFalse();
    expect(webStrategySource.includes("xdr_streaming")).toBeFalse();
    expect(webStrategySource.includes("xdr_polling")).toBeFalse();
  });
});
