/**
 * Extension modules use WXT's auto-imported `browser` global. Harness tests that
 * import them (assistant-comment.test.ts) install a fake on globalThis; this lets
 * the harness typecheck those modules without pulling in WXT's types.
 */
declare const browser: any;
