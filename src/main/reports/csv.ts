/** Serialize an array of flat objects to CSV (RFC-4180-ish quoting). */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const escape = (v: unknown): string => {
    let s = v == null ? '' : String(v)
    // Neutralize spreadsheet formula injection: a leading =, +, -, @ can execute
    // when the CSV is opened in Excel/Sheets. Prefix with a single quote.
    if (/^[=+\-@]/.test(s)) s = `'${s}`
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(','))
  return lines.join('\n')
}
