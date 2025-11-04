import React, { useEffect, useRef, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { logout, uploadWithProgress } from '../lib/api'
import Toast from '../components/Toast'


export default function Home() {
  const nav = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const MAX_FILES = 10

  // 自定义上传队列
  type QueueItem = {
    id: string
    file: File
    preview: string
    progress: number
    status: 'idle' | 'uploading' | 'done' | 'error'
    xhr?: XMLHttpRequest
    timer?: number
    target?: number
    error?: string
    resultUrl?: string
  }
  const [queue, setQueue] = useState<QueueItem[]>([])
  const hasActiveUpload = queue.some(it => it.status === 'uploading')
  const hasError = queue.some(it => it.status === 'error')
  
  // 计算整体进度
  const overallProgress = queue.length > 0 ? 
    queue.reduce((sum, item) => sum + (item.progress || 0), 0) / queue.length : 0
  


  // 内部导航拦截：捕获文档中的 a 链接点击，上传中给出确认
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (!hasActiveUpload) return
      const target = e.target as HTMLElement | null
      if (!target) return
      const a = target.closest('a') as HTMLAnchorElement | null
      if (!a) return
      const href = a.getAttribute('href') || ''
      // 忽略锚点/空链接
      if (!href || href.startsWith('#')) return
      // 仅拦截同源内部导航（包含 react-router 的 <Link> 渲染）
      if (a.origin === window.location.origin) {
        e.preventDefault()
        const ok = window.confirm('当前正在上传，离开本页可能导致状态不一致，确定要离开吗？')
        if (ok) window.location.href = a.href
      }
    }
    document.addEventListener('click', handleClick, true)
    return () => document.removeEventListener('click', handleClick, true)
  }, [hasActiveUpload])

  // 剪贴板粘贴上传
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      // 如果正在上传，忽略粘贴
      if (hasActiveUpload) return
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      // 遍历剪贴板项
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        // 检查是否为图片或视频文件
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }

      if (files.length > 0) {
        e.preventDefault()
        enqueueAndUpload(files)
        enqueueToast(`已从剪贴板粘贴 ${files.length} 个文件`, 'info')
      }
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [hasActiveUpload])

  // 刷新/关闭拦截（外部导航）
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasActiveUpload) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasActiveUpload])

  const startBatchUpload = (items: QueueItem[]) => {
    if (!items.length) return
    const ids = new Set(items.map(i => i.id))
    // 标记为上传中
    setQueue(prev => prev.map(i => ids.has(i.id) ? { ...i, status: 'uploading', progress: 0, target: 5 } : i))
    
    // 平滑缓动：每 120ms 将 progress 向 target 缓慢逼近；同时 target 若较低，缓慢抬升至 60%
    const interval = window.setInterval(() => {
      setQueue(prev => prev.map(it => {
        if (!ids.has(it.id)) return it
        const curTarget = Math.max(it.target ?? 0, Math.min(60, (it.target ?? 0) + 1))
        const diff = curTarget - (it.progress ?? 0)
        if (diff > 0) {
          const step = Math.max(1, Math.ceil(diff * 0.12))
          return { ...it, target: curTarget, progress: Math.min(curTarget, (it.progress ?? 0) + step) }
        }
        return { ...it, target: curTarget }
      }))
    }, 120)
    // 记录 timer 到该批次的每个条目
    setQueue(prev => prev.map(it => ids.has(it.id) ? { ...it, timer: interval } : it))


    // 使用 uploadWithProgress 方法
    const files = items.map(item => item.file)
    uploadWithProgress(files, (progress) => {
      const percent = Math.round(progress.percent)
      setQueue(prev => prev.map(it => ids.has(it.id) ? { ...it, target: Math.min(percent, 80) } : it))
    }).then((result) => {
      const urls: string[] = Array.isArray(result?.urls) ? result.urls : (result?.url ? [result.url] : [])
      // 构建 id -> 完整 URL 映射
      const urlMap = new Map<string, string>()
      items.forEach((it, idx) => {
        const u = urls[idx] || urls[0] || ''
        const full = u ? (u.startsWith('http') ? u : `${location.origin}${u}`) : ''
        if (full) urlMap.set(it.id, full)
      })
      // 写回每个条目的完成状态与 resultUrl
      setQueue(prev => prev.map(it => ids.has(it.id)
        ? { ...it, target: 100, status: 'done', resultUrl: urlMap.get(it.id) || it.resultUrl }
        : it
      ))
      // 停止进度动画
      window.clearInterval(interval)
    }).catch((error) => {
      window.clearInterval(interval)
      setQueue(prev => prev.map(it => ids.has(it.id) ? { ...it, status: 'error', timer: undefined, error: error.message || '上传失败' } : it))
      enqueueToast(`上传失败：${error.message || '未知错误'}，请重新选择文件再试`, 'error')
    })
  }

  const enqueueAndUpload = (files: File[]) => {
    if (!files.length) return
    if (files.length > MAX_FILES) {
      enqueueToast(`一次最多选择 ${MAX_FILES} 个文件，请重新选择`, 'info')
      return
    }
    const items: QueueItem[] = files.map((f) => ({
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      file: f,
      preview: URL.createObjectURL(f),
      progress: 0,
      status: 'idle',
    }))
    setQueue(prev => [...prev, ...items])
    // 批量上传：单次请求携带多个文件，保持在同一消息
    startBatchUpload(items)
  }

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (hasActiveUpload) { e.target.value = ''; return }
    const files = e.target.files ? (Array.from(e.target.files as FileList) as File[]) : []
    enqueueAndUpload(files)
    // 重置 input，便于再次选择同一文件
    e.target.value = ''
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (hasActiveUpload) return
    const dt = e.dataTransfer
    const files = dt?.files ? (Array.from(dt.files as FileList) as File[]) : []
    enqueueAndUpload(files)
  }

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
  }

  // 清理已完成的本地预览（不动失败项，避免误删问题排查素材）
  const onBrowse = () => {
    if (!hasActiveUpload) {
      // 打开文件选择前，清空已完成与失败的缩略图，释放对象 URL
      setQueue(prev => {
        prev.forEach(it => {
          if (it.status === 'done' || it.status === 'error') {
            try { window.URL.revokeObjectURL(it.preview) } catch {}
          }
        })
        return prev.filter(it => it.status !== 'done' && it.status !== 'error')
      })
      inputRef.current?.click()
    }
  }
  const onDropzoneClick = () => { if (!hasActiveUpload) onBrowse() }
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type?: 'info' | 'success' | 'error' }>>([])
  const enqueueToast = (message: string, type?: 'info' | 'success' | 'error') => {
    setToasts(prev => [...prev, { id: Date.now() + Math.random(), message, type }])
  }

  const doLogout = async () => {
    await logout()
    nav('/login', { replace: true })
  }

  // 复制链接到剪贴板
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      enqueueToast('链接已复制', 'success')
    })
  }
  
  // 复制所有成功上传的 URL
  const copyAllUrls = () => {
    const urls = queue
      .filter(item => item.status === 'done' && item.resultUrl)
      .map(item => item.resultUrl)
      .filter(Boolean) as string[]
      
    if (urls.length === 0) {
      enqueueToast('没有可复制的链接', 'info')
      return
    }
    
    navigator.clipboard.writeText(JSON.stringify(urls, null, 2)).then(() => {
      enqueueToast(`已复制 ${urls.length} 个链接`, 'success')
    })
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {toasts.length > 0 && toasts.map((t, idx) => (
        <Toast
          key={t.id}
          message={t.message}
          type={t.type}
          index={idx}
          onClose={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
        />
      ))}
      {/* 浮动操作区：历史图片 / 退出登录 */}
      <div className="fixed top-4 right-4 z-40">
        <div className="flex items-center gap-2 bg-white/80 backdrop-blur border border-gray-200 rounded-full px-2 py-1 shadow-sm">
          <Link
            to="/gallery"
            aria-label="历史图片"
            className="inline-flex items-center justify-center h-8 w-8 rounded-full hover:bg-gray-50 text-gray-700"
            title="历史图片"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
              <rect x="3" y="5" width="18" height="14" rx="2" ry="2"></rect>
              <path d="M3 15l5-4 5 4 8-6" strokeLinecap="round" strokeLinejoin="round"></path>
              <circle cx="8.5" cy="9" r="1.25"></circle>
            </svg>
          </Link>
          <button
            onClick={doLogout}
            aria-label="退出登录"
            title="退出登录"
            className="inline-flex items-center justify-center h-8 w-8 rounded-full text-gray-700 hover:bg-gray-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
              <path d="M9 4h-3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" strokeLinecap="round" strokeLinejoin="round"></path>
              <path d="M16 7l5 5-5 5" strokeLinecap="round" strokeLinejoin="round"></path>
              <path d="M21 12H9" strokeLinecap="round" strokeLinejoin="round"></path>
            </svg>
          </button>
        </div>
      </div>

      <main className="max-w-5xl mx-auto px-5 min-h-svh flex flex-col items-center justify-center py-8">
        <div className="w-full max-w-3xl mx-auto">
          {hasError && !hasActiveUpload && (
            <div className="mb-3 flex items-center justify-between w-full text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              <div className="truncate pr-2">存在文件上传失败，请重新选择文件后再试</div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onBrowse() }}
                className="shrink-0 h-7 px-2 inline-flex items-center justify-center rounded bg-red-600 text-white hover:bg-red-700"
              >
                重新选择
              </button>
            </div>
          )}
          <div
            className={`relative rounded-2xl p-12 sm:p-14 md:p-16 bg-white shadow-sm transition flex flex-col gap-6 items-center justify-center min-h-[50vh] sm:min-h-[55vh] overflow-hidden ${
              hasActiveUpload ? 'border-0' : 'border-2 border-dashed border-gray-300 hover:border-indigo-400'
            }`}
            style={hasActiveUpload ? {
              border: '3px solid transparent',
              background: `
                linear-gradient(white, white) padding-box,
                linear-gradient(
                  to top,
                  #6366f1 0%,
                  #6366f1 ${overallProgress}%,
                  #e5e7eb ${overallProgress}%,
                  #e5e7eb 100%
                ) border-box
              `
            } : {}}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onClick={onDropzoneClick}
          >
            {/* 波浪效果的 SVG - 仅在上传中显示 */}
            {hasActiveUpload && (
              <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none">
                <svg
                  className="absolute bottom-0 left-0 w-full"
                  style={{ height: `${overallProgress}%` }}
                  viewBox="0 0 400 100"
                  preserveAspectRatio="none"
                >
                  <defs>
                    <linearGradient id="waveGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="rgba(99, 102, 241, 0.3)" />
                      <stop offset="100%" stopColor="rgba(99, 102, 241, 0.1)" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M0,50 Q100,30 200,50 T400,50 L400,100 L0,100 Z"
                    fill="url(#waveGradient)"
                  >
                    <animate
                      attributeName="d"
                      values="M0,50 Q100,30 200,50 T400,50 L400,100 L0,100 Z;
                               M0,50 Q100,70 200,50 T400,50 L400,100 L0,100 Z;
                               M0,50 Q100,30 200,50 T400,50 L400,100 L0,100 Z"
                      dur="3s"
                      repeatCount="indefinite"
                    />
                  </path>
                </svg>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={onInputChange}
            />
            {/* 空状态：居中提示，点击任意处打开选择 */}
            {queue.length === 0 && (
              <div className="text-center select-none text-gray-600">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto h-10 w-10 text-gray-300 mb-3">
                  <path d="M12 16V4m0 0l-3.5 3.5M12 4l3.5 3.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <rect x="3" y="14" width="18" height="6" rx="2" className="stroke-current"/>
                </svg>
                <div className="text-lg sm:text-xl font-medium">点击或拖拽到此处上传</div>
              </div>
            )}
            {queue.length > 0 && (
              <>
                <div className={`w-full mt-[-20px] ${
                  queue.length <= 4 
                    ? 'flex flex-wrap justify-center gap-4' 
                    : 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 justify-items-center'
                }`}>
                  {queue.map(item => (
                    <div key={item.id} className="group relative w-[120px] h-[120px] rounded-lg overflow-hidden bg-gray-100 shadow-inner">
                      <img src={item.preview} alt={item.file.name} className="w-full h-full object-cover" />

                      {/* 底部文件名条：提高辨识度 */}
                      <div className="absolute left-0 right-0 bottom-0 bg-black/45 text-white text-[11px] leading-tight px-1.5 py-0.5 truncate pointer-events-none">
                        {item.file.name}
                      </div>

                      {/* 上传中显示半透明遮罩 */}
                      {item.status === 'uploading' && (
                        <div className="absolute inset-0 bg-black/20 backdrop-blur-[1px] rounded-lg flex items-center justify-center">
                          <div className="w-6 h-6 border-2 border-white/60 border-t-white rounded-full animate-spin"></div>
                        </div>
                      )}

                      {/* 完成后的复制链接按钮（存在 resultUrl 时显示） */}
                      {item.status === 'done' && item.resultUrl && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); copyToClipboard(item.resultUrl!) }}
                          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-6 px-2 inline-flex items-center justify-center text-[11px] whitespace-nowrap rounded-full bg-indigo-600 text-white/95 shadow hover:bg-indigo-700"
                          title="复制直链"
                        >
                          复制链接
                        </button>
                      )}

                      {/* 状态角标：错误与成功均位于右上，但图标不同 */}
                      {item.status === 'error' && (
                        <div className="absolute top-1 right-1 h-4 w-4 inline-flex items-center justify-center rounded-full bg-rose-500 text-white">
                          <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-3 w-3">
                            <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                      )}
                      {item.status === 'done' && (
                        <div className="absolute top-1 right-1 h-4 w-4 inline-flex items-center justify-center rounded-full bg-emerald-500 text-white">
                          <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-3 w-3">
                            <path d="M5 10l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                
                {/* 复制全部按钮 */}
                {!hasActiveUpload && queue.some(item => item.status === 'done' && item.resultUrl) && (
                  <div className="absolute bottom-6 left-0 right-0 flex justify-center">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); copyAllUrls(); }}
                      className="h-8 px-3 inline-flex items-center justify-center rounded bg-indigo-500 text-white shadow hover:bg-indigo-600 text-xs font-medium"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 mr-1">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      复制全部
                    </button>
                  </div>
                )}
              </>
            )}

            {/* 浮动 + 按钮：仅在存在队列且非上传中显示 */}
            {!hasActiveUpload && queue.length > 0 && (
              <button
                type="button"
                aria-label="选择文件"
                onClick={(e) => { e.stopPropagation(); onBrowse() }}
                className="absolute top-3 right-3 h-9 w-9 inline-flex items-center justify-center rounded-full bg-indigo-500 text-white shadow hover:bg-indigo-600"
                title="选择文件"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                  <path d="M12 5v14M5 12h14" strokeLinecap="round"/>
                </svg>
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
