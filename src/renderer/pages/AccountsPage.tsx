import { useEffect, useState } from 'react'
import type { AccountStateRow } from '@shared/account-state'
import type { AccountCreateDTO } from '@shared/ipc'
import { AccountStateBadge } from '../components/AccountStateBadge'

interface FormState {
  id: number | null // null = creating
  username: string
  password: string
  proxy: string
}

const EMPTY_FORM: FormState = { id: null, username: '', password: '', proxy: '' }

export function AccountsPage() {
  const [rows, setRows] = useState<AccountStateRow[]>([])
  const [form, setForm] = useState<FormState | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [challenge, setChallenge] = useState('')

  function refresh() {
    window.api.listAccountStates().then(setRows).catch((e) => setErr(String(e)))
  }
  useEffect(() => {
    refresh()
    const unsub = window.api.onLoginChallenge((info) =>
      setChallenge(`Tài khoản "${info.username}" cần bạn xử lý: ${info.kind} — một cửa sổ trình duyệt đã mở.`)
    )
    return unsub
  }, [])

  async function withBusy(fn: () => Promise<unknown>) {
    setBusy(true)
    setErr('')
    try {
      await fn()
      refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveForm() {
    if (!form) return
    const proxy = form.proxy.trim() || null
    if (form.id === null) {
      const input: AccountCreateDTO = { username: form.username, password: form.password, proxy }
      await withBusy(() => window.api.createAccount(input))
    } else {
      await withBusy(() =>
        window.api.updateAccount(form.id!, {
          username: form.username,
          password: form.password || undefined, // để trống = giữ mật khẩu cũ
          proxy
        })
      )
    }
    setForm(null)
  }

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ flex: 1 }}>Tài khoản</h2>
        <button onClick={() => setForm({ ...EMPTY_FORM })} disabled={busy}>
          + Thêm tài khoản
        </button>
        <button onClick={() => withBusy(() => window.api.healthCheckAll())} disabled={busy}>
          {busy ? 'Đang xử lý…' : 'Kiểm tra đăng nhập'}
        </button>
        {busy && (
          <button onClick={() => window.api.cancelOps()} style={{ color: '#cf222e' }}>
            Dừng
          </button>
        )}
      </div>

      {challenge && <p style={{ color: '#bf8700' }}>{challenge}</p>}
      {err && <p style={{ color: '#cf222e' }}>{err}</p>}

      {form && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, margin: '8px 0' }}>
          <strong>{form.id === null ? 'Tài khoản mới' : `Sửa tài khoản #${form.id}`}</strong>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <input
              placeholder="Tên đăng nhập / email / SĐT"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              style={{ padding: 6 }}
            />
            <input
              placeholder={form.id === null ? 'Mật khẩu' : 'Mật khẩu mới (để trống = giữ nguyên)'}
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              style={{ padding: 6 }}
            />
            <input
              placeholder="Proxy (không bắt buộc)"
              value={form.proxy}
              onChange={(e) => setForm({ ...form, proxy: e.target.value })}
              style={{ padding: 6 }}
            />
            <button onClick={saveForm} disabled={busy}>
              Lưu
            </button>
            <button onClick={() => setForm(null)} disabled={busy}>
              Hủy
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p style={{ color: '#888' }}>Chưa có tài khoản nào. Bấm “Thêm tài khoản”.</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
              <th style={{ padding: 6 }}>Tên đăng nhập</th>
              <th style={{ padding: 6 }}>Trạng thái</th>
              <th style={{ padding: 6 }}>Kiểm tra lúc</th>
              <th style={{ padding: 6 }}>Kết quả gần nhất</th>
              <th style={{ padding: 6 }}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: 6 }}>{r.username}</td>
                <td style={{ padding: 6 }}>
                  <AccountStateBadge state={r.state} />
                </td>
                <td style={{ padding: 6 }}>{r.lastCheckedAt ?? '—'}</td>
                <td style={{ padding: 6, color: '#888' }}>{r.lastResult ?? '—'}</td>
                <td style={{ padding: 6, display: 'flex', gap: 6 }}>
                  <button onClick={() => withBusy(() => window.api.loginAccount(r.id))} disabled={busy}>
                    Đăng nhập
                  </button>
                  <button
                    onClick={() => {
                      setChallenge(
                        `Đã mở trình duyệt cho "${r.username}". Tự thao tác (vào group, giải checkpoint…) rồi ĐÓNG cửa sổ khi xong.`
                      )
                      withBusy(() => window.api.openBrowserSession(r.id))
                    }}
                    disabled={busy}
                  >
                    Mở trình duyệt
                  </button>
                  <button onClick={() => withBusy(() => window.api.healthCheckAccount(r.id))} disabled={busy}>
                    Kiểm tra
                  </button>
                  <button
                    onClick={() => setForm({ id: r.id, username: r.username, password: '', proxy: '' })}
                    disabled={busy}
                  >
                    Sửa
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Xóa tài khoản "${r.username}" và hồ sơ trình duyệt của nó?`)) {
                        withBusy(() => window.api.removeAccount(r.id))
                      }
                    }}
                    disabled={busy}
                    style={{ color: '#cf222e' }}
                  >
                    Xóa
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
