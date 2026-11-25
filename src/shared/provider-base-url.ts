const defaults = {
  DATAFORSEO_BASE_URL: "https://api.dataforseo.com",
  CONTEXT_BASE_URL: "https://api.context.dev",
};

export type ProviderBaseUrlSetting = keyof typeof defaults;

export function providerBaseUrl(
  name: ProviderBaseUrlSetting,
  value?: string,
): string {
  if (!value) return defaults[name];
  if (
    /^https?:\/\/[^/\\\s?#]+(?:\/[^\\\s?#]*)?$/i.test(value) &&
    URL.canParse(value)
  ) {
    const url = new URL(value);
    if (!url.username && !url.password) {
      return url.href.replace(/\/+$/, "");
    }
  }
  throw new Error(
    `${name} must be an absolute HTTP(S) URL without credentials, a query, or a fragment`,
  );
}
