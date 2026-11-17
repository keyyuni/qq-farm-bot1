/**
 * 通用文本复制工具（兼容移动端 / 非安全上下文）。
 *
 * 背景：navigator.clipboard.writeText 仅在 HTTPS 或 localhost 等安全上下文可用，
 * 移动端通过局域网 IP（http://192.168.x.x:port）访问面板时该 API 不存在，
 * 导致点击复制无反应。这里统一封装：优先用 Clipboard API，失败时回退到
 * execCommand，并针对 iOS Safari 做选区/focus 兼容处理。
 */

/** 复制纯文本到剪贴板，成功返回 true。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const value = String(text ?? '')
  if (!value)
    return false

  // 安全上下文（HTTPS / localhost）优先用现代 Clipboard API
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    }
    catch {
      // 继续走 execCommand 兜底
    }
  }

  // 兜底：HTTP 局域网 IP / 老浏览器。移动端 Safari 需要元素可编辑、
  // 先 focus 再 select，且元素需退出视口但保持可聚焦（不能用 display:none）。
  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.contentEditable = 'true'
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.width = '1px'
    textarea.style.height = '1px'
    textarea.style.opacity = '0'
    textarea.style.fontSize = '16px' // 防止 iOS 聚焦时自动缩放
    textarea.style.padding = '0'
    textarea.style.border = 'none'
    document.body.appendChild(textarea)

    // iOS 需要先 focus + setSelectionRange，再 execCommand
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, value.length)
    const copied = document.execCommand('copy')
    textarea.remove()
    return copied
  }
  catch {
    return false
  }
}
