import { useEffect, useMemo, useState } from 'react'
import type { AccountStateRow } from '@shared/account-state'
import type { AttemptDTO, GroupDTO, PostSummaryDTO, SlotDTO } from '@shared/ipc'
import { stateLabel } from '../components/AccountStateBadge'
import { STATUS_COLOR, statusLabel, reasonLabel } from '../labels'

// `unconfirmed` cố ý KHÔNG cho thử lại: bài có thể đã lên, và bộ chống trùng cũng
// sẽ bỏ qua khi đăng lại — đăng lại dễ gây trùng (tín hiệu ban) (Red Team H-1 / C3).
const RETRYABLE = new Set(['failed', 'skipped'])

export function PostingPage() {
  const [posts, setPosts] = useState<PostSummaryDTO[]>([])
  const [accounts, setAccounts] = useState<AccountStateRow[]>([])
  const [groups, setGroups] = useState<GroupDTO[]>([])
  const [postId, setPostId] = useState<number | null>(null)
  const [accIds, setAccIds] = useState<Set<number>>(new Set())
  const [grpIds, setGrpIds] = useState<Set<number>>(new Set())
  const [attempts, setAttempts] = useState<Map<number, AttemptDTO>>(new Map())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [scheduleAt, setScheduleAt] = useState('')
  const [slots, setSlots] = useState<SlotDTO[]>([])

  function loadSlots() {
    window.api.listSlots().then(setSlots).catch(() => undefined)
  }
  useEffect(loadSlots, [])

  useEffect(() => {
    Promise.all([window.api.listPosts(), window.api.listAccountStates(), window.api.listGroups()])
      .then(([p, a, g]) => {
        setPosts(p)
        setAccounts(a)
        setGroups(g)
        setPostId(p[0]?.id ?? null)
        setAccIds(new Set(a.map((x) => x.id))) // mặc định: tất cả
        setGrpIds(new Set(g.map((x) => x.id)))
      })
      .catch((e) => setErr(String(e)))

    const unsub = window.api.onPostingProgress((row) =>
      setAttempts((prev) => new Map(prev).set(row.id, row))
    )
    return unsub
  }, [])

  const rows = useMemo(() => [...attempts.values()].sort((a, b) => a.id - b.id), [attempts])

  function toggle(set: Set<number>, id: number, setter: (s: Set<number>) => void) {
    const next = new Set(set)
    next.has(id) ? next.delete(id) : next.add(id)
    setter(next)
  }

  async function post() {
    if (postId === null || accIds.size === 0 || grpIds.size === 0) {
      setErr('Chọn một bài, ít nhất một tài khoản và một nhóm.')
      return
    }
    setErr('')
    setBusy(true)
    setAttempts(new Map())
    try {
      await window.api.runBatch({
        postId,
        accountIds: [...accIds],
        groupIds: [...grpIds]
      })
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function retry(id: number) {
    try {
      await window.api.retryAttempt(id)
    } catch (e) {
      setErr(String(e))
    }
  }

  async function schedule() {
    if (postId === null || accIds.size === 0 || grpIds.size === 0 || !scheduleAt) {
      setErr('Chọn bài, tài khoản, nhóm và thời gian để hẹn lịch.')
      return
    }
    setErr('')
    try {
      // datetime-local là giờ địa phương; lưu dưới dạng UTC ISO.
      await window.api.createSlot({
        postId,
        accountIds: [...accIds],
        groupIds: [...grpIds],
        runAt: new Date(scheduleAt).toISOString()
      })
      setScheduleAt('')
      loadSlots()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function cancelSlot(id: number) {
    await window.api.cancelSlot(id)
    loadSlots()
  }

  return (
    <section>
      <h2>Đăng bài</h2>
      {err && <p style={{ color: '#cf222e' }}>{err}</p>}

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <label>
            <strong>Bài viết</strong>
            <select
              value={postId ?? ''}
              onChange={(e) => setPostId(Number(e.target.value))}
              style={{ display: 'block', padding: 6, marginTop: 4, minWidth: 200 }}
            >
              {posts.length === 0 && <option value="">Chưa có bài — hãy tạo trước</option>}
              {posts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.imageCount} ảnh)
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset style={{ border: '1px solid #ddd', borderRadius: 6 }}>
          <legend>Tài khoản ({accIds.size})</legend>
          {accounts.map((a) => (
            <label key={a.id} style={{ display: 'block', fontSize: 13 }}>
              <input type="checkbox" checked={accIds.has(a.id)} onChange={() => toggle(accIds, a.id, setAccIds)} />{' '}
              {a.username} <span style={{ color: '#888' }}>({stateLabel(a.state)})</span>
            </label>
          ))}
          {accounts.length === 0 && <span style={{ color: '#888' }}>Chưa có tài khoản</span>}
        </fieldset>

        <fieldset style={{ border: '1px solid #ddd', borderRadius: 6 }}>
          <legend>Nhóm ({grpIds.size})</legend>
          {groups.map((g) => (
            <label key={g.id} style={{ display: 'block', fontSize: 13 }}>
              <input type="checkbox" checked={grpIds.has(g.id)} onChange={() => toggle(grpIds, g.id, setGrpIds)} />{' '}
              {g.name}
            </label>
          ))}
          {groups.length === 0 && <span style={{ color: '#888' }}>Chưa có nhóm</span>}
        </fieldset>
      </div>

      <button onClick={post} disabled={busy} style={{ marginTop: 12, padding: '8px 20px' }}>
        {busy ? 'Đang đăng…' : 'Đăng ngay'}
      </button>
      {busy && (
        <button onClick={() => window.api.cancelOps()} style={{ marginLeft: 8, padding: '8px 16px', color: '#cf222e' }}>
          Dừng
        </button>
      )}
      <p style={{ color: '#888', fontSize: 12 }}>
        Kiểm tra đăng nhập trước, rồi đăng tuần tự có giãn cách ngẫu nhiên.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
        <strong style={{ fontSize: 13 }}>Hoặc hẹn lịch:</strong>
        <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
        <button onClick={schedule} disabled={busy}>
          Hẹn lịch
        </button>
        <span style={{ color: '#888', fontSize: 12 }}>(bật bộ hẹn lịch ở Cài đặt → Tự động đăng)</span>
      </div>

      {slots.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <strong style={{ fontSize: 13 }}>Lịch sắp tới</strong>
          <ul style={{ listStyle: 'none', paddingLeft: 0, fontSize: 13 }}>
            {slots.map((s) => (
              <li key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                <span>{new Date(s.runAt).toLocaleString('vi-VN')}</span>
                <span style={{ color: '#888' }}>
                  bài #{s.postId} · {s.accountIds.length} TK × {s.groupIds.length} nhóm · {s.status}
                </span>
                <button onClick={() => cancelSlot(s.id)}>Hủy</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
              <th style={{ padding: 6 }}>Tài khoản</th>
              <th style={{ padding: 6 }}>Nhóm</th>
              <th style={{ padding: 6 }}>Trạng thái</th>
              <th style={{ padding: 6 }}>Lý do</th>
              <th style={{ padding: 6 }}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: 6 }}>{r.username}</td>
                <td style={{ padding: 6 }}>{r.groupName}</td>
                <td style={{ padding: 6, color: STATUS_COLOR[r.status] ?? '#888' }}>
                  {statusLabel(r.status)}
                  {r.attemptNo > 1 ? ` (lần ${r.attemptNo})` : ''}
                </td>
                <td style={{ padding: 6, color: '#888', fontSize: 12 }}>{reasonLabel(r.failureReason)}</td>
                <td style={{ padding: 6 }}>
                  {RETRYABLE.has(r.status) && (
                    <button onClick={() => retry(r.id)} disabled={busy}>
                      Thử lại
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
