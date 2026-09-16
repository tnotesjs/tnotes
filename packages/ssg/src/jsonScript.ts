/**
 * Serializes a payload for a `<script>` block — the page's own data, or the
 * `__pageData` of a note that carries SFC blocks.
 *
 * `<` is written as `\u003c`, which is the same character inside a JS or JSON
 * string literal: nothing here is HTML, so the escape changes no value, and it
 * keeps the HTML parser from finding a tag that was never there. Note text can
 * contain anything — a note is allowed to show `</script>` — and that literal
 * would otherwise close the block early, leaving the rest of the note to be
 * parsed as markup.
 */
export function jsonScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
