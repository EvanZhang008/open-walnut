/** The file types Walnut's notes keep beside a note (what the vault serves and shows). */
export const ATTACHMENT_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'])

export function isAttachmentPath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') && ATTACHMENT_EXTS.has(path.slice(dot + 1).toLowerCase())
}
