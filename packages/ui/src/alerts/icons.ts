/** GitHub Alerts 风格的容器图标。`currentColor`，颜色由侧边色条同一变量决定。 */
export const ALERT_TYPES = ['tip', 'quote', 'warning', 'danger', 'details'] as const

export type AlertType = (typeof ALERT_TYPES)[number]

const PATHS: Record<AlertType, string> = {
  tip: '<path fill="currentColor" d="M8 1.5a4.5 4.5 0 0 0-2.6 8.17c.3.22.5.5.55.84l.2 1.24h3.7l.2-1.24c.05-.34.25-.62.55-.84A4.5 4.5 0 0 0 8 1.5Zm1.9 11.25H6.1l.15.9c.05.3.3.5.6.5h1.5c.3 0 .55-.2.6-.5l.15-.9ZM8 0a6 6 0 0 1 3.5 10.87l-.35 2.1A2.1 2.1 0 0 1 9.1 15H6.9a2.1 2.1 0 0 1-2.05-1.53l-.35-2.1A6 6 0 0 1 8 0Z"/>',
  quote:
    '<path fill="currentColor" d="M13.01 14v4c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2v-6c0-1.1-.9-2-2-2h-2.85c.27-1.02 1.01-2.51 3.1-3.03l.76-.19V4h-1c-2.78 0-4.91.77-6.31 2.29c-1.89 2.05-1.7 4.68-1.69 4.71v3Zm3.18-6.37c.48-.52 1.11-.91 1.87-1.19c-1.56 1.42-2.04 3.4-2.04 4.56v1h5v6h-6v-7.08s-.12-1.9 1.18-3.29ZM1.01 18c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2v-6c0-1.1-.9-2-2-2H6.16c.27-1.02 1.01-2.51 3.1-3.03l.76-.19V4h-1c-2.78 0-4.91.77-6.31 2.29C.82 8.34 1.01 10.97 1.02 11v7Zm2-7.08s-.12-1.9 1.18-3.29c.48-.52 1.11-.91 1.87-1.19C4.5 7.86 4.02 9.84 4.02 11v1h5v6H3.01z"/>',
  warning:
    '<path fill="currentColor" d="M6.46 1.96a1.8 1.8 0 0 1 3.08 0l5.9 9.92A1.8 1.8 0 0 1 13.9 14.5H2.1a1.8 1.8 0 0 1-1.54-2.62l5.9-9.92ZM8 3.15 2.1 13h11.8L8 3.15Zm-.75 3.6a.75.75 0 0 1 1.5 0v2.5a.75.75 0 0 1-1.5 0V6.75Zm.75 5.5a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z"/>',
  danger:
    '<path fill="currentColor" d="M8 0 15.5 4.3v7.4L8 16 0.5 11.7V4.3L8 0Zm0 1.7L1.9 5.1v5.8L8 14.3l6.1-3.4V5.1L8 1.7ZM7.25 4.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0v-3.5Zm.75 6.5a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z"/>',
  details:
    '<path fill="currentColor" d="M2 3.75A.75.75 0 0 1 2.75 3h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 3.75ZM2 8a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8Zm.75 3.5h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5Z"/>'
}

export function isAlertType(name: string): name is AlertType {
  return (ALERT_TYPES as readonly string[]).includes(name)
}

export function alertIcon(name: string): string {
  const type = isAlertType(name) ? name : 'quote'
  const viewBox = type === 'quote' ? '0 0 24 24' : '0 0 16 16'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="16" height="16" aria-hidden="true">${PATHS[type]}</svg>`
}

export const ALERT_LABELS: Record<AlertType, string> = {
  tip: '提示',
  quote: '引用',
  warning: '警告',
  danger: '错误',
  details: '详情'
}
