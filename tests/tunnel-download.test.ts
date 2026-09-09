import { describe, expect, it } from "vitest";
import { CLOUDFLARED_RELEASE, getCloudflaredAsset } from "../src/tunnel/download.js";

describe("cloudflared runtime selection", () => {
  it("maps the supported platforms to pinned official assets", () => {
    expect(CLOUDFLARED_RELEASE).toBe("2026.8.3");
    expect(getCloudflaredAsset("darwin", "arm64").archiveName).toBe("cloudflared-darwin-arm64.tgz");
    expect(getCloudflaredAsset("darwin", "x64").archiveName).toBe("cloudflared-darwin-amd64.tgz");
    expect(getCloudflaredAsset("linux", "x64").archiveName).toBe("cloudflared-linux-amd64");
    expect(getCloudflaredAsset("linux", "arm64").archiveName).toBe("cloudflared-linux-arm64");
    expect(getCloudflaredAsset("win32", "x64").binaryName).toBe("cloudflared.exe");
  });

  it("rejects unsupported platforms instead of guessing an asset", () => {
    expect(() => getCloudflaredAsset("freebsd", "x64")).toThrow("not supported");
    expect(() => getCloudflaredAsset("linux", "arm")).toThrow("not supported");
  });
});
