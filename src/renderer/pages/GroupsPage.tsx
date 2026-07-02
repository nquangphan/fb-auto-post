import { useEffect, useState } from 'react'
import type { GroupDTO } from '@shared/ipc'

interface EditState {
  id: number
  name: string
  url: string
}

// Quản lý Nhóm (Red Team H14): repository + IPC từ Phase 1; đây là UI quản lý ở Phase 3.
export function GroupsPage() {
  const [groups, setGroups] = useState<GroupDTO[]>([])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [edit, setEdit] = useState<EditState | null>(null)
  const [err, setErr] = useState('')

  async function refresh() {
    setGroups(await window.api.listGroups())
  }
  useEffect(() => {
    refresh().catch((e) => setErr(String(e)))
  }, [])

  async function run(fn: () => Promise<unknown>) {
    setErr('')
    try {
      await fn()
      await refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <section>
      <h2>Nhóm</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input placeholder="Tên nhóm" value={name} onChange={(e) => setName(e.target.value)} style={{ padding: 6 }} />
        <input
          placeholder="https://facebook.com/groups/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ padding: 6, flex: 1 }}
        />
        <button
          onClick={() =>
            run(async () => {
              await window.api.createGroup({ name, url })
              setName('')
              setUrl('')
            })
          }
        >
          Thêm
        </button>
      </div>
      {err && <p style={{ color: '#cf222e' }}>{err}</p>}

      <ul style={{ paddingLeft: 0, listStyle: 'none' }}>
        {groups.map((g) => (
          <li key={g.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
            {edit?.id === g.id ? (
              <>
                <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} style={{ padding: 4 }} />
                <input value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} style={{ padding: 4, flex: 1 }} />
                <button
                  onClick={() =>
                    run(async () => {
                      await window.api.updateGroup(g.id, { name: edit.name, url: edit.url })
                      setEdit(null)
                    })
                  }
                >
                  Lưu
                </button>
                <button onClick={() => setEdit(null)}>Hủy</button>
              </>
            ) : (
              <>
                <strong>{g.name}</strong>
                <span style={{ color: '#888', flex: 1, fontSize: 12 }}>{g.url}</span>
                <button onClick={() => setEdit({ id: g.id, name: g.name, url: g.url })}>Sửa</button>
                <button onClick={() => run(() => window.api.removeGroup(g.id))} style={{ color: '#cf222e' }}>
                  Xóa
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {groups.length === 0 && <p style={{ color: '#888' }}>Chưa có nhóm nào.</p>}
    </section>
  )
}
