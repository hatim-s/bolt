/**
 * Compatibility barrel for older local imports that referenced src/bolt/store.
 *
 * The actual package entry is index.ts, so this file simply forwards that
 * surface without creating a second API.
 */
export * from "./index";
