import { useEffect, useState } from 'react'

/**
 * 主题右键「跟随系统」的仪式层（用户点名的分镜）：
 * 1. 窗口从中间一分为二，如摩西劈开红海（左右两扇"旧色"门板向两侧滑开）；
 * 2. 缝隙中央阴阳太极隐隐浮现并旋转；
 * 3. 太极上半鱼（= 当前时段应选的颜色）从鱼身扩展铺满全屏，完成切换；
 * 4. 新色淡出，露出已切换好的界面。
 * onMid 在太极转到正面时调用（真实主题切换藏在这一刻的扩展层之下）。
 * reduced-motion 时不渲染仪式层。
 */
const SEQ = { doors: 380, taiji: 760, flood: 420, fade: 320 }

export default function TaijiOverlay({
  targetDark,
  onMid,
  onDone
}: {
  x?: number
  targetDark: boolean
  onMid: () => void
  onDone: () => void
}) {
  const [phase, setPhase] = useState<'doors' | 'taiji' | 'flood' | 'fade' | 'gone'>('doors')
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      onMid()
      setPhase('gone')
      return
    }
    const timers = [
      setTimeout(() => setPhase('taiji'), SEQ.doors),
      setTimeout(() => { setPhase('flood'); onMid() }, SEQ.doors + SEQ.taiji),
      setTimeout(() => setPhase('fade'), SEQ.doors + SEQ.taiji + SEQ.flood),
      setTimeout(() => { setPhase('gone'); onDone() }, SEQ.doors + SEQ.taiji + SEQ.flood + SEQ.fade)
    ]
    return () => timers.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (phase === 'gone') return null
  const newFill = targetDark ? 'rgb(20 20 22)' : 'rgb(250 249 248)'
  const oldFill = targetDark ? 'rgb(250 249 248)' : 'rgb(20 20 22)'
  const doorsOpen = phase !== 'doors'
  return (
    <div className="fixed inset-0 z-[90]" aria-hidden="true">
      {/* 两扇"旧色"门板：从中间缝向两侧滑开 */}
      <div
        className="absolute inset-y-0 left-0 w-1/2"
        style={{
          background: oldFill,
          transform: doorsOpen ? 'translateX(-100%)' : 'translateX(0)',
          transition: `transform ${SEQ.doors}ms var(--ease-in-out)`,
          boxShadow: '2px 0 24px rgb(0 0 0 / 0.35)'
        }}
      />
      <div
        className="absolute inset-y-0 right-0 w-1/2"
        style={{
          background: oldFill,
          transform: doorsOpen ? 'translateX(100%)' : 'translateX(0)',
          transition: `transform ${SEQ.doors}ms var(--ease-in-out)`,
          boxShadow: '-2px 0 24px rgb(0 0 0 / 0.35)'
        }}
      />
      {/* 缝隙中浮现并旋转的阴阳太极 */}
      {(phase === 'taiji' || phase === 'flood') && (
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{
            width: 'min(44vmin, 420px)',
            height: 'min(44vmin, 420px)',
            opacity: phase === 'taiji' ? undefined : 0,
            transition: `opacity ${SEQ.flood}ms ease`
          }}
        >
          <svg
            viewBox="0 0 200 200"
            width="100%"
            height="100%"
            style={{ animation: `taiji-spin ${SEQ.taiji}ms ease-in-out both`, filter: 'drop-shadow(0 0 24px rgb(0 0 0 / 0.45))' }}
          >
            <circle cx="100" cy="100" r="98" fill={oldFill} stroke="rgb(0 0 0 / 0.2)" strokeWidth="1.5" />
            <path d="M100 2 A98 98 0 0 1 100 198 A49 49 0 0 1 100 100 A49 49 0 0 0 100 2 Z" fill="rgb(18 18 20)" />
            <circle cx="100" cy="51" r="16" fill={oldFill} />
            <circle cx="100" cy="149" r="16" fill="rgb(18 18 20)" />
            <circle cx="100" cy="51" r="6" fill="rgb(18 18 20)" />
            <circle cx="100" cy="149" r="6" fill={oldFill} />
          </svg>
        </div>
      )}
      {/* 上半鱼 = 当前时段应选的颜色：从屏幕上部圆形扩展铺满 */}
      <div
        className="absolute inset-0"
        style={{
          background: newFill,
          clipPath: phase === 'flood' || phase === 'fade' ? 'circle(150% at 50% 12%)' : 'circle(0% at 50% 12%)',
          transition: `clip-path ${SEQ.flood}ms var(--ease-out)`,
          opacity: phase === 'fade' ? 0 : 1,
          transitionProperty: 'clip-path, opacity',
          transitionDelay: phase === 'fade' ? '120ms' : '0ms'
        }}
      />
    </div>
  )
}
