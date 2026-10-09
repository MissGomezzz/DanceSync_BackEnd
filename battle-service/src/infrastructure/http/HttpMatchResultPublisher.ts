import type { MatchRecord } from "../../domain/model/MatchRecord.js";
import { MatchPublishError, type MatchResultPublisher } from "../../domain/ports/MatchResultPublisher.js";

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Stores matches in users-service with `PUT /api/matches/{battleId}`, an
 * idempotent upsert, so a retried request never creates a second match. This
 * call goes service to service; the gateway does not expose the PUT.
 */
export class HttpMatchResultPublisher implements MatchResultPublisher {
  private readonly baseUrl: string;

  constructor(
    usersServiceUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = usersServiceUrl.replace(/\/+$/, "");
  }

  async publish(match: MatchRecord): Promise<void> {
    const url = `${this.baseUrl}/api/matches/${encodeURIComponent(match.id)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        // Dates serialize as ISO-8601 instants.
        body: JSON.stringify(match),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new MatchPublishError(`users-service unreachable at ${url}: ${describe(error)}`, true);
    }
    // Always drain the body so the connection can be reused.
    const body = await response.text().catch(() => "");
    if (response.ok) return;
    // 5xx, 408 and 429 may pass on a retry; any other 4xx means the document itself was refused.
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    throw new MatchPublishError(`users-service answered ${response.status}: ${body.slice(0, 300)}`, retryable);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
