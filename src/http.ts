import { notFound, rateLimited, unreachable, upstreamShape } from "./errors.ts";

export const USER_AGENT = "skill-lock/0.1.0 (+https://github.com/gaabsoares/skill-lock)";

export interface HttpResponse {
  url: string;
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface HttpOptions {
  accept?: string;
  timeoutMs?: number;
  /** how many times to retry a 429 or 5xx before giving up */
  retries?: number;
  /** bounds a single response body; a registry that starts streaming gigabytes is a failure, not a download */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export interface Fetcher {
  (url: string, options?: HttpOptions): Promise<HttpResponse>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Seconds to wait before a retry is worth attempting, from whichever header the
 * upstream provided. ClawHub sends RateLimit-Reset as a delay and
 * X-RateLimit-Reset as an epoch; GitHub sends only the epoch form.
 */
export function retryDelaySeconds(headers: Headers, now = Date.now()): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  }
  const delay = headers.get("ratelimit-reset");
  if (delay !== null && Number.isFinite(Number(delay))) return Math.max(0, Number(delay));
  const epoch = headers.get("x-ratelimit-reset");
  if (epoch !== null && Number.isFinite(Number(epoch))) {
    return Math.max(0, Math.ceil((Number(epoch) * 1000 - now) / 1000));
  }
  return null;
}

function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  // GitHub answers an exhausted unauthenticated quota with 403 plus a zeroed remaining counter
  return res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
}

export const httpGet: Fetcher = async (url, options = {}) => {
  const retries = options.retries ?? 1;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let attempt = 0;

  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: options.accept ?? "application/json",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw unreachable(`cannot reach ${url}: ${reason}`, cause);
    }

    if ((isRateLimited(res) || res.status >= 500) && attempt < retries) {
      const wait = Math.min(retryDelaySeconds(res.headers) ?? 2, 10);
      attempt += 1;
      await sleep(wait * 1000);
      continue;
    }

    if (isRateLimited(res)) {
      const wait = retryDelaySeconds(res.headers);
      throw rateLimited(
        `rate limited by ${new URL(url).host}${wait === null ? "" : `; retry in ${wait}s`}`,
        {
          url,
          status: res.status,
          retry_after_seconds: wait,
          limit: res.headers.get("x-ratelimit-limit") ?? res.headers.get("ratelimit-limit"),
        },
      );
    }

    if (res.status >= 500) {
      throw unreachable(`${new URL(url).host} returned ${res.status} for ${url}`);
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw upstreamShape(`response from ${url} exceeded the ${maxBytes} byte cap`, {
        url,
        bytes: buf.byteLength,
        max_bytes: maxBytes,
      });
    }
    return { url, status: res.status, headers: res.headers, body: buf };
  }
};

export function decodeUtf8(body: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

/** GET returning parsed JSON, mapping 404 to a "does not exist" error distinct from "cannot reach". */
export async function getJson(
  fetcher: Fetcher,
  url: string,
  what: string,
  options?: HttpOptions,
): Promise<unknown> {
  const res = await fetcher(url, options);
  if (res.status === 404) {
    throw notFound(`${what} does not exist upstream (404 from ${url})`, { url });
  }
  if (res.status !== 200) {
    throw upstreamShape(`unexpected HTTP ${res.status} for ${what}`, {
      url,
      status: res.status,
      body: decodeUtf8(res.body).slice(0, 500),
    });
  }
  const text = decodeUtf8(res.body);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw upstreamShape(`${what} did not return JSON`, { url, body: text.slice(0, 300) });
  }
}
