export const LOCAL_MEDIA_SCHEME = 'eleckoi-media'

export function chatAttachmentMediaReference(conversationId: string, attachmentId: string): string {
  return `${LOCAL_MEDIA_SCHEME}://chat/v1/${encodeURIComponent(conversationId)}/${encodeURIComponent(attachmentId)}`
}
