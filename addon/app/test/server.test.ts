import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../src/config.js";
import { createApp, RenderState } from "../src/server.js";
import type { Renderer, RenderResult } from "../src/renderer.js";
import { decodePng, encodeGrayPng, rotate, type GrayImage } from "../src/image.js";

/** A 3x2 frame (black top-left, white elsewhere) and its encoding at the default rotation (90 -> 2x3). */
const FRAME: GrayImage = { width: 3, height: 2, data: new Uint8Array([0, 255, 255, 255, 255, 255]) };

function fakeRenderer(opts: { fail?: boolean } = {}): Renderer & { calls: number; fail: boolean } {
  const rotated = rotate(FRAME, 90);
  const png = encodeGrayPng(rotated);
  const r = {
    calls: 0,
    fail: opts.fail ?? false,
    render(): Promise<RenderResult> {
      r.calls += 1;
      if (r.fail) return Promise.reject(new Error("boom"));
      return Promise.resolve({
        png,
        width: rotated.width,
        height: rotated.height,
        image: FRAME,
        renderedAt: new Date("2026-10-08T12:00:00Z"),
        durationMs: 5,
      });
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  return r;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("HTTP server", () => {
  let server: Server;
  let base: string;
  afterEach(() => {
    server.close();
  });

  describe("without token", () => {
    let renderer: ReturnType<typeof fakeRenderer>;
    beforeEach(async () => {
      renderer = fakeRenderer();
      const cfg = buildConfig({}, {});
      const app = createApp(new RenderState(renderer, cfg), cfg);
      server = createServer((req, res) => void app(req, res));
      base = await listen(server);
    });

    it("serves health", async () => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    });

    it("renders on first image request, then caches with ETag", async () => {
      const res = await fetch(`${base}/kindle.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-image-size")).toBe("2x3");
      expect(res.headers.get("x-image-rotation")).toBe("90");
      const etag = res.headers.get("etag");
      expect(etag).toBeTruthy();
      expect(renderer.calls).toBe(1);

      const again = await fetch(`${base}/kindle.png`, { headers: { "If-None-Match": etag ?? "" } });
      expect(again.status).toBe(304);
      expect(renderer.calls).toBe(1);

      const fresh = await fetch(`${base}/kindle.png?render=1`);
      expect(fresh.status).toBe(200);
      expect(renderer.calls).toBe(2);
    });

    it("serves the frame counter-rotated for the reported framebuffer rotation, cached per rotation", async () => {
      const upright = await fetch(`${base}/kindle.png?fb_rotate=0`);
      expect(upright.status).toBe(200);
      expect(upright.headers.get("x-image-rotation")).toBe("90");
      const baseEtag = upright.headers.get("etag");

      // Framebuffer upside down (rota=2): the 90 degree frame is served at 270, i.e. flipped by 180.
      const flipped = await fetch(`${base}/kindle.png?fb_rotate=2`);
      expect(flipped.status).toBe(200);
      expect(flipped.headers.get("x-image-rotation")).toBe("270");
      expect(flipped.headers.get("x-image-size")).toBe("2x3");
      expect(flipped.headers.get("etag")).not.toBe(baseEtag);
      const decoded = decodePng(Buffer.from(await flipped.arrayBuffer()));
      // pngjs expands grayscale to RGBA: read the red channel.
      const pixels = Array.from({ length: 6 }, (_, i) => decoded.data[i * 4]);
      expect(pixels).toEqual(Array.from(rotate(FRAME, 270).data));
      expect(renderer.calls).toBe(1);

      const again = await fetch(`${base}/kindle.png?fb_rotate=2`, {
        headers: { "If-None-Match": flipped.headers.get("etag") ?? "" },
      });
      expect(again.status).toBe(304);

      // Landscape framebuffer (rota=1): base 90 - 90 = 0, the unrotated 3x2 frame.
      const landscape = await fetch(`${base}/kindle.png?fb_rotate=1`);
      expect(landscape.headers.get("x-image-rotation")).toBe("0");
      expect(landscape.headers.get("x-image-size")).toBe("3x2");
      expect(renderer.calls).toBe(1);

      expect((await fetch(`${base}/kindle.png?fb_rotate=4`)).status).toBe(400);
      expect((await fetch(`${base}/kindle.png?fb_rotate=abc`)).status).toBe(400);
    });

    it("POST /render triggers a render and reports status", async () => {
      const res = await fetch(`${base}/render`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { render_count: number; last_render: string; rotation: number };
      expect(body.render_count).toBe(1);
      expect(body.last_render).toBe("2026-10-08T12:00:00.000Z");
      expect(body.rotation).toBe(90);
    });

    it("unknown paths are 404", async () => {
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    });
  });

  describe("/last-error.png", () => {
    it("is 404 until a failed render was captured, then serves the file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "kindledash-"));
      const file = join(dir, "last-error.png");
      const cfg = buildConfig({}, { KD_ERROR_SCREENSHOT: file });
      const app = createApp(new RenderState(fakeRenderer(), cfg), cfg);
      server = createServer((req, res) => void app(req, res));
      base = await listen(server);

      expect((await fetch(`${base}/last-error.png`)).status).toBe(404);

      const png = encodeGrayPng({ width: 1, height: 1, data: new Uint8Array([0]) });
      await writeFile(file, png);
      const res = await fetch(`${base}/last-error.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
      await rm(dir, { recursive: true, force: true });
    });
  });

  it("returns 503 when the first render fails and the stale image afterwards", async () => {
    const renderer = fakeRenderer({ fail: true });
    const cfg = buildConfig({}, {});
    const state = new RenderState(renderer, cfg);
    const app = createApp(state, cfg);
    server = createServer((req, res) => void app(req, res));
    base = await listen(server);
    const res = await fetch(`${base}/kindle.png`);
    expect(res.status).toBe(503);
    const status = (await (await fetch(`${base}/status`)).json()) as { ok: boolean; last_error: string; error_count: number };
    expect(status.ok).toBe(false);
    expect(status.last_error).toBe("boom");
    expect(status.error_count).toBe(1);
  });

  it("counts consecutive failures and resets the count on success", async () => {
    const renderer = fakeRenderer({ fail: true });
    const cfg = buildConfig({}, {});
    const state = new RenderState(renderer, cfg);
    const app = createApp(state, cfg);
    server = createServer((req, res) => void app(req, res));
    base = await listen(server);
    const read = async () =>
      (await (await fetch(`${base}/status`)).json()) as { error_count: number; consecutive_errors: number; ok: boolean };
    expect((await read()).consecutive_errors).toBe(0);
    await fetch(`${base}/render`, { method: "POST" });
    await fetch(`${base}/render`, { method: "POST" });
    expect(await read()).toMatchObject({ error_count: 2, consecutive_errors: 2, ok: false });
    renderer.fail = false;
    await fetch(`${base}/render`, { method: "POST" });
    expect(await read()).toMatchObject({ error_count: 2, consecutive_errors: 0, ok: true });
    renderer.fail = true;
    await fetch(`${base}/render`, { method: "POST" });
    expect(await read()).toMatchObject({ error_count: 3, consecutive_errors: 1, ok: false });
  });

  describe("with server token", () => {
    beforeEach(async () => {
      const cfg = buildConfig({ server_token: "s3cret" }, {});
      const app = createApp(new RenderState(fakeRenderer(), cfg), cfg);
      server = createServer((req, res) => void app(req, res));
      base = await listen(server);
    });

    it("rejects missing or wrong tokens but keeps /health open", async () => {
      expect((await fetch(`${base}/status`)).status).toBe(401);
      expect((await fetch(`${base}/status?token=wrong`)).status).toBe(401);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    });

    it("accepts query, header and bearer tokens", async () => {
      expect((await fetch(`${base}/status?token=s3cret`)).status).toBe(200);
      expect((await fetch(`${base}/status`, { headers: { "X-Kindle-Token": "s3cret" } })).status).toBe(200);
      expect((await fetch(`${base}/status`, { headers: { Authorization: "Bearer s3cret" } })).status).toBe(200);
    });
  });
});
