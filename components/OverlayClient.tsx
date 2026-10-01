'use client'

import type { StreamElement, SyncState } from '@/lib/types'
import { useEffect, useRef, useState } from 'react'
import { toEmbedUrl } from '@/lib/embed'
import { parseMediaUrl, youtubeEmbedUrl, loadTwitchSdk } from '@/lib/media'
import { playFinishSound } from '@/lib/sound'
import { noteServerClock, serverClockLag } from '@/lib/clock'
import { io as ioInit } from 'socket.io-client'

// медиа-плееры оверлея: YouTube — iframe + postMessage, Twitch — SDK-плеер.
// Панель управляет ими командами element:command (плей/пауза/перемотка/звук/субтитры)
const ytFrames = new Map<string, HTMLIFrameElement>()
const twitchPlayers = new Map<string, any>()
const twitchSt = new Map<string, number>() // 1 играет / 2 пауза (из событий SDK)
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
	// YouTube-элементы, которые реально заиграли: до этого поверх iframe своя
	// заставка (нативный постер YouTube с кнопками в стриме показывать нельзя)
	const [ytStarted, setYtStarted] = useState<Set<string>>(new Set())
	const markYtStarted = (id: string) =>
		setYtStarted(prev => {
			if (prev.has(id)) return prev
			const s = new Set(prev)
			s.add(id)
			return s
		})

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
		// команды медиа-плееру из панели: YouTube — postMessage, Twitch — SDK
		socket.on('element:command', ({ id, cmd, value }: { id: string; cmd: string; value?: number }) => {
			const yf = ytFrames.get(id)
			if (yf?.contentWindow) {
				// handshake перед командой: команды до готовности API плеер молча игнорирует
				yf.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*')
				const post = (func: string, args: any[] = []) =>
					yf.contentWindow!.postMessage(JSON.stringify({ event: 'command', func, args }), '*')
				if (cmd === 'play') post('playVideo')
				else if (cmd === 'pause') post('pauseVideo')
				else if (cmd === 'volume') post('setVolume', [value ?? 100])
				else if (cmd === 'mute') post('mute')
				else if (cmd === 'unmute') post('unMute')
				else if (cmd === 'cc') post(value ? 'loadModule' : 'unloadModule', ['captions'])
				else if (cmd === 'seek') {
					// целевая позиция из превью: подтягиваемся при расхождении > 2с —
					// даже на паузе; незапущенный плеер не трогаем (seek до старта его клинит)
					seekTargets.set(id, value ?? 0)
					const cur = playerTimes.get(id)
					const started = !!cur && (cur.st === 1 || cur.st === 2 || cur.st === 3)
					if (started && cur && Math.abs(cur.t - (value ?? 0)) > 2) {
						post('seekTo', [value ?? 0, true])
						playerTimes.set(id, { t: value ?? 0, st: cur.st })
					}
				}
			}
			const tp = twitchPlayers.get(id)
			if (tp) {
				try {
					if (cmd === 'play') tp.play()
					else if (cmd === 'pause') tp.pause()
					else if (cmd === 'volume') tp.setVolume((value ?? 100) / 100)
					else if (cmd === 'mute') tp.mute?.()
					else if (cmd === 'unmute') tp.unmute?.()
					else if (cmd === 'seek') {
						seekTargets.set(id, value ?? 0)
						const st = twitchSt.get(id)
						const cur = playerTimes.get(id)
						if (st === 1 && cur && Math.abs(cur.t - (value ?? 0)) > 2) tp.seek(value ?? 0)
					}
				} catch {}
			}
		})
		socket.on('canvas:resize', (dims: { w: number; h: number }) =>
			setState(p => ({ ...p, canvasW: dims.w, canvasH: dims.h })),
		)
		// панель с выбранным играющим элементом отдаст play/seek/субтитры
		socket.on('connect', () => socket.emit('overlay:hello'))
		return () => {
			socket.disconnect()
		}
	}, [])

	// отчёты YouTube-плееров: позиция/состояние; при дрейфе от превью > 2с — перемотка
	useEffect(() => {
		const onMsg = (e: MessageEvent) => {
			let id: string | null = null
			for (const [key, f] of ytFrames) if (f.contentWindow === e.source) { id = key; break }
			if (!id) return
			try {
				const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
				// initialDelivery несёт duration/playerState, infoDelivery — позицию
				if (!d || (d.event !== 'infoDelivery' && d.event !== 'initialDelivery') || !d.info) return
				const t = d.info.currentTime ?? playerTimes.get(id)?.t
				const st = d.info.playerState ?? playerTimes.get(id)?.st ?? 0
				if (t !== undefined) playerTimes.set(id, { t, st })
				if (st === 1 || t > 0.5) markYtStarted(id)
				const target = seekTargets.get(id)
				if (t !== undefined && target !== undefined && st === 1 && Math.abs(t - target) > 2) {
					ytFrames.get(id)?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [target, true] }), '*')
				}
			} catch {}
		}
		window.addEventListener('message', onMsg)
		// handshake: без него YouTube не присылает infoDelivery
		const hs = setInterval(() => {
			for (const f of ytFrames.values()) {
				f.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*')
			}
		}, 5000)
		return () => { window.removeEventListener('message', onMsg); clearInterval(hs) }
	}, [])

	// опрос Twitch-плееров: позиция для дрейф-коррекции
	useEffect(() => {
		const i = setInterval(() => {
			for (const [id, p] of twitchPlayers) {
				try {
					const t = p.getCurrentTime?.()
					if (typeof t !== 'number') continue
					const st = twitchSt.get(id) ?? 0
					playerTimes.set(id, { t, st })
					const target = seekTargets.get(id)
					if (st === 1 && target !== undefined && Math.abs(t - target) > 2) p.seek(target)
				} catch {}
			}
		}, 1000)
		return () => clearInterval(i)
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
				{sorted.map(el =>
					el.visible || el.alwaysLoaded ? (
						<OverlayElement key={el.id} el={el} ytStarted={ytStarted.has(el.id)} />
					) : null,
				)}
			</div>
		</div>
	)
}

function OverlayElement({ el, ytStarted }: { el: StreamElement; ytStarted: boolean }) {
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
	if (el.type === 'iframe') {
		const info = parseMediaUrl(el.src || '')
		if (info?.kind === 'youtube')
			return (
				<div style={style}>
					<iframe
						src={youtubeEmbedUrl(info.id, window.location.origin)}
						title='media'
						ref={f => {
							if (f) ytFrames.set(el.id, f)
							else ytFrames.delete(el.id)
						}}
						style={{ width: '100%', height: '100%', border: 'none' }}
						allow='autoplay; encrypted-media; picture-in-picture'
					/>
					{!ytStarted && (
						<div style={{ position: 'absolute', inset: 0, background: '#000', overflow: 'hidden' }}>
							<img
								src={`https://i.ytimg.com/vi/${info.id}/maxresdefault.jpg`}
								onError={e => {
									const img = e.currentTarget
									if (!img.dataset.fallback) {
										img.dataset.fallback = '1'
										img.src = `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`
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
		if (info) return (
			<div style={style}>
				<TwitchOverlayFrame el={el} />
			</div>
		)
		return (
			<div style={style}>
				<iframe
					src={toEmbedUrl(el.src || '')}
					title='embed'
					style={{ width: '100%', height: '100%', border: 'none' }}
					allow='autoplay; encrypted-media; picture-in-picture; fullscreen'
					allowFullScreen
				/>
			</div>
		)
	}
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

// SDK-плеер Twitch на оверлее: чистый кадр (без родных контролов с мышью — их нет),
// управляется командами из панели
function TwitchOverlayFrame({ el }: { el: StreamElement }) {
	const ref = useRef<HTMLDivElement | null>(null)
	useEffect(() => {
		let cancelled = false
		const divId = 'twitchov-' + el.id
		;(async () => {
			try {
				const Tw = await loadTwitchSdk()
				if (cancelled || !ref.current) return
				const info = parseMediaUrl(el.src || '')
				if (!info || info.kind === 'youtube') return
				ref.current.id = divId
				const opts: any = { parent: location.hostname, width: '100%', height: '100%', autoplay: false, muted: true }
				if (info.kind === 'twitch-channel') opts.channel = info.channel
				else if (info.kind === 'twitch-vod') opts.video = info.id
				else if (info.kind === 'twitch-clip') opts.clip = info.slug
				const p = new Tw.Player(divId, opts)
				twitchPlayers.set(el.id, p)
				p.addEventListener(Tw.Player.PLAY, () => twitchSt.set(el.id, 1))
				p.addEventListener(Tw.Player.PAUSE, () => twitchSt.set(el.id, 2))
			} catch {}
		})()
		return () => {
			cancelled = true
			twitchPlayers.delete(el.id)
			twitchSt.delete(el.id)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [el.id, el.src])
	return <div ref={ref} style={{ width: '100%', height: '100%', pointerEvents: 'none' }} />
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60)
	const s = seconds % 60
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
