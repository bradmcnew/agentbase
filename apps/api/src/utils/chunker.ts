/**
 * Split text into overlapping chunks for indexing.
 * Targets ~500 tokens per chunk with 50 token overlap.
 * Uses ~4 chars per token heuristic.
 */
export function chunkText(text: string, chunkSize = 2000, overlap = 200): Array<{ content: string; index: number }> {
  if (text.length <= chunkSize) {
    return [{ content: text, index: 0 }]
  }

  const chunks: Array<{ content: string; index: number }> = []
  let start = 0
  let index = 0

  while (start < text.length) {
    let end = start + chunkSize

    // Try to break at a paragraph or sentence boundary
    if (end < text.length) {
      const slice = text.slice(start, end)
      const lastParagraph = slice.lastIndexOf('\n\n')
      const lastNewline = slice.lastIndexOf('\n')
      const lastPeriod = slice.lastIndexOf('. ')

      if (lastParagraph > chunkSize * 0.5) {
        end = start + lastParagraph + 2
      } else if (lastNewline > chunkSize * 0.5) {
        end = start + lastNewline + 1
      } else if (lastPeriod > chunkSize * 0.5) {
        end = start + lastPeriod + 2
      }
    }

    const content = text.slice(start, end).trim()
    if (content.length > 0) {
      chunks.push({ content, index })
    }
    start = end - overlap
    index++
  }

  return chunks
}
