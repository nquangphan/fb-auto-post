import { useEffect, useState } from 'react'

export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [status, setStatus] = useState('')

  function load() {
    window.api.getSettings().then(setSettings)
  }
  useEffect(load, [])

  async function toggle(key: string, on: boolean) {
    setStatus('')
    try {
      await window.api.setSetting(key, on ? 'true' : 'false')
      load()
    } catch (e) {
      setStatus(String(e))
    }
  }

  const isOn = (key: string) => settings[key] !== 'false'

  return (
    <section>
      <h2>Cài đặt</h2>

      <h3 style={{ marginBottom: 4 }}>Chống ban</h3>
      <label style={{ display: 'block', marginBottom: 6 }}>
        <input type="checkbox" checked={isOn('spinEnabled')} onChange={(e) => toggle('spinEnabled', e.target.checked)} />{' '}
        Đổi nhẹ nội dung theo từng nhóm (xoay emoji/thứ tự hashtag; không sửa thông tin)
      </label>
      <label style={{ display: 'block', marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={isOn('recheckFirstPost')}
          onChange={(e) => toggle('recheckFirstPost', e.target.checked)}
        />{' '}
        Kiểm tra lại bài đầu tiên của mỗi tài khoản còn sống (phát hiện TK bị hạn chế)
      </label>
      {status && <p style={{ color: '#cf222e' }}>{status}</p>}

      <h3 style={{ marginBottom: 4 }}>Lưu trữ</h3>
      <div style={{ marginBottom: 8 }}>
        <strong>Thư mục nội dung</strong> <span style={{ color: '#888' }}>(do ứng dụng quản lý, cố định)</span>
        <div style={{ fontFamily: 'monospace', fontSize: 12, padding: 6, background: '#f5f5f5', borderRadius: 4 }}>
          {settings.contentFolder ?? '—'}
        </div>
      </div>

      <h3 style={{ marginBottom: 4 }}>Nhật ký (log)</h3>
      <p style={{ color: '#888', fontSize: 13, marginTop: 0 }}>
        Mọi hành vi (đăng nhập, đăng bài, lịch) được ghi vào file theo ngày. Khi gặp lỗi, mở thư mục
        này và gửi file log mới nhất để được hỗ trợ.
      </p>
      <button onClick={() => window.api.openLogFolder()} style={{ marginBottom: 12 }}>
        Mở thư mục log
      </button>

      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', color: '#888' }}>Tất cả cài đặt (debug)</summary>
        <pre style={{ fontSize: 12 }}>{JSON.stringify(settings, null, 2)}</pre>
      </details>
    </section>
  )
}
