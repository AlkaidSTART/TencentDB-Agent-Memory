/**
 * Low-level HTTP transport for the TencentDB Agent Memory v2 API.
 *
 * - Auth: `Authorization: Bearer {apiKey}` + `x-tdai-service-id` + optional `x-tdai-user-key`
 * - Envelope unwrap: `code === 0` → return `data`; else throw `TDAMError`
 * - trace_id: extracted from `x-trace-id` response header
 * - Zero runtime dependencies — uses native `fetch`.
 * - TLS: `rejectUnauthorized` defaults to `false` (self-signed cert friendly).
 */

import { Agent } from "undici";
import { TDAMError } from "./errors.js";
import type { ApiResponseEnvelope } from "./types.js";

export interface HttpTransportOptions {
  endpoint: string;
  /** 网关 Bearer 密钥（KERNEL_AUTH_TOKEN / TDAI_GATEWAY_API_KEY）。 */
  apiKey: string;
  /** 记忆实例 ID（x-tdai-service-id）。 */
  serviceId: string;
  /** 用户 API 密钥（x-tdai-user-key）；user/create、user/delete 须 system_admin key。 */
  userKey?: string;
  timeout?: number;
  /** Whether to reject self-signed / invalid TLS certs. Default: false. */
  rejectUnauthorized?: boolean;
}

export class HttpTransport {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private readonly dispatcher?: Agent;

  constructor(opts: HttpTransportOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.timeout = opts.timeout ?? 30_000;
    this.headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      "x-tdai-service-id": opts.serviceId,
      "Content-Type": "application/json",
    };
    if (opts.userKey) {
      this.headers["x-tdai-user-key"] = opts.userKey;
    }

    // When rejectUnauthorized=false (default), scope TLS relaxation strictly to
    // this transport's undici Agent instead of mutating process.env globally.
    if (opts.rejectUnauthorized !== true) {
      this.dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  async close(): Promise<void> {
    if (this.dispatcher) {
      await this.dispatcher.close();
    }
  }

  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T & { trace_id?: string }> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${this.endpoint}${normalizedPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const fetchOpts: RequestInit & { dispatcher?: Agent } = {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      };
      if (this.dispatcher) {
        fetchOpts.dispatcher = this.dispatcher;
      }

      const resp = await fetch(url, fetchOpts as RequestInit);

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new TDAMError(resp.status, `HTTP ${resp.status}: ${text}`);
      }

      const responseText = await resp.text().catch(() => "");
      let envelope: ApiResponseEnvelope<T>;
      try {
        envelope = JSON.parse(responseText) as ApiResponseEnvelope<T>;
      } catch {
        const reqId = resp.headers.get("x-qcloud-transaction-id") ?? resp.headers.get("x-trace-id") ?? "";
        throw new TDAMError(
          -1,
          responseText || `HTTP ${resp.status} returned a non-JSON response`,
          reqId,
        );
      }

      if (!envelope || typeof envelope !== "object" || envelope.code !== 0) {
        const reqId =
          resp.headers.get("x-qcloud-transaction-id") ?? envelope?.request_id ?? "";
        const details =
          envelope?.data && typeof envelope.data === "object"
            ? (envelope.data as Record<string, unknown>)
            : undefined;
        throw new TDAMError(
          typeof envelope?.code === "number" ? envelope.code : -1,
          envelope?.message ?? "API response must be a JSON object",
          reqId,
          details,
        );
      }

      const result = (envelope.data ?? {}) as T & { trace_id?: string };
      const traceId = resp.headers.get("x-trace-id");
      if (traceId && result && typeof result === "object") {
        (result as Record<string, unknown>).trace_id = traceId;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
