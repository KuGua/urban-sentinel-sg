const DEFAULT_HTTP_BASE_URL = "http://localhost:8080";
const DEFAULT_WS_BASE_URL = "ws://localhost:8080";

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getApiBaseUrl(): string {
  const fromExpo =
    typeof process !== "undefined" ? process.env.EXPO_PUBLIC_API_BASE_URL : undefined;
  const fromCra =
    typeof process !== "undefined" ? process.env.REACT_APP_API_BASE_URL : undefined;
  return normalizeBaseUrl(fromExpo || fromCra || DEFAULT_HTTP_BASE_URL);
}

export function getWsBaseUrl(): string {
  const fromExpo =
    typeof process !== "undefined" ? process.env.EXPO_PUBLIC_WS_BASE_URL : undefined;
  const fromCra =
    typeof process !== "undefined" ? process.env.REACT_APP_WS_BASE_URL : undefined;
  return normalizeBaseUrl(fromExpo || fromCra || DEFAULT_WS_BASE_URL);
}

