import { afterEach, describe, expect, it, vi } from "vitest";
import { TDAMError } from "../src/errors.js";
import { HttpTransport } from "../src/http.js";
import { V3HttpTransport } from "../src/v3/http.js";

describe("HttpTransport (v2)", () => {
  const originalTlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalTlsEnv === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsEnv;
    }
  });

  it("does not mutate process.env.NODE_TLS_REJECT_UNAUTHORIZED in ESM", async () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const transport = new HttpTransport({
      endpoint: "https://memory.example.com/",
      apiKey: "sk-test",
      serviceId: "mem-1",
    });

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    await transport.close();
  });

  it("wraps non-JSON 200 responses as TDAMError instead of SyntaxError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "x-trace-id": "trace-abc" },
      }),
    );

    const transport = new HttpTransport({
      endpoint: "https://memory.example.com",
      apiKey: "sk-test",
      serviceId: "mem-1",
      rejectUnauthorized: true,
    });

    await expect(transport.post("v2/test", {})).rejects.toMatchObject({
      name: "TDAMError",
      code: -1,
      requestId: "trace-abc",
    });
    await transport.close();
  });
});

describe("V3HttpTransport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits null and undefined query params and normalizes missing leading slash", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 0, message: "ok", data: { count: 1 } }), {
        status: 200,
        headers: { "x-trace-id": "tr-1" },
      }),
    );

    const transport = new V3HttpTransport({
      endpoint: "https://memory.example.com/",
      apiKey: "sk-test",
      serviceId: "mem-1",
    });

    const result = await transport.get<{ count: number }>("v3/items", {
      space_id: "s1",
      empty: null,
      missing: undefined,
    });

    expect(result).toEqual({ count: 1, trace_id: "tr-1" });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://memory.example.com/v3/items?space_id=s1");
    await transport.close();
  });

  it("returns code -1 when HTTP 200 envelope omits business code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "malformed" }), { status: 200 }),
    );

    const transport = new V3HttpTransport({
      endpoint: "https://memory.example.com",
      apiKey: "sk-test",
      serviceId: "mem-1",
    });

    await expect(transport.post("/v3/test", {})).rejects.toBeInstanceOf(TDAMError);
    await expect(transport.post("/v3/test", {})).rejects.toMatchObject({ code: -1 });
    await transport.close();
  });
});
