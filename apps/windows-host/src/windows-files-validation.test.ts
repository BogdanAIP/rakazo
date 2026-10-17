import { describe, expect, it } from "vitest";
import { isSingleLinkRegularFile } from "./windows-files.js";

describe("Windows Host file-handle single-link guard", () => {
  it("accepts regular files with precisely one link in number and BigInt stats modes", () => {
    expect(isSingleLinkRegularFile({ isFile: () => true, nlink: 1 })).toBe(true);
    expect(isSingleLinkRegularFile({ isFile: () => true, nlink: 1n })).toBe(true);
  });

  it("rejects hard-linked and unlinked files in both stats modes", () => {
    for (const nlink of [0, 0n, 2, 2n]) {
      expect(isSingleLinkRegularFile({ isFile: () => true, nlink })).toBe(false);
    }
  });

  it("rejects directories even with one link", () => {
    expect(isSingleLinkRegularFile({ isFile: () => false, nlink: 1n })).toBe(false);
  });
});
