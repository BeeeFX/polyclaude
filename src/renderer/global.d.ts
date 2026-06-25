import type { PolyApi } from "./types";

declare global {
  interface Window {
    poly: PolyApi;
  }
}

export {};
