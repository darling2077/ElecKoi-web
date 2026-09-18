export function errorMessage(error: unknown): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    const message = current instanceof Error ? current.message : String(current)
    if (message.trim() && !messages.includes(message)) messages.push(message)
    current = current instanceof Error ? current.cause : undefined
  }
  return messages.join('\nCaused by: ')
}
