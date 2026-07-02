import { useEffect, useState } from 'react'
import { AccountsPage } from './pages/AccountsPage'
import { PostLibraryPage } from './pages/PostLibraryPage'
import { PostingPage } from './pages/PostingPage'
import { CampaignPage } from './pages/CampaignPage'
import { ReportsPage } from './pages/ReportsPage'
import { SettingsPage } from './pages/SettingsPage'
import { GroupsPage } from './pages/GroupsPage'

type TabId = 'accounts' | 'groups' | 'library' | 'posting' | 'campaign' | 'reports' | 'settings'

const TABS: { id: TabId; label: string }[] = [
  { id: 'accounts', label: 'Tài khoản' },
  { id: 'groups', label: 'Nhóm' },
  { id: 'library', label: 'Thư viện bài' },
  { id: 'posting', label: 'Đăng bài' },
  { id: 'campaign', label: 'Chiến dịch' },
  { id: 'reports', label: 'Báo cáo' },
  { id: 'settings', label: 'Cài đặt' }
]

export function App() {
  const [tab, setTab] = useState<TabId>('accounts')
  const [info, setInfo] = useState<string>('')

  useEffect(() => {
    window.api
      .appInfo()
      .then((i) => setInfo(`${i.name} v${i.version} · schema v${i.schemaVersion}`))
      .catch((e) => setInfo(`Lỗi DB/IPC: ${String(e)}`))
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 16px', borderBottom: '1px solid #ddd' }}>
        <strong>FB Auto-Post</strong>
        <nav style={{ display: 'flex', gap: 4 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '6px 12px',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                background: tab === t.id ? '#1877f2' : 'transparent',
                color: tab === t.id ? '#fff' : '#333'
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#888' }}>{info}</span>
      </header>

      <main style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {tab === 'accounts' && <AccountsPage />}
        {tab === 'groups' && <GroupsPage />}
        {tab === 'library' && <PostLibraryPage />}
        {tab === 'posting' && <PostingPage />}
        {tab === 'campaign' && <CampaignPage />}
        {tab === 'reports' && <ReportsPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
