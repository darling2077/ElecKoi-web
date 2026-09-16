import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { LOCAL_MEDIA_SCHEME } from '@shared/foundation/mediaReference'

export function registerLocalMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: LOCAL_MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }])
}

export const mediaProtocolPlugin = {
  name: 'eleckoi-media-protocol',
  inject: ['mediaAssets', 'agentSessions'],
  apply(ctx: Context) {
    protocol.handle(LOCAL_MEDIA_SCHEME, async (request) => {
      const path = ctx.mediaAssets.pathForReference(request.url)
      if (path) return net.fetch(pathToFileURL(path).toString())
      const chatAttachment = parseChatAttachmentReference(request.url)
      if (!chatAttachment) return new Response(null, { status: 404 })
      try {
        const image = await ctx.agentSessions.readImage(chatAttachment.conversationId, chatAttachment.attachmentId)
        return new Response(Uint8Array.from(Buffer.from(image.data, 'base64')), {
          headers: { 'Content-Type': image.mediaType, 'Cache-Control': 'private, max-age=31536000, immutable' }
        })
      } catch {
        return new Response(null, { status: 404 })
      }
    })
    return () => protocol.unhandle(LOCAL_MEDIA_SCHEME)
  }
} satisfies Plugin.Object

function parseChatAttachmentReference(reference: string): { conversationId: string; attachmentId: string } | undefined {
  let url: URL
  try { url = new URL(reference) } catch { return undefined }
  if (url.protocol !== `${LOCAL_MEDIA_SCHEME}:` || url.hostname !== 'chat' || url.search || url.hash) return undefined
  let parts: string[]
  try { parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part)) } catch { return undefined }
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return undefined
  return { conversationId: parts[1], attachmentId: parts[2] }
}
