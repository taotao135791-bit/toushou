import { useEffect, useRef, useState } from 'react'

/**
 * 主题右键「跟随系统」的仪式层（用户逐帧口述的分镜，rAF 逐帧驱动）：
 * 1. 一条渐变发光的竖线从中心弹性劈出（贯穿窗口）；
 * 2. 线的一侧渐变出黑色；
 * 3. 黑白收拢成圆并开始旋转——旋转中分界线逐渐弯成 S 曲线，太极自然成形；
 * 4. 目标色（当前时段应选的颜色）的鱼转到上方；
 * 5. 上方鱼眼圆形扩展铺满全屏（真实切换藏在扩展之下），淡出露出新界面。
 * 全程弹性缓动（duang 感 = 回弹 overshoot），reduced-motion 直接瞬切。
 */
const SEQ = {
  line: 280, // 竖线弹性劈出
  black: 320, // 一侧渐变出黑
  shrink: 220, // 收拢成圆
  spin: 780, // 旋转两圈 + 分界弯成 S（太极成形，目标鱼停在上）
  flood: 430, // 上方鱼眼扩展铺满（真实切换在开始时）
  fade: 320 // 淡出露界面
}
const FLOOD_AT = SEQ.line + SEQ.black + SEQ.shrink + SEQ.spin

/** S 分界路径插值：b=0 竖直直线，b=1 太极的标准 S（两段贝塞尔）。 */
function boundaryPath(b: number): string {
  const c1x = 100 + b * 48
  const c2x = 100 - b * 48
  return `M100 6 C ${c1x} 30, ${c1x} 74, 100 100 C ${c2x} 126, ${c2x} 170, 100 194`
}

/** 回弹缓动（duang）：先冲过头再弹回。 */
function easeDuang(t: number): number {
  if (t >= 1) return 1
  const c = 1.7
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
}
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export default function TaijiOverlay({
  targetDark,
  onMid,
  onDone
}: {
  targetDark: boolean
  onMid: () => void
  onDone: () => void
}) {
  const [gone, setGone] = useState(false)
  const [flood, setFlood] = useState(false)
  const [fading, setFading] = useState(false)
  const lineRef = useRef<HTMLDivElement>(null)
  const blackHalfRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const boundaryRef = useRef<SVGPathElement>(null)
  const boundaryGlowRef = useRef<SVGPathElement>(null)

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      onMid()
      setGone(true)
      return
    }
    // 里程碑：太极成形后扩展铺满（此刻真实切换），铺满后淡出。
    setTimeout(() => {
      setFlood(true)
      onMid()
    }, FLOOD_AT)
    setTimeout(() => setFading(true), FLOOD_AT + SEQ.flood)
    setTimeout(() => {
      setGone(true)
      onDone()
    }, FLOOD_AT + SEQ.flood + SEQ.fade + 150)
    // 逐帧：竖线劈出、半黑渐入、收拢、旋转、分界弯成 S。
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = now - t0
      if (lineRef.current) {
        const p = Math.min(1, Math.max(0, t / SEQ.line))
        lineRef.current.style.transform = `scaleY(${easeDuang(p)})`
        lineRef.current.style.opacity = String(p)
      }
      if (blackHalfRef.current) {
        const p = Math.min(1, Math.max(0, (t - SEQ.line) / SEQ.black))
        blackHalfRef.current.style.opacity = String(easeOut(p))
      }
      const shrinkStart = SEQ.line + SEQ.black
      if (stageRef.current) {
        const p = Math.min(1, Math.max(0, (t - shrinkStart) / SEQ.shrink))
        stageRef.current.style.opacity = String(easeOut(p))
        // 收拢感：圆从稍大（0.9）弹到最终尺寸（1），配合 duang。
        stageRef.current.style.scale = `${0.9 + 0.1 * easeDuang(p)}`
      }
      const spinStart = shrinkStart + SEQ.shrink
      if (boundaryRef.current && boundaryGlowRef.current && stageRef.current) {
        const p = Math.min(1, Math.max(0, (t - spinStart) / SEQ.spin))
        const eased = easeOut(p)
        // 黑鱼初始在左（0°）。目标在上：dark→黑转 -90°（左→上）；light→黑转
        // +90°（黑到下，白鱼在上）。各叠 720° 整圈保持"转起来"的仪式感。
        const quarter = targetDark ? -90 : 90
        const angle = 720 * eased + quarter * eased
        stageRef.current.style.rotate = `${angle}deg`
        const d = boundaryPath(eased)
        boundaryRef.current.setAttribute('d', d)
        boundaryGlowRef.current.setAttribute('d', d)
      }
      if (t >= FLOOD_AT) {
        // 扩展铺满后停止逐帧（太极已停在最终姿态）。
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (gone) return null
  const darkFill = 'rgb(18 18 20)'
  const lightFill = targetDark ? 'rgb(250 249 248)' : 'rgb(235 234 231)'
  const floodColor = targetDark ? darkFill : lightFill

  return (
    <div className="fixed inset-0 z-[90]" aria-hidden="true">
      {/* 全屏底：一侧渐变出黑的画布 */}
      <div
        ref={blackHalfRef}
        className="absolute inset-0"
        style={{
          opacity: 0,
          background: 'linear-gradient(90deg, rgb(18 18 20) 0%, rgb(18 18 20) 46%, transparent 54%)'
        }}
      />
      {/* 中央舞台：收拢的圆 + 旋转的太极（独立 transform 属性互不覆盖） */}
      <div
        ref={stageRef}
        className="absolute left-1/2 top-1/2"
        style={{
          width: 'min(78vmin, 560px)',
          height: 'min(78vmin, 560px)',
          translate: '-50% -50%',
          opacity: 0,
          transformOrigin: 'center'
        }}
      >
        <svg viewBox="0 0 200 200" width="100%" height="100%" style={{ filter: 'drop-shadow(0 0 30px rgb(0 0 0 / 0.5))' }}>
          <circle cx="100" cy="100" r="97" fill={lightFill} stroke="rgb(0 0 0 / 0.2)" strokeWidth="1.5" />
          {/* 黑鱼：分界（直线→S 插值） + 外圆左弧闭合。初始分界=竖直直径。 */}
          <path
            ref={boundaryRef}
            d={`${boundaryPath(0)} A 97 97 0 0 1 100 6 Z`}
            fill={darkFill}
          />
          {/* 两颗鱼眼：上方=目标鱼的余色眼，右侧=黑鱼的余色眼 */}
          <circle cx="100" cy="53" r="15" fill={targetDark ? lightFill : darkFill} />
          <circle cx="149" cy="100" r="15" fill={lightFill} />
        </svg>
        {/* 渐变发光的分界线（直线阶段压在分界上，随插值一起弯成 S） */}
        <svg viewBox="0 0 200 200" width="100%" height="100%" className="pointer-events-none absolute inset-0">
          <path
            ref={boundaryGlowRef}
            d={boundaryPath(0)}
            fill="none"
            stroke="rgb(255 255 255 / 0.75)"
            strokeWidth="1.2"
            style={{ filter: 'drop-shadow(0 0 6px rgb(255 255 255 / 0.5))' }}
          />
        </svg>
      </div>
      {/* 目标色扩展铺满（从上部鱼眼扩散）+ 完成后淡出 */}
      <div
        className="absolute inset-0"
        style={{
          background: floodColor,
          clipPath: flood ? 'circle(150% at 50% 18%)' : 'circle(0% at 50% 18%)',
          opacity: fading ? 0 : 1,
          transition: `clip-path ${SEQ.flood}ms var(--ease-out), opacity ${SEQ.fade}ms ease`
        }}
      />
    </div>
  )
}
