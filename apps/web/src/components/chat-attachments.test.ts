import { describe, expect, it, vi } from "vitest";
import { api, type Attachment } from "../api";
import { isPreviewableImage, uploadFiles } from "./chat-attachments";

describe("chat attachment previews", () => {
  it("allows browser-friendly image formats and gracefully excludes HEIC", () => {
    expect(isPreviewableImage("image/jpeg")).toBe(true);
    expect(isPreviewableImage("IMAGE/WEBP")).toBe(true);
    expect(isPreviewableImage("image/heic")).toBe(false);
    expect(isPreviewableImage("image/heif")).toBe(false);
    expect(isPreviewableImage("application/pdf")).toBe(false);
  });
});

describe("chat attachment upload limits", () => {
  it("caps a batch at eight attachments", async () => {
    const upload = vi.spyOn(api, "upload").mockImplementation(async (file) => ({ id: `att_${file.name}`, name: file.name, mimeType: file.type, size: file.size }));
    const updates: Attachment[][] = [];
    const errors: string[] = [];
    await uploadFiles(Array.from({ length: 9 }, (_, index) => new File(["x"], `${index}.txt`, { type: "text/plain" })), [], (update) => updates.push(typeof update === "function" ? update(updates.at(-1) ?? []) : update), (message) => errors.push(message));
    expect(upload).toHaveBeenCalledTimes(8);
    expect(updates.at(-1)).toHaveLength(8);
    expect(errors).toContain("You can attach up to 8 files.");
    upload.mockRestore();
  });

  it("rejects an individual file over 10 MiB without uploading it", async () => {
    const upload = vi.spyOn(api, "upload").mockResolvedValue({ id: "att_large", name: "large.bin", mimeType: "application/octet-stream", size: 10 * 1024 * 1024 + 1 });
    const errors: string[] = [];
    await uploadFiles([new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.bin")], [], () => undefined, (message) => errors.push(message));
    expect(upload).not.toHaveBeenCalled();
    expect(errors[0]).toContain("larger than 10 MiB");
    upload.mockRestore();
  });

  it("keeps the combined message size under 20 MiB", async () => {
    const upload = vi.spyOn(api, "upload").mockImplementation(async (file) => ({ id: `att_${file.name}`, name: file.name, mimeType: file.type, size: file.size }));
    const errors: string[] = [];
    await uploadFiles([new File([new Uint8Array(10 * 1024 * 1024)], "one.bin"), new File([new Uint8Array(10 * 1024 * 1024)], "two.bin"), new File([new Uint8Array(1)], "three.bin")], [], () => undefined, (message) => errors.push(message));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(errors).toContain("Attachments must total 20 MiB or less.");
    upload.mockRestore();
  });
});
