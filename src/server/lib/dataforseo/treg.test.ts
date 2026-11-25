import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";

beforeEach(() => {
  vi.stubEnv("TREG_API_TOKEN", "treg-key");
  vi.stubEnv("DATAFORSEO_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("DataForSEO through treg", () => {
  it.each([undefined, "https://mirror.example/providers/seo/"])(
    "sends DataForSEO calls to treg with base %s",
    async (base) => {
      vi.stubEnv("DATAFORSEO_BASE_URL", base);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ status_code: 20000, tasks: [] }),
        );
      vi.stubGlobal("fetch", fetchMock);

      await dataforseoPost("/v3/backlinks/summary/live", [{ target: "a.com" }]);
      await dataforseoGet("/v3/serp/google/organic/task_get/advanced/abc");

      const [postUrl, postInit] = fetchMock.mock.calls[0];
      expect(postUrl).toBe(
        "https://treg.to/call/dataforseo/backlinks/summary/live",
      );
      expect(postInit?.body).toBe('[{"target":"a.com"}]');
      expect(new Headers(postInit?.headers).get("X-Treg-Token")).toBe(
        "treg-key",
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        "https://treg.to/call/dataforseo/serp/google/organic/task_get/advanced/abc",
      );
    },
  );

  it("blames the treg balance only for a 402 treg made itself", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        Response.json(
          { error: "insufficient_balance" },
          { status: 402, headers: { "X-Treg-Error": "1" } },
        ),
      )
      // No X-Treg-Error: DataForSEO's own 402, relayed.
      .mockImplementationOnce(async () =>
        Response.json({ status_code: 40200 }, { status: 402 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dataforseoPost("/v3/backlinks/summary/live", []),
    ).rejects.toThrow("Your treg balance is empty");
    await expect(
      dataforseoPost("/v3/backlinks/summary/live", []),
    ).rejects.toThrow("DataForSEO HTTP 402");
  });

  it("names TREG_API_TOKEN when treg refuses the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => {
        const response = Response.json(
          { error: "unauthorized" },
          { status: 401, headers: { "X-Treg-Error": "1" } },
        );
        // The Docker edition's runtime can't clone a fetched response.
        response.clone = () => {
          throw new TypeError(
            "Cannot clone a streaming response before consumption",
          );
        };
        return response;
      }),
    );

    await expect(
      dataforseoPost("/v3/backlinks/summary/live", []),
    ).rejects.toThrow("treg refused TREG_API_TOKEN");
  });
});
