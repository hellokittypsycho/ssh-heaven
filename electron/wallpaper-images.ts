import { deflate } from 'node:zlib'
import { promisify } from 'node:util'
import { decompressFrame, parseGIF } from 'gifuct-js'

export const MAX_WALLPAPER_BYTES = 20 * 1024 * 1024
export const MAX_WALLPAPER_PIXELS = 32 * 1024 * 1024
export const MAX_GIF_PIXELS = 8 * 1024 * 1024
const MAX_DIMENSION = 16384
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
export interface WallpaperImage { format: 'png' | 'jpeg' | 'webp' | 'gif'; mime: string; width: number; height: number; animated: boolean }

function invalid(): never { throw new Error('Choose a valid PNG, JPEG, WebP, or GIF image. SVG and remote images are not supported.') }
function dimensions(width: number, height: number, animated = false): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) invalid()
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > (animated ? MAX_GIF_PIXELS : MAX_WALLPAPER_PIXELS)) throw new Error(animated ? 'This GIF exceeds the 8 megapixel limit. Choose a smaller animation (up to 4K).' : 'This image exceeds the 32 megapixel limit or its dimensions are too large.')
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})
export function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function png(bytes: Buffer): WallpaperImage {
  if (bytes.length < 45 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid()
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  dimensions(width, height)
  let offset = 8, chunks = 0, data = false, end = false
  while (offset + 12 <= bytes.length) {
    if (++chunks > 10000) invalid()
    const length = bytes.readUInt32BE(offset)
    if (length > bytes.length - offset - 12) invalid()
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (!/^[a-zA-Z]{4}$/.test(type) || pngCrc(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) invalid()
    if (type === 'acTL') throw new Error('Animated PNG is not supported. Choose a GIF for an animated wallpaper.')
    if (type === 'IDAT') data = true
    offset += length + 12
    if (type === 'IEND') { if (length !== 0 || offset !== bytes.length) invalid(); end = true; break }
  }
  if (!data || !end) invalid()
  return { format: 'png', mime: 'image/png', width, height, animated: false }
}

function jpeg(bytes: Buffer): WallpaperImage {
  if (bytes.length < 12 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) invalid()
  let offset = 2, width = 0, height = 0
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) invalid()
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) invalid()
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) invalid()
    if (startOfFrame.has(marker)) {
      if (length < 8) invalid()
      height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5)
      dimensions(width, height)
    }
    offset += length
  }
  dimensions(width, height)
  return { format: 'jpeg', mime: 'image/jpeg', width, height, animated: false }
}

function webp(bytes: Buffer): WallpaperImage {
  if (bytes.length < 25 || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid()
  let offset = 12, width = 0, height = 0, image = false
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (length > bytes.length - start) invalid()
    if (type === 'VP8X') {
      if (length !== 10) invalid()
      if (bytes[start] & 2) throw new Error('Animated WebP is not supported. Choose a GIF for an animated wallpaper.')
      width = 1 + bytes.readUIntLE(start + 4, 3); height = 1 + bytes.readUIntLE(start + 7, 3)
    } else if (type === 'VP8 ') {
      if (length < 10 || bytes[start] & 1 || bytes.toString('hex', start + 3, start + 6) !== '9d012a') invalid()
      const frameWidth = bytes.readUInt16LE(start + 6) & 0x3fff, frameHeight = bytes.readUInt16LE(start + 8) & 0x3fff
      if (width && (width !== frameWidth || height !== frameHeight)) invalid()
      width = frameWidth; height = frameHeight; image = true
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[start] !== 0x2f) invalid()
      const bits = bytes.readUInt32LE(start + 1)
      const frameWidth = 1 + (bits & 0x3fff), frameHeight = 1 + ((bits >>> 14) & 0x3fff)
      if (width && (width !== frameWidth || height !== frameHeight)) invalid()
      width = frameWidth; height = frameHeight; image = true
    } else if (type === 'ANIM' || type === 'ANMF') throw new Error('Animated WebP is not supported. Choose a GIF for an animated wallpaper.')
    offset = start + length + (length & 1)
  }
  if (!image || offset !== bytes.length) invalid()
  dimensions(width, height)
  return { format: 'webp', mime: 'image/webp', width, height, animated: false }
}

function gif(bytes: Buffer): WallpaperImage {
  if (bytes.length < 14) invalid()
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8)
  dimensions(width, height, true)
  let offset = 13 + (bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0)
  let frames = 0, totalPixels = 0, trailer = false
  const subblocks = () => {
    while (offset < bytes.length) {
      const count = bytes[offset++]
      if (!count) return
      if (count > bytes.length - offset) invalid()
      offset += count
    }
    invalid()
  }
  while (offset < bytes.length) {
    const marker = bytes[offset++]
    if (marker === 0x3b) { trailer = true; break }
    if (marker === 0x21) { if (offset >= bytes.length) invalid(); offset++; subblocks(); continue }
    if (marker !== 0x2c || offset + 9 > bytes.length) invalid()
    const left = bytes.readUInt16LE(offset), top = bytes.readUInt16LE(offset + 2)
    const frameWidth = bytes.readUInt16LE(offset + 4), frameHeight = bytes.readUInt16LE(offset + 6)
    dimensions(frameWidth, frameHeight, true)
    if (left + frameWidth > width || top + frameHeight > height) invalid()
    totalPixels += frameWidth * frameHeight
    if (++frames > 1000 || totalPixels > 256 * 1024 * 1024) throw new Error('This GIF contains too many animation frames. Choose a shorter or smaller animation.')
    const packed = bytes[offset + 8]
    offset += 9 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0)
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) invalid()
    offset++; subblocks()
  }
  if (!frames || !trailer || offset !== bytes.length) invalid()
  return { format: 'gif', mime: 'image/gif', width, height, animated: frames > 1 }
}

/** Validate actual encoded bytes before any decoder allocates an image. */
export function inspectWallpaper(bytes: Buffer): WallpaperImage {
  if (!bytes.length || bytes.length > MAX_WALLPAPER_BYTES) throw new Error('Choose an image no larger than 20 MiB.')
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(pngSignature)) return png(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes)
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return webp(bytes)
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return gif(bytes)
  return invalid()
}

export function inspectWallpaperPoster(bytes: Buffer): WallpaperImage {
  if (!bytes.length || bytes.length > 40 * 1024 * 1024 || !bytes.subarray(0, 8).equals(pngSignature)) invalid()
  const image = png(bytes)
  dimensions(image.width, image.height, true)
  return image
}

function pngChunk(type: string, bytes: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + bytes.length)
  chunk.writeUInt32BE(bytes.length, 0); chunk.write(type, 4, 4, 'ascii'); bytes.copy(chunk, 8)
  chunk.writeUInt32BE(pngCrc(chunk.subarray(4, 8 + bytes.length)), 8 + bytes.length)
  return chunk
}

/** Encode a static RGBA first-frame poster without a native image dependency. */
export async function encodeWallpaperPng(width: number, height: number, rgba: Uint8Array): Promise<Buffer> {
  dimensions(width, height, true)
  if (rgba.length !== width * height * 4) invalid()
  const stride = width * 4, rows = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row++) rows.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const compressed = await promisify(deflate)(rows)
  return Buffer.concat([pngSignature, pngChunk('IHDR', header), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))])
}

/** Decode only the first image frame; original animation bytes stay untouched. */
export async function createGifPoster(bytes: Buffer): Promise<Buffer> {
  const image = inspectWallpaper(bytes)
  if (image.format !== 'gif') invalid()
  try {
    const copy = Uint8Array.from(bytes)
    const parsed = parseGIF(copy.buffer)
    const first = parsed.frames.find((frame): frame is Parameters<typeof decompressFrame>[0] => 'image' in frame)
    if (!first) invalid()
    const frame = decompressFrame(first, parsed.gct, true)
    if (!frame || frame.patch.length !== frame.dims.width * frame.dims.height * 4 || frame.pixels.some((pixel) => !frame.colorTable[pixel])) invalid()
    const rgba = new Uint8Array(image.width * image.height * 4)
    const background = parsed.gct?.[parsed.lsd.backgroundColorIndex]
    // Transparency in the first frame means the canvas outside its rectangle
    // is transparent too. Otherwise retain the logical screen's background.
    if (background && frame.transparentIndex === undefined) {
      for (let offset = 0; offset < rgba.length; offset += 4) { rgba[offset] = background[0]; rgba[offset + 1] = background[1]; rgba[offset + 2] = background[2]; rgba[offset + 3] = 255 }
    }
    const stride = frame.dims.width * 4
    for (let row = 0; row < frame.dims.height; row++) rgba.set(frame.patch.subarray(row * stride, (row + 1) * stride), ((row + frame.dims.top) * image.width + frame.dims.left) * 4)
    return encodeWallpaperPng(image.width, image.height, rgba)
  } catch { throw new Error('This GIF could not be decoded. Choose another image or animation.') }
}
