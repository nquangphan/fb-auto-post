// Central Vietnamese display labels for backend codes shown in the UI.

const STATUS_LABEL: Record<string, string> = {
  pending: 'chờ',
  running: 'đang chạy',
  success: 'thành công',
  unconfirmed: 'chưa xác nhận',
  failed: 'thất bại',
  skipped: 'bỏ qua'
}

const REASON_LABEL: Record<string, string> = {
  NOT_A_MEMBER: 'Chưa là thành viên nhóm',
  GROUP_UNAVAILABLE: 'Nhóm không truy cập được',
  COMPOSER_NOT_FOUND: 'Không mở được ô soạn bài',
  COMPOSER_TIMEOUT: 'Ô soạn bài quá hạn chờ',
  IMAGE_REJECTED: 'Ảnh bị từ chối',
  UPLOAD_INCOMPLETE: 'Ảnh tải lên chưa xong',
  UPLOAD_TIMEOUT: 'Tải ảnh quá hạn chờ',
  POST_NOT_READY: 'Bài chưa sẵn sàng (nút Đăng chưa bật — ảnh/nội dung chưa xong)',
  DUPLICATE_BLOCKED: 'Bị chặn do trùng nội dung',
  RATE_LIMITED: 'Bị giới hạn tần suất',
  CHECKPOINT: 'Dính checkpoint',
  LIMITED: 'Tài khoản bị hạn chế',
  BANNED: 'Tài khoản bị khóa',
  NEEDS_LOGIN: 'Cần đăng nhập',
  UNKNOWN: 'Lỗi không xác định',
  POST_REMOVED: 'Bài bị gỡ ngay sau khi đăng',
  CONTEXT_LAUNCH_FAILED: 'Không mở được trình duyệt',
  interrupted: 'Bị gián đoạn (mất điện/treo)',
  'already-posted': 'Đã đăng trước đó',
  cancelled: 'Đã hủy'
}

export const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status

export const reasonLabel = (reason: string | null): string =>
  reason == null ? '—' : (REASON_LABEL[reason] ?? reason)

export const STATUS_COLOR: Record<string, string> = {
  pending: '#888',
  running: '#0969da',
  success: '#1a7f37',
  unconfirmed: '#bf8700',
  failed: '#cf222e',
  skipped: '#888'
}
