/**
 * Desk note and history markdown are untrusted.
 *
 * The shared Mermaid component defaults to `securityLevel: 'loose'`, which
 * registers diagram `click` handlers that call functions on `window`
 * (including `window.desk`) and skips DOMPurify on the emitted SVG.
 * Mermaid's own default, and Desk's unused `diagramRenderer` path, are `strict`.
 */
export const DESK_MERMAID_SECURITY_LEVEL = 'strict' as const
