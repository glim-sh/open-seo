import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dataforseoGet,
  dataforseoPost,
  dataforseoPostResponse,
} from "@/server/lib/dataforseo/core";
import { assertSerpLocationNameAccepted } from "@/server/lib/dataforseo/serp-location-validate";

beforeEach(() => {
  vi.stubEnv("DATAFORSEO_API_KEY", "encoded-credentials");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("DataForSEO transport", () => {
  it("retries a transient 5xx on idempotent reads and returns the parsed envelope", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream failure", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status_code: 20000, tasks: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dataforseoPost("/v3/backlinks/summary/live", []),
    ).resolves.toEqual({ status_code: 20000, tasks: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.dataforseo.com/v3/backlinks/summary/live");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Basic encoded-credentials",
    );
    expect(new Headers(init?.headers).get("Accept-Encoding")).toBe("gzip");
  });

  it("uses the configured base path for parsed and streaming requests", async () => {
    vi.stubEnv("DATAFORSEO_BASE_URL", "http://mirror.example/providers/seo///");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await dataforseoGet("/v3/serp/google/locations/us");
    await dataforseoPostResponse("/v3/on_page/lighthouse/live/json", []);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://mirror.example/providers/seo/v3/serp/google/locations/us",
      "http://mirror.example/providers/seo/v3/on_page/lighthouse/live/json",
    ]);
  });

  it.each([
    "/mirror",
    "ftp://mirror.example",
    "https://mirror.example/?key=value",
  ])(
    "rejects an invalid DATAFORSEO_BASE_URL (%s) before sending credentials",
    async (base) => {
      vi.stubEnv("DATAFORSEO_BASE_URL", base);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({}));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        dataforseoGet("/v3/serp/google/locations/us"),
      ).rejects.toThrow("DATAFORSEO_BASE_URL");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("skips sandbox location validation when the deployment uses a custom base", async () => {
    vi.stubEnv("DATAFORSEO_BASE_URL", "https://mirror.example");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await assertSerpLocationNameAccepted({
      locationName: "Lisbon",
      languageCode: "en",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The Docker edition's runtime hands the body over still gzipped because we
  // set Accept-Encoding ourselves; parsing it raw failed every call.
  it("inflates a body the runtime left gzipped", async () => {
    const envelope = { status_code: 20000, tasks: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(gzipSync(JSON.stringify(envelope)), {
          headers: { "Content-Encoding": "gzip" },
        }),
      ),
    );

    await expect(
      dataforseoPost("/v3/backlinks/summary/live", []),
    ).resolves.toEqual(envelope);
  });

  // An unverified account answers with HTTP 403 (status_code 40104). Left as
  // INTERNAL_ERROR it reached self-hosters as "an unexpected error occurred".
  it("maps a 403 to DATAFORSEO_AUTH_FAILED", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status_code: 40104 }, { status: 403 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dataforseoPost("/v3/backlinks/summary/live", []),
    ).rejects.toMatchObject({ code: "DATAFORSEO_AUTH_FAILED" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // The request-deadline abort arrives as a bare DOMException. Left unclassified
  // it escapes as an anonymous INTERNAL_ERROR; retrying it would replay a call
  // DataForSEO may already have billed. Both names are reachable: the shared
  // budget aborts with TimeoutError, Lighthouse's own controller with AbortError.
  it.each(["TimeoutError", "AbortError"])(
    "maps a %s abort to UPSTREAM_UNAVAILABLE without retrying",
    async (name) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException("aborted", name));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        dataforseoPost("/v3/serp/google/organic/live/advanced", []),
      ).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
        name: "DataForSEOTimeoutError",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  // Seen in production: headers arrive in time, then the deadline aborts
  // while the body is still streaming in.
  it("maps a timeout while reading the body to UPSTREAM_UNAVAILABLE", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new DOMException("aborted", "TimeoutError"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
    );

    await expect(
      dataforseoPost("/v3/dataforseo_labs/google/ranked_keywords/live", []),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      name: "DataForSEOTimeoutError",
    });
  });
});
