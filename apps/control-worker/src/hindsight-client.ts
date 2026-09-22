export type HindsightFetcher = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;
export type RetainItem = {
  content: string;
  document_id: string;
  tags?: string[];
  metadata?: Record<string, string>;
  context?: string;
  timestamp?: string;
  update_mode?: "replace" | "append";
};
export type HindsightErrorShape = {
  detail?: string | { message?: string } | Array<{ msg?: string }>;
};

export class HindsightError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "HindsightError";
    this.status = status;
    this.body = body;
  }
}

const encode = (value: string) => encodeURIComponent(value);

/** Small, bank-scoped REST client. The caller owns URL resolution and auth in fetcher. */
export class HindsightClient {
  constructor(private readonly fetcher: HindsightFetcher) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(path, {
        ...init,
        headers: { "content-type": "application/json", ...init.headers },
      });
    } catch (error) {
      throw new HindsightError(
        error instanceof Error ? error.message : "Hindsight request failed",
        0,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (response.ok && response.status !== 204) throw new HindsightError("Hindsight returned an unreadable JSON response", 502);
      body = undefined;
    }
    if (!response.ok) {
      const detail = (body as HindsightErrorShape | undefined)?.detail;
      const message =
        typeof detail === "string"
          ? detail
          : detail && typeof detail === "object" && "message" in detail
            ? detail.message
            : `HTTP ${response.status}`;
      throw new HindsightError(
        `Hindsight request failed: ${message || `HTTP ${response.status}`}`,
        response.status,
        body,
      );
    }
    return body as T;
  }

  health(): Promise<unknown> {
    return this.request("/health");
  }

  createBank(bankId: string, name?: string): Promise<unknown> {
    return this.request(`/v1/default/banks/${encode(bankId)}`, {
      method: "PUT",
      body: JSON.stringify(name === undefined ? {} : { name }),
    });
  }

  retain(
    bankId: string,
    items: RetainItem[],
    operationId?: string,
  ): Promise<unknown> {
    return this.request(`/v1/default/banks/${encode(bankId)}/memories`, {
      method: "POST",
      body: JSON.stringify({
        items,
        async: true,
        ...(operationId ? { operation_id: operationId } : {}),
      }),
    });
  }

  operation(bankId: string, operationId: string): Promise<unknown> {
    return this.request(
      `/v1/default/banks/${encode(bankId)}/operations/${encode(operationId)}`,
    );
  }

  recall(
    bankId: string,
    query: string,
    budget: "low" | "mid" | "high" = "mid",
  ): Promise<unknown> {
    return this.request(`/v1/default/banks/${encode(bankId)}/memories/recall`, {
      method: "POST",
      body: JSON.stringify({ query, budget }),
    });
  }

  reflect(
    bankId: string,
    query: string,
    budget: "low" | "mid" | "high" = "mid",
  ): Promise<unknown> {
    return this.request(`/v1/default/banks/${encode(bankId)}/reflect`, {
      method: "POST",
      body: JSON.stringify({ query, budget, include: { facts: {} } }),
    });
  }

  deleteBank(bankId: string): Promise<unknown> {
    return this.request(`/v1/default/banks/${encode(bankId)}`, {
      method: "DELETE",
    });
  }

  observations(bankId: string): Promise<unknown> {
    return this.request(
      `/v1/default/banks/${encode(bankId)}/memories/list?type=observation&limit=50`,
    );
  }

  mentalModels(bankId: string): Promise<unknown> {
    return this.request(
      `/v1/default/banks/${encode(bankId)}/mental-models?detail=content`,
    );
  }

  createMentalModel(
    bankId: string,
    input: { name: string; query: string; tags?: string[]; id?: string },
  ): Promise<unknown> {
    return this.request(`/v1/default/banks/${encode(bankId)}/mental-models`, {
      method: "POST",
      body: JSON.stringify({
        id: input.id,
        name: input.name,
        source_query: input.query,
        tags: input.tags ?? [],
      }),
    });
  }

  deleteMentalModel(bankId: string, modelId: string): Promise<unknown> {
    return this.request(
      `/v1/default/banks/${encode(bankId)}/mental-models/${encode(modelId)}`,
      { method: "DELETE" },
    );
  }

  refreshMentalModel(bankId: string, modelId: string): Promise<unknown> {
    return this.request(
      `/v1/default/banks/${encode(bankId)}/mental-models/${encode(modelId)}/refresh`,
      { method: "POST" },
    );
  }
}
