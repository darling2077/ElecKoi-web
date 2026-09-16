const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_PNG_BYTES = 96 * 1024 * 1024
const MAX_CHUNK_BYTES = 96 * 1024 * 1024

interface PngChunk {
  type: string
  data: Uint8Array
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

export function readPngText(bytes: Uint8Array): Map<string, string> {
  const result = new Map<string, string>()
  const decoder = new TextDecoder('latin1')
  for (const chunk of parsePng(bytes)) {
    if (chunk.type !== 'tEXt') continue
    const separator = chunk.data.indexOf(0)
    if (separator <= 0 || separator >= chunk.data.length - 1) continue
    result.set(decoder.decode(chunk.data.slice(0, separator)), decoder.decode(chunk.data.slice(separator + 1)))
  }
  return result
}

export function writePngText(bytes: Uint8Array, values: ReadonlyMap<string, string>): Uint8Array {
  const keywords = new Set(values.keys())
  return writePngChunks(parsePng(bytes).filter((chunk) => (
    chunk.type !== 'tEXt' || !keywords.has(textKeyword(chunk.data))
  )), values)
}

export function writePngTextOnly(bytes: Uint8Array, values: ReadonlyMap<string, string>): Uint8Array {
  return writePngChunks(parsePng(bytes).filter((chunk) => chunk.type !== 'tEXt'), values)
}

function writePngChunks(chunks: PngChunk[], values: ReadonlyMap<string, string>): Uint8Array {
  const output: Uint8Array[] = [PNG_SIGNATURE]
  for (const chunk of chunks) {
    if (chunk.type === 'IEND') {
      for (const [keyword, value] of values) output.push(encodeTextChunk(keyword, value))
    }
    output.push(encodeChunk(chunk.type, chunk.data))
  }
  const result = concat(output)
  if (result.length > MAX_PNG_BYTES) throw new Error('PNG 文件不能超过 96 MB')
  return result
}

function parsePng(bytes: Uint8Array): PngChunk[] {
  if (bytes.length > MAX_PNG_BYTES) throw new Error('PNG 图片不能超过 96 MB')
  if (!isPng(bytes)) throw new Error('这不是 PNG 图片')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder('ascii')
  const chunks: PngChunk[] = []
  let offset = PNG_SIGNATURE.length
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error('PNG 数据不完整')
    const length = view.getUint32(offset, false)
    if (length > MAX_CHUNK_BYTES) throw new Error('PNG 数据块大小无效')
    const end = offset + 12 + length
    if (end > bytes.length) throw new Error('PNG 数据块不完整')
    const type = decoder.decode(bytes.slice(offset + 4, offset + 8))
    if (type.length !== 4 || [...type].some((character) => character.charCodeAt(0) < 65 || character.charCodeAt(0) > 122)) {
      throw new Error('PNG 数据块类型无效')
    }
    chunks.push({ type, data: bytes.slice(offset + 8, offset + 8 + length) })
    offset = end
    if (type === 'IEND') {
      if (offset !== bytes.length) throw new Error('PNG 结束标记后存在异常数据')
      return chunks
    }
  }
  throw new Error('PNG 缺少结束标记')
}

function encodeTextChunk(keyword: string, value: string): Uint8Array {
  if (!keyword || keyword.length > 79 || /[^\x20-\x7e]/.test(keyword)) throw new Error('PNG 文本关键字无效')
  if (/[^\x00-\xff]/.test(value)) throw new Error('PNG 文本数据必须使用 Latin-1')
  const data = Uint8Array.from(Buffer.from(`${keyword}\0${value}`, 'latin1'))
  if (data.length > MAX_CHUNK_BYTES) throw new Error('PNG 文本数据块过大')
  return encodeChunk('tEXt', data)
}

function encodeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const result = new Uint8Array(data.length + 12)
  const view = new DataView(result.buffer)
  view.setUint32(0, data.length, false)
  result.set(typeBytes, 4)
  result.set(data, 8)
  view.setUint32(data.length + 8, crc32(concat([typeBytes, data])), false)
  return result
}

function textKeyword(data: Uint8Array): string {
  const separator = data.indexOf(0)
  return separator > 0 ? new TextDecoder('latin1').decode(data.slice(0, separator)) : ''
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}
