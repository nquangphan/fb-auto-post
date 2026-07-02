import { useEffect, useState } from 'react'
import type { PostSummaryDTO } from '@shared/ipc'

interface EditorState {
  id: number | null
  title: string
  bodyText: string
  existingImageCount: number // ảnh đã lưu (giữ lại trừ khi thay)
  newImagePaths: string[] // đường dẫn ảnh mới chọn trong phiên này
  replaceImages: boolean // true khi người dùng đổi ảnh
}

const EMPTY: EditorState = {
  id: null,
  title: '',
  bodyText: '',
  existingImageCount: 0,
  newImagePaths: [],
  replaceImages: true // bài mới luôn ghi bộ ảnh của nó
}

// Phase 4: soạn + lưu bài (text + ảnh). Ảnh được tiến trình chính copy vào thư mục
// nội dung. Thumbnail tạm hoãn (hiển thị file cục bộ cần protocol riêng do CSP).
export function PostLibraryPage() {
  const [posts, setPosts] = useState<PostSummaryDTO[]>([])
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [err, setErr] = useState('')

  function refresh() {
    window.api.listPosts().then(setPosts).catch((e) => setErr(String(e)))
  }
  useEffect(refresh, [])

  async function openForEdit(id: number) {
    setErr('')
    const post = await window.api.getPost(id)
    if (!post) return
    setEditor({
      id: post.id,
      title: post.title,
      bodyText: post.bodyText,
      existingImageCount: post.images.length,
      newImagePaths: [],
      replaceImages: false // sửa text thì giữ ảnh cũ
    })
  }

  async function pickNewImages() {
    if (!editor) return
    const picked = await window.api.pickImages()
    if (picked.length) {
      setEditor({
        ...editor,
        newImagePaths: [...editor.newImagePaths, ...picked],
        replaceImages: true
      })
    }
  }

  function clearImages() {
    if (!editor) return
    setEditor({ ...editor, newImagePaths: [], replaceImages: true, existingImageCount: 0 })
  }

  async function save() {
    if (!editor) return
    setErr('')
    try {
      const input = {
        title: editor.title,
        bodyText: editor.bodyText,
        imagePaths: editor.newImagePaths,
        replaceImages: editor.replaceImages
      }
      if (editor.id === null) await window.api.createPost(input)
      else await window.api.updatePost(editor.id, input)
      setEditor(null)
      refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function remove(id: number) {
    if (!confirm('Xóa bài này và ảnh của nó?')) return
    setErr('')
    try {
      await window.api.removePost(id)
      refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ flex: 1 }}>Thư viện bài</h2>
        <button onClick={() => setEditor({ ...EMPTY })}>+ Bài mới</button>
      </div>
      {err && <p style={{ color: '#cf222e' }}>{err}</p>}

      {editor && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, margin: '8px 0' }}>
          <strong>{editor.id === null ? 'Bài mới' : `Sửa bài #${editor.id}`}</strong>
          <input
            placeholder="Tiêu đề"
            value={editor.title}
            onChange={(e) => setEditor({ ...editor, title: e.target.value })}
            style={{ display: 'block', width: '100%', padding: 6, margin: '8px 0' }}
          />
          <textarea
            placeholder="Nội dung bài…"
            value={editor.bodyText}
            onChange={(e) => setEditor({ ...editor, bodyText: e.target.value })}
            rows={6}
            style={{ display: 'block', width: '100%', padding: 6 }}
          />
          <div style={{ margin: '8px 0' }}>
            <button onClick={pickNewImages}>Thêm ảnh…</button>{' '}
            <span style={{ color: '#888', fontSize: 12 }}>
              {editor.replaceImages
                ? `${editor.newImagePaths.length} ảnh sẽ được lưu`
                : `Giữ ${editor.existingImageCount} ảnh hiện có`}
            </span>
            <ul style={{ fontSize: 12, color: '#888' }}>
              {editor.newImagePaths.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
            {(editor.newImagePaths.length > 0 || editor.existingImageCount > 0) && (
              <button onClick={clearImages}>Xóa hết ảnh</button>
            )}
          </div>
          <button onClick={save}>Lưu</button> <button onClick={() => setEditor(null)}>Hủy</button>
        </div>
      )}

      {posts.length === 0 ? (
        <p style={{ color: '#888' }}>Chưa có bài nào.</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
              <th style={{ padding: 6 }}>Tiêu đề</th>
              <th style={{ padding: 6 }}>Ảnh</th>
              <th style={{ padding: 6 }}>Cập nhật</th>
              <th style={{ padding: 6 }}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: 6 }}>{p.title}</td>
                <td style={{ padding: 6 }}>{p.imageCount}</td>
                <td style={{ padding: 6, color: '#888' }}>{p.updatedAt}</td>
                <td style={{ padding: 6, display: 'flex', gap: 6 }}>
                  <button onClick={() => openForEdit(p.id)}>Sửa</button>
                  <button onClick={() => remove(p.id)} style={{ color: '#cf222e' }}>
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
