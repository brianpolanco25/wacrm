import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMediaMessage, uploadMedia } from "./meta-api";

// Capture the JSON body each helper POSTs to Meta so we can assert the
// exact payload shape per media kind without hitting the network.
interface CapturedBody {
  type?: string;
  image?: Record<string, unknown>;
  video?: Record<string, unknown>;
  document?: Record<string, unknown>;
  audio?: Record<string, unknown>;
}
let captured: CapturedBody | null = null;

function okFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    captured = init?.body ? (JSON.parse(init.body as string) as CapturedBody) : null;
    return {
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.TEST" }] }),
    } as Response;
  });
}

const BASE = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  to: "1234567890",
  link: "https://cdn.example.com/file",
} as const;

describe("sendMediaMessage — payload shape", () => {
  beforeEach(() => {
    captured = null;
    vi.stubGlobal("fetch", okFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends image with a caption and no filename", async () => {
    await sendMediaMessage({ ...BASE, kind: "image", caption: "hello", filename: "x.png" });
    expect(captured?.type).toBe("image");
    expect(captured?.image).toEqual({ link: BASE.link, caption: "hello" });
    expect(captured?.image?.filename).toBeUndefined();
  });

  it("sends document with both caption and filename", async () => {
    await sendMediaMessage({
      ...BASE,
      kind: "document",
      caption: "invoice",
      filename: "invoice.pdf",
    });
    expect(captured?.type).toBe("document");
    expect(captured?.document).toEqual({
      link: BASE.link,
      caption: "invoice",
      filename: "invoice.pdf",
    });
  });

  it("sends audio with NO caption and NO filename (Meta rejects both)", async () => {
    await sendMediaMessage({
      ...BASE,
      kind: "audio",
      caption: "should be dropped",
      filename: "voice.ogg",
    });
    expect(captured?.type).toBe("audio");
    expect(captured?.audio).toEqual({ link: BASE.link });
  });

  it("throws when neither a link nor a media id is provided", async () => {
    await expect(
      sendMediaMessage({ ...BASE, link: "", kind: "image" }),
    ).rejects.toThrow(/requires a link or a mediaId/);
  });

  it("sends by media id when one is given, and the id wins over a link", async () => {
    await sendMediaMessage({
      ...BASE,
      kind: "document",
      mediaId: "MEDIA-77",
      caption: "invoice",
      filename: "invoice.pdf",
    });
    expect(captured?.type).toBe("document");
    expect(captured?.document).toEqual({
      id: "MEDIA-77",
      caption: "invoice",
      filename: "invoice.pdf",
    });
    expect(captured?.document?.link).toBeUndefined();
  });

  it("sends audio by media id with no caption or filename", async () => {
    await sendMediaMessage({ ...BASE, link: undefined, kind: "audio", mediaId: "MEDIA-9" });
    expect(captured?.audio).toEqual({ id: "MEDIA-9" });
  });
});

describe("uploadMedia — POST /{phone_number_id}/media", () => {
  let capturedUrl: string | null = null;
  let capturedInit: RequestInit | undefined;

  beforeEach(() => {
    capturedUrl = null;
    capturedInit = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return { ok: true, json: async () => ({ id: "MEDIA-123" }) } as Response;
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts multipart form data with messaging_product, type and the file, bearer-authed", async () => {
    const bytes = new TextEncoder().encode("PNGDATA");
    const { mediaId } = await uploadMedia({
      phoneNumberId: "pn-1",
      accessToken: "tok",
      bytes,
      mimeType: "image/png",
      fileName: "photo.png",
    });

    expect(mediaId).toBe("MEDIA-123");
    expect(capturedUrl).toBe("https://graph.facebook.com/v21.0/pn-1/media");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
    // No hand-set Content-Type: fetch must derive the multipart boundary.
    expect((capturedInit?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();

    const form = capturedInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect(form.get("type")).toBe("image/png");
    const file = form.get("file") as File;
    expect(file.name).toBe("photo.png");
    expect(file.type).toBe("image/png");
    expect(await file.text()).toBe("PNGDATA");
  });

  it("surfaces Meta's error message on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "(#100) Unsupported file type" } }),
      })) as unknown as typeof fetch,
    );
    await expect(
      uploadMedia({
        phoneNumberId: "pn-1",
        accessToken: "tok",
        bytes: new Uint8Array([1]),
        mimeType: "image/bmp",
        fileName: "x.bmp",
      }),
    ).rejects.toThrow(/Unsupported file type/);
  });

  it("throws when Meta answers without an id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch,
    );
    await expect(
      uploadMedia({
        phoneNumberId: "pn-1",
        accessToken: "tok",
        bytes: new Uint8Array([1]),
        mimeType: "image/png",
        fileName: "x.png",
      }),
    ).rejects.toThrow(/did not return an id/);
  });
});
