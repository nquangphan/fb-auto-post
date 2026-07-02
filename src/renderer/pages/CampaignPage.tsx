import { useEffect, useState } from 'react'
import type { AccountStateRow } from '@shared/account-state'
import type { CampaignConfigDTO, CampaignProgressDTO, GroupDTO, PostSummaryDTO } from '@shared/ipc'
import { stateLabel } from '../components/AccountStateBadge'

/** Map a campaign row (slot + attempt) to a Vietnamese label + colour. */
function progressDisplay(r: CampaignProgressDTO): { text: string; color: string } {
  if (r.slotStatus === 'skipped') return { text: 'Đã hủy', color: '#888' }
  if (r.slotStatus === 'pending') return { text: 'Chờ đăng', color: '#9a6700' }
  if (r.slotStatus === 'running') return { text: 'Đang đăng…', color: '#0969da' }
  // done → reflect the attempt outcome
  switch (r.attemptStatus) {
    case 'success':
      return { text: 'Đã đăng', color: '#1a7f37' }
    case 'unconfirmed':
      return { text: 'Đã đăng (chưa xác nhận)', color: '#1a7f37' }
    case 'failed':
      return { text: `Lỗi${r.failureReason ? ' · ' + r.failureReason : ''}`, color: '#cf222e' }
    case 'skipped':
      return { text: `Bỏ qua${r.failureReason ? ' · ' + r.failureReason : ''}`, color: '#888' }
    default:
      return { text: 'Đã chạy', color: '#888' }
  }
}

const DEFAULT_CONFIG: CampaignConfigDTO = {
  accountGapMinutes: { min: 300, max: 360 },
  maxPostsPerAccountPerDay: 8,
  maxPostsPerGroupPerDay: 2
}

/**
 * Drip campaign: pick a pool of posts/groups/accounts and tunable timing, then
 * the planner spreads randomized single-post slots across today obeying the
 * per-account cooldown and per-(account,group) daily cap. Slots fire via the
 * existing scheduler. "Đăng ngay" remains on its own page.
 */
export function CampaignPage() {
  const [posts, setPosts] = useState<PostSummaryDTO[]>([])
  const [accounts, setAccounts] = useState<AccountStateRow[]>([])
  const [groups, setGroups] = useState<GroupDTO[]>([])
  const [postIds, setPostIds] = useState<Set<number>>(new Set())
  const [accIds, setAccIds] = useState<Set<number>>(new Set())
  const [grpIds, setGrpIds] = useState<Set<number>>(new Set())
  const [config, setConfig] = useState<CampaignConfigDTO>(DEFAULT_CONFIG)
  const [progress, setProgress] = useState<CampaignProgressDTO[]>([])
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  function loadProgress() {
    window.api.campaignProgress().then(setProgress).catch(() => undefined)
  }

  useEffect(() => {
    Promise.all([
      window.api.listPosts(),
      window.api.listAccountStates(),
      window.api.listGroups(),
      window.api.getCampaignConfig()
    ])
      .then(([p, a, g, cfg]) => {
        setPosts(p)
        setAccounts(a)
        setGroups(g)
        setPostIds(new Set(p.map((x) => x.id)))
        setAccIds(new Set(a.map((x) => x.id)))
        setGrpIds(new Set(g.map((x) => x.id)))
        if (cfg) setConfig(cfg)
      })
      .catch((e) => setErr(String(e)))
    loadProgress()
    // A posting cell finishing refreshes the timeline immediately; the interval
    // also catches slots leaving 'pending' as their run_at arrives.
    const unsub = window.api.onPostingProgress(() => loadProgress())
    const timer = window.setInterval(loadProgress, 5000)
    return () => {
      unsub()
      window.clearInterval(timer)
    }
  }, [])

  const pendingCount = progress.filter(
    (r) => r.slotStatus === 'pending' || r.slotStatus === 'running'
  ).length

  // Accounts that had at least one failed post today — candidates for a one-click
  // re-run (after their login/checkpoint is fixed). Scoped re-run leaves other
  // accounts' pending drips untouched.
  const failedAccountIds = [
    ...new Set(progress.filter((r) => r.attemptStatus === 'failed').map((r) => r.accountId))
  ]

  function toggle(set: Set<number>, id: number, setter: (s: Set<number>) => void) {
    const next = new Set(set)
    next.has(id) ? next.delete(id) : next.add(id)
    setter(next)
  }

  function setGap(bound: 'min' | 'max', value: number) {
    setConfig((c) => ({ ...c, accountGapMinutes: { ...c.accountGapMinutes, [bound]: value } }))
  }

  /** Shared campaign launch for a given set of accounts (full run or retry-failed). */
  async function submit(accountIds: number[]) {
    if (postIds.size === 0 || grpIds.size === 0) {
      setErr('Chọn ít nhất một bài và một nhóm.')
      return
    }
    if (config.accountGapMinutes.min > config.accountGapMinutes.max) {
      setErr('Khoảng thời gian không hợp lệ: giá trị nhỏ phải ≤ giá trị lớn.')
      return
    }
    setErr('')
    setMsg('')
    setBusy(true)
    try {
      const { scheduled } = await window.api.runCampaign({
        accountIds,
        postIds: [...postIds],
        groupIds: [...grpIds],
        config
      })
      setMsg(
        scheduled > 0
          ? `Đã lên lịch ${scheduled} lượt đăng cho hôm nay. Giữ app mở để bộ hẹn giờ tự chạy.`
          : 'Không lượt nào được lên lịch (mọi tài khoản còn trong thời gian chờ hoặc các nhóm đã đạt giới hạn hôm nay).'
      )
      loadProgress()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function run() {
    if (accIds.size === 0) {
      setErr('Chọn ít nhất một tài khoản.')
      return
    }
    await submit([...accIds])
  }

  /** Re-run only the accounts that failed today (scoped — others untouched). */
  async function retryFailed() {
    if (failedAccountIds.length === 0) return
    await submit(failedAccountIds)
  }

  async function stop() {
    setStopping(true)
    try {
      const { cancelled } = await window.api.stopCampaign()
      setMsg(`Đã dừng chiến dịch — hủy ${cancelled} lượt chưa đăng.`)
      loadProgress()
    } catch (e) {
      setErr(String(e))
    } finally {
      setStopping(false)
    }
  }

  const labelStyle = { display: 'block', fontSize: 13 } as const
  const numStyle = { width: 64, padding: 4 } as const

  return (
    <section>
      <h2>Chiến dịch (rải bài tự động)</h2>
      {err && <p style={{ color: '#cf222e' }}>{err}</p>}
      {msg && <p style={{ color: '#1a7f37' }}>{msg}</p>}

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <fieldset style={{ border: '1px solid #ddd', borderRadius: 6 }}>
          <legend>Pool bài ({postIds.size})</legend>
          {posts.map((p) => (
            <label key={p.id} style={labelStyle}>
              <input type="checkbox" checked={postIds.has(p.id)} onChange={() => toggle(postIds, p.id, setPostIds)} />{' '}
              {p.title} ({p.imageCount} ảnh)
            </label>
          ))}
          {posts.length === 0 && <span style={{ color: '#888' }}>Chưa có bài</span>}
        </fieldset>

        <fieldset style={{ border: '1px solid #ddd', borderRadius: 6 }}>
          <legend>Tài khoản ({accIds.size})</legend>
          {accounts.map((a) => (
            <label key={a.id} style={labelStyle}>
              <input type="checkbox" checked={accIds.has(a.id)} onChange={() => toggle(accIds, a.id, setAccIds)} />{' '}
              {a.username} <span style={{ color: '#888' }}>({stateLabel(a.state)})</span>
            </label>
          ))}
          {accounts.length === 0 && <span style={{ color: '#888' }}>Chưa có tài khoản</span>}
        </fieldset>

        <fieldset style={{ border: '1px solid #ddd', borderRadius: 6 }}>
          <legend>Pool nhóm ({grpIds.size})</legend>
          {groups.map((g) => (
            <label key={g.id} style={labelStyle}>
              <input type="checkbox" checked={grpIds.has(g.id)} onChange={() => toggle(grpIds, g.id, setGrpIds)} />{' '}
              {g.name}
            </label>
          ))}
          {groups.length === 0 && <span style={{ color: '#888' }}>Chưa có nhóm</span>}
        </fieldset>
      </div>

      <fieldset style={{ border: '1px solid #ddd', borderRadius: 6, marginTop: 16, maxWidth: 560 }}>
        <legend>Cấu hình (mọi mốc thời gian random trong khoảng)</legend>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span style={{ width: 300 }}>Khoảng cách giữa 2 bài đăng của 1 tài khoản (phút)</span>
          <input type="number" min={1} step="5" style={numStyle} value={config.accountGapMinutes.min}
            onChange={(e) => setGap('min', Number(e.target.value))} />
          <span>–</span>
          <input type="number" min={1} step="5" style={numStyle} value={config.accountGapMinutes.max}
            onChange={(e) => setGap('max', Number(e.target.value))} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span style={{ width: 300 }}>Số bài viết tối đa mỗi ngày (mỗi tài khoản)</span>
          <input type="number" min={1} step="1" style={numStyle} value={config.maxPostsPerAccountPerDay}
            onChange={(e) => setConfig((c) => ({ ...c, maxPostsPerAccountPerDay: Math.max(1, Math.floor(Number(e.target.value))) }))} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span style={{ width: 300 }}>Số bài viết trong 1 nhóm tối đa mỗi ngày (mỗi tài khoản)</span>
          <input type="number" min={1} step="1" style={numStyle} value={config.maxPostsPerGroupPerDay}
            onChange={(e) => setConfig((c) => ({ ...c, maxPostsPerGroupPerDay: Math.max(1, Math.floor(Number(e.target.value))) }))} />
        </div>
      </fieldset>

      <button onClick={run} disabled={busy} style={{ marginTop: 12, padding: '8px 20px' }}>
        {busy ? 'Đang lên lịch…' : 'Chạy chiến dịch'}
      </button>
      <p style={{ color: '#888', fontSize: 12 }}>
        Mỗi lượt: 1 tài khoản đủ điều kiện bốc ngẫu nhiên 1 bài trong pool, đăng vào 1 nhóm chưa
        đạt giới hạn. Lịch trải đến hết hôm nay — mai vào bấm lại cho ngày mới.
      </p>

      {progress.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <strong style={{ fontSize: 13 }}>
              Tiến độ chiến dịch hôm nay ({progress.length} lượt · {pendingCount} còn chờ)
            </strong>
            {pendingCount > 0 && (
              <button onClick={stop} disabled={stopping} style={{ padding: '4px 14px', color: '#cf222e' }}>
                {stopping ? 'Đang dừng…' : 'Dừng chiến dịch'}
              </button>
            )}
            {failedAccountIds.length > 0 && (
              <button
                onClick={retryFailed}
                disabled={busy}
                title="Lập lại lịch drip hôm nay cho các tài khoản bị lỗi (hãy sửa đăng nhập trước). Không ảnh hưởng tài khoản khác."
                style={{ padding: '4px 14px' }}
              >
                {busy ? 'Đang lên lịch…' : `Chạy lại cho TK lỗi (${failedAccountIds.length})`}
              </button>
            )}
          </div>
          <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 8, fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                <th style={{ padding: 6 }}>Giờ đăng</th>
                <th style={{ padding: 6 }}>Tài khoản</th>
                <th style={{ padding: 6 }}>Nhóm</th>
                <th style={{ padding: 6 }}>Bài</th>
                <th style={{ padding: 6 }}>Trạng thái</th>
                <th style={{ padding: 6 }}>Link</th>
              </tr>
            </thead>
            <tbody>
              {progress.map((r) => {
                const d = progressDisplay(r)
                return (
                  <tr key={r.slotId} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 6 }}>{new Date(r.runAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</td>
                    <td style={{ padding: 6 }}>{r.username}</td>
                    <td style={{ padding: 6 }}>{r.groupName}</td>
                    <td style={{ padding: 6, color: '#888' }}>#{r.postId}</td>
                    <td style={{ padding: 6, color: d.color }}>{d.text}</td>
                    <td style={{ padding: 6 }}>
                      {r.permalink ? (
                        <a href={r.permalink} target="_blank" rel="noreferrer">Mở</a>
                      ) : (
                        <span style={{ color: '#ccc' }}>—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
