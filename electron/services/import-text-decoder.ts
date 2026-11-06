/**
 * 解码用户导入的小说文本：优先遵守 BOM，否则尝试 UTF-8 和兼容 GBK 的 GB18030。
 * 仅用于外部小说导入；严格拒绝损坏字节与二进制控制字符，不改变项目文件的 UTF-8 约定。
 */
export function decodeImportText(bytes: Uint8Array): string {
  const hasBom = (prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const encoding = hasBom([0xef, 0xbb, 0xbf]) ? 'utf-8'
    : hasBom([0xff, 0xfe]) ? 'utf-16le'
      : hasBom([0xfe, 0xff]) ? 'utf-16be' : undefined

  // 明确声明的编码不能在损坏后回退，避免把损坏的 Unicode 文本误读成另一种编码。
  for (const candidate of encoding ? [encoding] : ['utf-8', 'gb18030']) {
    let text: string
    try {
      text = new TextDecoder(candidate, { fatal: true }).decode(bytes)
    } catch {
      continue
    }
    // 此处有意检测控制字符；保留正文可用的制表、换行、换页与回车。
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) break
    return text
  }
  throw new Error('IMPORT_TEXT_ENCODING_UNSUPPORTED')
}
