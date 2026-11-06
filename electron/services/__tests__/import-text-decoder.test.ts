/** 验证小说导入编码兼容及损坏输入边界；使用固定字节，避免依赖本机编码。 */
import { describe, expect, it } from 'vitest'
import { decodeImportText } from '../import-text-decoder'

describe('decodeImportText', () => {
  const text = '第1章 开始\n正文'

  it.each([
    ['UTF-8', Buffer.from(text)],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])],
    ['UTF-16 LE BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])],
    ['UTF-16 BE BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])],
    ['GBK', Buffer.from('b5da31d5c220bfaacabc0ad5fdcec4', 'hex')],
  ])('decodes %s without changing the text', (_encoding, bytes) => {
    expect(decodeImportText(bytes)).toBe(text)
  })

  it('supports GB18030 four-byte characters', () => {
    expect(decodeImportText(Buffer.from([0x90, 0x30, 0x81, 0x30]))).toBe('\u{10000}')
  })

  it.each([
    ['incomplete GBK character', [0x81]],
    ['damaged UTF-8 BOM text', [0xef, 0xbb, 0xbf, 0xff]],
    ['odd UTF-16 byte count', [0xff, 0xfe, 0x61]],
    ['binary controls', [0x50, 0x4b, 0x03, 0x04]],
    ['NUL', [0x61, 0x00, 0x62]],
  ])('rejects %s', (_description, bytes) => {
    expect(() => decodeImportText(Buffer.from(bytes))).toThrow('IMPORT_TEXT_ENCODING_UNSUPPORTED')
  })
})
