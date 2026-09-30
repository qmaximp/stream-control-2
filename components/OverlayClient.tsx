'use client'

import type { StreamElement, SyncState } from '@/lib/types'
import { useEffect, useRef, useState } from 'react'
import { toEmbedUrl, withAutoplay, withMuted, withOrigin, withCleanPlayer, youtubeId } from '@/lib/embed'
import { playFinishSound } from '@/lib/sound'
import { noteServerClock, serverClockLag } from '@/lib/clock'
import { io as ioInit } from 'socket.io-client'

// iframe-плееры по id элемента: сюда приходят команды из панели
const iframeRefs = new Map<string, HTMLIFrameElement>()
const playerTimes = new Map<string, { t: number; st: number }>()
const seekTargets = new Map<string, number>()

export default function OverlayClient({ room }: { room?: string | null }) {
	const [state, setState] = useState<SyncState>({
		elements: [],
		canvasW: 1920,
		canvasH: 1080,
	})
	const [, force] = useState(0)
	const [scale, setScale] = useState(1)
	// YouTube-элементы, которые уже «живые» в этой сессии оверлея: пришла команда из панели
	// или плеер начал воспроизведение. Пока элемент не живой — поверх iframe чистая заставка
	// (нативный постер YouTube с кнопками в стриме показывать нельзя)
	const [ytLive, setYtLive] = useState<Set<string>>(new Set())
	const markYtLive = (id: string) =>
		setYtLive(prev => {
			if (prev.has(id)) return prev
			const s = new Set(prev)
			s.add(id)
			return s
		})
	// элементы, игравшие на момент сворачивания вкладки, — возобновляются при возврате
	const resumeRef = useRef<Set<string>>(new Set())

	useEffect(() => {
		const socket = ioInit({ transports: ['websocket', 'polling'], query: { room: room || 'default' } })
		socket.on('state:init', (s: SyncState) => setState(s))
		socket.on('element:added', (el: StreamElement) =>
			setState(p => ({ ...p, elements: [...p.elements, el] })),
		)
		socket.on('element:updated', (el: StreamElement) => {
			noteServerClock(el)
			setState(p => ({
				...p,
				elements: p.elements.map(e => (e.id === el.id ? { ...e, ...el } : e)),
			}))
		})
		socket.on('element:moved', (d: { id: string; x: number; y: number }) =>
			setState(p => ({
				...p,
				elements: p.elements.map(e =>
					e.id === d.id ? { ...e, x: d.x, y: d.y } : e,
				),
			})),
		)
		socket.on(
			'element:resized',
			(d: { id: string; x?: number; y?: number; width: number; height: number }) =>
				setState(p => ({
					...p,
					elements: p.elements.map(e =>
						e.id === d.id ? { ...e, x: d.x ?? e.x, y: d.y ?? e.y, width: d.width, height: d.height } : e,
					),
				})),
		)
		socket.on('element:deleted', (id: string) =>
			setState(p => ({ ...p, elements: p.elements.filter(e => e.id !== id) })),
		)
		socket.on('element:zorder', (ids: string[]) =>
			setState(p => {
				const z = new Map(ids.map((id, i) => [id, i]))
				return { ...p, elements: p.elements.map(e => ({ ...e, zIndex: z.get(e.id) ?? e.zIndex })) }
			}),
		)
		socket.on('elements:cleared', () => setState(p => ({ ...p, elements: [] })))
		// команды плееру из панели (пуск/пауза/громкость) — через YouTube postMessage API
		socket.on('element:command', ({ id, cmd, value }: { id: string; cmd: string; value?: number }) => {
			markYtLive(id)
			resumeRef.current.delete(id) // панель сама управляет этим элементом — не возобновлять по видимости вкладки
			if (cmd === 'time') {
				// целевая позиция из превью: подтягиваемся сразу при расхождении > 2с —
				// даже на паузе, иначе перемотка в панели не доезжает до оверлея
				seekTargets.set(id, value ?? 0)
				const f = iframeRefs.get(id)
				const cur = playerTimes.get(id)
				if (f?.contentWindow && cur && Math.abs(cur.t - (value ?? 0)) > 2) {
					f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [value ?? 0, true] }), '*')
					playerTimes.set(id, { t: value ?? 0, st: cur.st })
				}
				return
			}
			const f = iframeRefs.get(id)
			if (f?.contentWindow) {
				f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: cmd, args: value !== undefined ? [value] : [] }), '*')
			}
		})
		socket.on('canvas:resize', (dims: { w: number; h: number }) =>
			setState(p => ({ ...p, canvasW: dims.w, canvasH: dims.h })),
		)
		return () => {
			socket.disconnect()
		}
	}, [])

	// отчёты своих плееров: позиция/состояние; при дрейфе от превью > 2с — перемотка
	useEffect(() => {
		const onMsg = (e: MessageEvent) => {
			let id: string | null = null
			for (const [key, f] of iframeRefs) if (f.contentWindow === e.source) { id = key; break }
			if (!id) return
			try {
				const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
				if (!d || d.event !== 'infoDelivery' || !d.info) return
				const t = d.info.currentTime ?? playerTimes.get(id)?.t
				const st = d.info.playerState ?? playerTimes.get(id)?.st ?? 0
				if (t !== undefined) playerTimes.set(id, { t, st })
				if (st === 1 || t > 0.5) markYtLive(id)
				const target = seekTargets.get(id)
				if (t !== undefined && target !== undefined && st === 1 && Math.abs(t - target) > 2) {
					iframeRefs.get(id)?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [target, true] }), '*')
				}
			} catch {}
		}
		window.addEventListener('message', onMsg)
		const hs = setInterval(() => {
			for (const f of iframeRefs.values()) {
				f.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*')
			}
		}, 5000)
		return () => { window.removeEventListener('message', onMsg); clearInterval(hs) }
	}, [])

	// перерисовка нужна только пока идёт хотя бы один таймер
	const hasRunningTimer = state.elements.some(e => e.type === 'timer' && e.isRunning)
	useEffect(() => {
		if (!hasRunningTimer) return
		const i = setInterval(() => force(x => x + 1), 250)
		return () => clearInterval(i)
	}, [hasRunningTimer])

	useEffect(() => {
		const update = () => {
			const sw = window.innerWidth / state.canvasW
			const sh = window.innerHeight / state.canvasH
			setScale(Math.min(sw, sh))
		}
		update()
		window.addEventListener('resize', update)
		return () => window.removeEventListener('resize', update)
	}, [state.canvasW, state.canvasH])

	// браузер ставит плееры на паузу в скрытой вкладке — при возврате возобновляем игравшее
	useEffect(() => {
		const onVis = () => {
			if (document.hidden) {
				resumeRef.current = new Set()
				for (const [id, p] of playerTimes) if (p.st === 1) resumeRef.current.add(id)
			} else {
				for (const id of resumeRef.current)
					iframeRefs.get(id)?.contentWindow?.postMessage(
						JSON.stringify({ event: 'command', func: 'playVideo', args: [] }),
						'*',
					)
				resumeRef.current.clear()
			}
		}
		document.addEventListener('visibilitychange', onVis)
		return () => document.removeEventListener('visibilitychange', onVis)
	}, [])

	const sorted = [...state.elements].sort(
		(a, b) => (a.zIndex || 0) - (b.zIndex || 0),
	)

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				overflow: 'hidden',
				background: 'transparent',
			}}
		>
			<div
				style={{
					position: 'absolute',
					left: 0,
					top: 0,
					width: state.canvasW,
					height: state.canvasH,
					transform: `scale(${scale})`,
					transformOrigin: 'top left',
					overflow: 'hidden',
				}}
			>
				{sorted.map(el => {
					const vid = el.type === 'iframe' ? youtubeId(el.src || '') : ''
					const cover = !!vid && !el.autoplay && !ytLive.has(el.id)
					return el.visible || el.alwaysLoaded ? (
						<OverlayElement key={el.id} el={el} cover={cover} vid={vid} />
					) : null
				})}
			</div>
		</div>
	)
}

function OverlayElement({ el, cover, vid }: { el: StreamElement; cover?: boolean; vid?: string }) {
	const [, force] = useState(0)
	const playedRef = useRef(false)

	useEffect(() => {
		if (el.type !== 'timer' || !el.isRunning) return
		const i = setInterval(() => force(x => x + 1), 100)
		return () => clearInterval(i)
	}, [el.type, el.isRunning])

	const style: React.CSSProperties = {
		position: 'absolute',
		left: el.x,
		top: el.y,
		width: el.width,
		height: el.height,
		zIndex: el.zIndex,
		visibility: el.visible ? 'visible' : 'hidden',
		opacity: el.opacity ?? 1,
		transform: `${el.rotation ? `rotate(${el.rotation}deg)` : ''}${el.flipH || el.flipV ? ` scale(${el.flipH ? -1 : 1}, ${el.flipV ? -1 : 1})` : ''}` || undefined,
		transformOrigin: 'center',
	}

	if (el.type === 'image' || el.type === 'gif')
		return (
			<div style={style}>
				<img
					src={el.src}
					alt=''
					style={{ width: '100%', height: '100%', objectFit: 'fill' }}
					draggable={false}
				/>
			</div>
		)
	if (el.type === 'video')
		return (
			<div style={style}>
				<video
					src={el.src}
					style={{ width: '100%', height: '100%', objectFit: 'fill' }}
					autoPlay
					loop
					muted
					playsInline
				/>
			</div>
		)
	if (el.type === 'iframe')
		return (
			<div style={style}>
				<iframe
					src={withOrigin(withCleanPlayer(withMuted(withAutoplay(toEmbedUrl(el.src || ''), el.autoplay))))}
					title='embed'
					ref={(f) => {
						if (f) iframeRefs.set(el.id, f)
						else iframeRefs.delete(el.id)
					}}
					style={{ width: '100%', height: '100%', border: 'none' }}
					allow='autoplay; encrypted-media; picture-in-picture'
					allowFullScreen
				/>
				{cover && vid && (
					<div
						style={{ position: 'absolute', inset: 0, background: '#000', overflow: 'hidden' }}
					>
						<img
							src={`https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`}
							onError={(e) => {
								const img = e.currentTarget
								if (!img.dataset.fallback) {
									img.dataset.fallback = '1'
									img.src = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`
								}
							}}
							alt=''
							draggable={false}
							style={{ width: '100%', height: '100%', objectFit: 'cover' }}
						/>
					</div>
				)}
			</div>
		)
	if (el.type === 'text')
		return (
			<div
				style={{
					...style,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					fontSize: el.fontSize,
					color: el.color,
					fontWeight: el.fontWeight,
					background: el.bgColor === 'transparent' ? 'none' : el.bgColor,
					textAlign: 'center',
					overflow: 'hidden',
					wordBreak: 'break-word',
				}}
			>
				{el.text}
			</div>
		)
	if (el.type === 'timer') {
		const elapsedMs =
			el.isRunning && el.startTime
				? Math.max(0, Date.now() - serverClockLag.ms - el.startTime) // синхрон между устройствами с разошедшимися часами
				: (el.elapsed || 0)
		const elapsedSec = Math.floor(elapsedMs / 1000)
		const display =
			el.timerDirection === 'down' && el.duration
				? formatTime(Math.max(0, el.duration - elapsedSec))
				: formatTime(elapsedSec)
		// одиночный звуковой сигнал в момент, когда обратный отсчёт дошёл до нуля
		const remaining = el.timerDirection === 'down' && el.duration ? el.duration - elapsedSec : null
		if (remaining !== null && remaining <= 0) {
			if (el.isRunning && !playedRef.current) {
				playedRef.current = true
				playFinishSound()
			}
			if (!el.isRunning) playedRef.current = false
		} else {
			playedRef.current = false
		}
		return (
			<div
				style={{
					...style,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
				}}
			>
				{el.timerLabel && (
					<div
						style={{
							fontSize: (el.fontSize || 40) * 0.5,
							color: el.color,
							fontWeight: el.fontWeight,
							marginBottom: 4,
							background: el.bgColor === 'transparent' ? 'none' : el.bgColor,
							padding: '2px 8px',
							borderRadius: 4,
						}}
					>
						{el.timerLabel}
					</div>
				)}
				<div
					style={{
						fontSize: el.fontSize,
						color: el.color,
						fontWeight: el.fontWeight,
						background: el.bgColor === 'transparent' ? 'none' : el.bgColor,
						padding: '4px 12px',
						borderRadius: 6,
						fontFamily: 'monospace',
						letterSpacing: 2,
					}}
				>
					{display}
				</div>
			</div>
		)
	}
	return null
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60)
	const s = seconds % 60
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
