import { useCallback, useEffect, useState } from 'react'
import type {
  AntiBanHealthDTO,
  BucketDTO,
  ContentRowDTO,
  OverviewDTO,
  SuccessFailureDTO,
  VolumeRowDTO
} from '@shared/ipc'
import { statusLabel, reasonLabel } from '../labels'
import { stateLabel } from '../components/AccountStateBadge'

type Tab = 'overview' | 'volume' | 'success' | 'antiban' | 'content'

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [from, setFrom] = useState(isoDaysAgo(30))
  const [to, setTo] = useState(isoDaysAgo(0))
  const [bucket, setBucket] = useState<BucketDTO>('day')
  const [err, setErr] = useState('')

  const [overview, setOverview] = useState<OverviewDTO | null>(null)
  const [volume, setVolume] = useState<VolumeRowDTO[]>([])
  const [sf, setSf] = useState<SuccessFailureDTO | null>(null)
  const [antiban, setAntiban] = useState<AntiBanHealthDTO | null>(null)
  const [content, setContent] = useState<ContentRowDTO[]>([])

  const load = useCallback(async () => {
    setErr('')
    const range = { from, to }
    try {
      const [o, v, s, a, c] = await Promise.all([
        window.api.reportOverview(range),
        window.api.reportVolume(range, bucket),
        window.api.reportSuccessFailure(range),
        window.api.reportAntiBan(),
        window.api.reportContent(range)
      ])
      setOverview(o)
      setVolume(v)
      setSf(s)
      setAntiban(a)
      setContent(c)
    } catch (e) {
      setErr(String(e))
    }
  }, [from, to, bucket])

  useEffect(() => {
    load()
  }, [load])

  async function exportCsv(name: string, rows: Record<string, unknown>[]) {
    if (rows.length === 0) return
    await window.api.exportCsv(name, rows)
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: '#8 Tổng quan' },
    { id: 'volume', label: '#1 Sản lượng' },
    { id: 'success', label: '#2 Thành công/Thất bại' },
    { id: 'antiban', label: '#5 Sức khỏe chống ban' },
    { id: 'content', label: '#6 Nội dung' }
  ]

  return (
    <section>
      <h2>Báo cáo</h2>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label>
          Từ <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Đến <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {tab === 'volume' && (
          <label>
            Theo{' '}
            <select value={bucket} onChange={(e) => setBucket(e.target.value as BucketDTO)}>
              <option value="day">Ngày</option>
              <option value="week">Tuần</option>
              <option value="month">Tháng</option>
            </select>
          </label>
        )}
        <button onClick={load}>Làm mới</button>
      </div>

      <nav style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{ padding: '4px 10px', background: tab === t.id ? '#1877f2' : 'transparent', color: tab === t.id ? '#fff' : '#333', border: 'none', borderRadius: 6 }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {err && <p style={{ color: '#cf222e' }}>{err}</p>}

      {tab === 'overview' && overview && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Tile label="Lượt đăng" value={overview.totalAttempts} />
          <Tile label="Thành công" value={overview.successes} />
          <Tile label="Thất bại" value={overview.failures} />
          <Tile label="Tỉ lệ thành công" value={`${overview.successRate}%`} />
          <Tile label="TK đang dùng" value={overview.activeAccounts} />
          <Tile label="Cần chú ý" value={overview.needAttention} />
        </div>
      )}

      {tab === 'volume' && (
        <Table
          name={`san-luong-${bucket}.csv`}
          rows={volume as unknown as Record<string, unknown>[]}
          columns={[
            { key: 'period', label: 'Kỳ' },
            { key: 'count', label: 'Số lượng' }
          ]}
          onExport={exportCsv}
        />
      )}

      {tab === 'success' && sf && (
        <>
          <p>{Object.entries(sf.totals).map(([k, v]) => `${statusLabel(k)}: ${v}`).join('  ·  ') || 'Không có dữ liệu'}</p>
          <Table
            name="that-bai-theo-ly-do.csv"
            rows={sf.byReason.map((r) => ({ reason: reasonLabel(r.reason), count: r.count })) as unknown as Record<string, unknown>[]}
            columns={[
              { key: 'reason', label: 'Lý do' },
              { key: 'count', label: 'Số lượng' }
            ]}
            onExport={exportCsv}
          />
        </>
      )}

      {tab === 'antiban' && antiban && (
        <>
          {antiban.linkageAlert && (
            <p style={{ color: '#cf222e', fontWeight: 'bold' }}>
              ⚠ Cảnh báo liên kết: 2+ tài khoản đang bị checkpoint/hạn chế/khóa. Cùng thiết bị + IP có thể đang bị
              Facebook liên kết — cân nhắc giảm tốc độ hoặc gán proxy.
            </p>
          )}
          <Table
            name="suc-khoe-chong-ban.csv"
            rows={
              antiban.accounts.map((a) => ({ ...a, state: stateLabel(a.state) })) as unknown as Record<
                string,
                unknown
              >[]
            }
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'username', label: 'Tên đăng nhập' },
              { key: 'state', label: 'Trạng thái' },
              { key: 'lastCheckedAt', label: 'Kiểm tra lúc' }
            ]}
            onExport={exportCsv}
          />
        </>
      )}

      {tab === 'content' && (
        <Table
          name="noi-dung.csv"
          rows={content as unknown as Record<string, unknown>[]}
          columns={[
            { key: 'postId', label: 'ID bài' },
            { key: 'title', label: 'Tiêu đề' },
            { key: 'attempts', label: 'Lượt đăng' },
            { key: 'successes', label: 'Thành công' }
          ]}
          onExport={exportCsv}
        />
      )}
    </section>
  )
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, minWidth: 120 }}>
      <div style={{ fontSize: 24, fontWeight: 'bold' }}>{value}</div>
      <div style={{ color: '#888', fontSize: 13 }}>{label}</div>
    </div>
  )
}

interface Column {
  key: string
  label: string
}

function Table({
  name,
  rows,
  columns,
  onExport
}: {
  name: string
  rows: Record<string, unknown>[]
  columns: Column[]
  onExport: (name: string, rows: Record<string, unknown>[]) => void
}) {
  return (
    <>
      <button onClick={() => onExport(name, rows)} disabled={rows.length === 0} style={{ marginBottom: 8 }}>
        Xuất CSV
      </button>
      {rows.length === 0 ? (
        <p style={{ color: '#888' }}>Không có dữ liệu trong khoảng này.</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
              {columns.map((c) => (
                <th key={c.key} style={{ padding: 6 }}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                {columns.map((c) => (
                  <td key={c.key} style={{ padding: 6 }}>
                    {String(r[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
