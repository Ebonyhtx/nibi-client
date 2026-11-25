import { describe, expect, it } from "vitest";
import { buildReleaseAssetUrlCandidates } from "@nibi/server/remote/remoteAssetCdn.js";

describe("remoteAssetCdn URL encoding", () => {
  it("版本路径包含 '+' 时应编码为 %2B", () => {
    const urls = buildReleaseAssetUrlCandidates(
      ["https://cdn.example.com/nibi/electron/releases/1.3.0"],
      ["nibi-server-linux-arm64-v1.3.0+7138ea7a9b45.tar.gz"],
    );

    expect(urls).toEqual([
      "https://cdn.example.com/nibi/electron/releases/1.3.0/nibi-server-linux-arm64-v1.3.0%2B7138ea7a9b45.tar.gz",
    ]);
  });

  it("已编码路径不应重复编码", () => {
    const urls = buildReleaseAssetUrlCandidates(
      ["https://cdn.example.com/nibi/electron/releases/1.3.0"],
      ["nibi-server-linux-arm64-v1.3.0%2B7138ea7a9b45.tar.gz"],
    );

    expect(urls).toEqual([
      "https://cdn.example.com/nibi/electron/releases/1.3.0/nibi-server-linux-arm64-v1.3.0%2B7138ea7a9b45.tar.gz",
    ]);
  });

  it("拒绝越界或带反斜杠的相对路径", () => {
    expect(() =>
      buildReleaseAssetUrlCandidates(["https://cdn.example.com/releases"], ["../secret"]),
    ).toThrow();
    expect(() =>
      buildReleaseAssetUrlCandidates(["https://cdn.example.com/releases"], ["a\\b"]),
    ).toThrow();
  });
});
