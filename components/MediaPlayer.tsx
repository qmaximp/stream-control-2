'use client'

// Медиа-элемент (YouTube / Twitch) в панели модератора: чистый кадр +
// своя панель управления (плей/пауза, перемотка, громкость, субтитры).
// Плашка прячется через 3с после ухода мыши. Любое взаимодействие с плашкой
// выбирает элемент — команды в оверлей уходят только от выбранного элемента.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { StreamElement } from '@/lib/types'
import { parseMediaUrl, loadTwitchSdk } from '@/lib/media'

export type MediaSt = {
	vid: string // ключ источника (youtube id / twitch ключ) — для сброса состояния при смене ссылки
	kind: 'youtube' | 'twitch'
	st: number // 1 играет, 2 пауза, 0 закончилось, -1 не запущено
	t: number
	dur: number
	muted: boolean
	vol: number
}

export type ChromeCtl = { note: () => void; enter: () => void; leave: () => void }

function fmtTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) seconds = 0
	const s = Math.floor(seconds)
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	const sec = s % 60
	const mm = String(m).padStart(2, '0')
	const ss = String(sec).padStart(2, '0')
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function MediaChrome({
	el,
	st,
	register,
	toggle,
	select,
	command,
}: {
	el: StreamElement
	st?: MediaSt
	register: (id: string, ctl: ChromeCtl | null) => void
	toggle: (id: string) => void
	select: (id: string) => void
	command: (id: string, cmd: string, value?: number) => void
}) {
	const [visible, setVisible] = useState(false)
	const [cc, setCc] = useState(false)
	const [scrub, setScrub] = useState<number | null>(null)
	const hoverRef = useRef(false)
	const untilRef = useRef(0)
	const everPlayedRef = useRef(false)
	const lastSentRef = useRef(0)

	const sync = useCallback(() => {
		setVisible(hoverRef.current || performance.now() < untilRef.current)
	}, [])
	const note = useCallback(() => {
		untilRef.current = performance.now() + 3000
		sync()
	}, [sync])
	const enter = useCallback(() => {
		hoverRef.current = true
		note()
	}, [note])
	const leave = useCallback(() => {
		hoverRef.current = false
		sync()
	}, [sync])

	useEffect(() => {
		register(el.id, { note, enter, leave })
		return () => register(el.id, null)
	}, [el.id, register, note, enter, leave])

	useEffect(() => {
		const i = setInterval(sync, 400)
		return () => clearInterval(i)
	}, [sync])

	// смена ссылки — сброс локального состояния плашки
	const srcRef = useRef(el.src)
	useEffect(() => {
		if (srcRef.current !== el.src) {
			srcRef.current = el.src
			everPlayedRef.current = false
			setCc(false)
			setScrub(null)
		}
	}, [el.src])

	// смена состояния плеера (в т.ч. клик по видео) — показать плашку заново
	const stNum = st?.st
	useEffect(() => {
		if (stNum === 1) everPlayedRef.current = true
		if (stNum !== undefined) note()
	}, [stNum, note])

	const info = parseMediaUrl(el.src || '')
	const kind = info && info.kind !== 'youtube' ? 'twitch' : 'youtube'
	const isYoutube = kind === 'youtube'
	const vidKey = st?.vid ?? ''
	const known = !!st && st.vid === vidKey && vidKey !== ''
	// превью-заставка YouTube: плеер не запускался (нативный постер YouTube с кнопками прятать)
	const poster =
		isYoutube &&
		(!known || (st!.st === -1 || st!.st === 5 || (st!.st === 2 && st!.t < 1 && !everPlayedRef.current)))
	const ytId = info && info.kind === 'youtube' ? info.id : ''
	const live = kind === 'twitch' && (st?.dur ?? 0) <= 0 && known
	const hasSeek = (st?.dur ?? 0) > 0
	const u = Math.max(0.8, Math.min(2.2, el.height / 315))
	const tShown = scrub ?? st?.t ?? 0

	return (
		<>
			{poster && ytId && (
				<div className='absolute inset-0 overflow-hidden pointer-events-none' style={{ background: '#000' }}>
					<img
						src={`https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`}
						onError={e => {
							const img = e.currentTarget
							if (!img.dataset.fallback) {
								img.dataset.fallback = '1'
								img.src = `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`
							}
						}}
						alt=''
						draggable={false}
						style={{ width: '100%', height: '100%', objectFit: 'cover' }}
					/>
					<div className='absolute inset-0 flex items-center justify-center'>
						<svg width={68 * u} height={48 * u} viewBox='0 0 68 48' style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,.45))' }}>
							<path
								d='M66.5 7.7c-.8-2.9-3-5.1-5.9-5.9C55.5.5 34 .5 34 .5S12.5.5 7.4 1.8c-2.9.8-5.1 3-5.9 5.9C.2 12.8.2 24 .2 24s0 11.2 1.3 16.3c.8 2.9 3 5.1 5.9 5.9C12.5 47.5 34 47.5 34 47.5s21.5 0 26.6-1.3c2.9-.8 5.1-3 5.9-5.9C67.8 35.2 67.8 24 67.8 24s0-11.2-1.3-16.3z'
								fill='#f00'
							/>
							<path d='M45 24 27 14v20z' fill='#fff' />
						</svg>
					</div>
				</div>
			)}
			<div
				style={{
					position: 'absolute',
					left: 6 * u,
					right: 6 * u,
					bottom: 6 * u,
					display: 'flex',
					alignItems: 'center',
					gap: 6 * u,
					padding: `${5 * u}px ${8 * u}px`,
					borderRadius: 8 * u,
					background: 'rgba(0,0,0,.66)',
					color: '#fff',
					fontSize: 11 * u,
					lineHeight: 1,
					pointerEvents: visible ? 'auto' : 'none',
					opacity: visible ? 1 : 0,
					transition: 'opacity .25s',
					// выше слоя ручек ресайза: иначе угловая ручка перекрывает кнопку play/pause
					zIndex: 5,
				}}
				onPointerDown={e => {
					e.stopPropagation()
					select(el.id)
				}}
				onPointerEnter={enter}
			>
				<button
					onClick={() => toggle(el.id)}
					title={stNum === 1 ? 'Пауза' : 'Играть'}
					style={{ width: 18 * u, height: 18 * u, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}
					className='hover:opacity-80'
				>
					{stNum === 1 ? (
						<svg width={12 * u} height={12 * u} viewBox='0 0 24 24' fill='#fff'>
							<rect x='5' y='4' width='5' height='16' rx='1' />
							<rect x='14' y='4' width='5' height='16' rx='1' />
						</svg>
					) : (
						<svg width={12 * u} height={12 * u} viewBox='0 0 24 24' fill='#fff'>
							<path d='M7 4.5v15l13-7.5z' />
						</svg>
					)}
				</button>
				{live ? (
					<span style={{ display: 'flex', alignItems: 'center', gap: 4 * u, flex: '0 0 auto', color: '#f66', fontWeight: 700, fontSize: 10 * u }}>
						<span style={{ width: 7 * u, height: 7 * u, borderRadius: '50%', background: '#f00', display: 'inline-block' }} />
						LIVE
					</span>
				) : (
					<span style={{ fontFamily: 'monospace', whiteSpace: 'nowrap', flex: '0 0 auto', opacity: 0.9 }}>
						{fmtTime(tShown)} / {fmtTime(st?.dur || 0)}
					</span>
				)}
				{hasSeek && (
					<input
						type='range'
						min={0}
						max={st?.dur || 1}
						step={0.1}
						value={Math.min(tShown, st?.dur || 1)}
						onPointerDown={e => {
							e.stopPropagation()
							select(el.id)
						}}
						onChange={e => {
							const v = parseFloat(e.target.value)
							setScrub(v)
							const now = performance.now()
							if (now - lastSentRef.current >= 250) {
								lastSentRef.current = now
								command(el.id, 'seek', v)
							}
						}}
						onPointerUp={e => {
							const v = parseFloat((e.target as HTMLInputElement).value)
							command(el.id, 'seek', v)
							setScrub(null)
							note()
						}}
						title='Перемотка'
						style={{ flex: '1 1 auto', minWidth: 20 * u, height: 3 * u, accentColor: 'rgb(var(--c-accent2))', cursor: 'pointer' }}
					/>
				)}
				{isYoutube && (
					<button
						onClick={() => {
							const next = !cc
							setCc(next)
							command(el.id, 'cc', next ? 1 : 0)
							note()
						}}
						title='Субтитры'
						style={{ width: 16 * u, height: 16 * u, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}
						className='hover:opacity-80'
					>
						<svg width={15 * u} height={15 * u} viewBox='0 0 24 24' fill='none' stroke={cc ? 'rgb(var(--c-accent2))' : '#fff'} strokeWidth='2'>
							<rect x='2' y='4' width='20' height='16' rx='3' />
							<path d='M10.5 9.5a2.5 2.5 0 1 0 0 5M17 9.5a2.5 2.5 0 1 0 0 5' strokeLinecap='round' />
						</svg>
					</button>
				)}
				<button
					onClick={() => {
						command(el.id, st?.muted ? 'unmute' : 'mute')
						note()
					}}
					title={st?.muted ? 'Включить звук' : 'Выключить звук'}
					style={{ width: 16 * u, height: 16 * u, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}
					className='hover:opacity-80'
				>
					{st?.muted ? (
						<svg width={13 * u} height={13 * u} viewBox='0 0 24 24' fill='none' stroke='#fff' strokeWidth='2' strokeLinecap='round'>
							<path d='M11 5 6 9H2v6h4l5 4z' fill='#fff' stroke='none' />
							<line x1='22' y1='9' x2='16' y2='15' />
							<line x1='16' y1='9' x2='22' y2='15' />
						</svg>
					) : (
						<svg width={13 * u} height={13 * u} viewBox='0 0 24 24' fill='none' stroke='#fff' strokeWidth='2' strokeLinecap='round'>
							<path d='M11 5 6 9H2v6h4l5 4z' fill='#fff' stroke='none' />
							<path d='M15.5 8.5a5 5 0 0 1 0 7' />
							<path d='M18.5 5.5a9.5 9.5 0 0 1 0 13' />
						</svg>
					)}
				</button>
				<input
					type='range'
					min={0}
					max={100}
					value={st?.muted ? 0 : (st?.vol ?? 100)}
					onPointerDown={e => {
						e.stopPropagation()
						select(el.id)
					}}
					onChange={e => {
						command(el.id, 'volume', parseInt(e.target.value, 10))
						if (st?.muted) command(el.id, 'unmute')
						note()
					}}
					title='Громкость'
					style={{ width: 42 * u, height: 3 * u, accentColor: 'rgb(var(--c-accent2))', cursor: 'pointer', flex: '0 0 auto' }}
				/>
			</div>
		</>
	)
}

// монтирует SDK-плеер Twitch внутри элемента (управление только через API —
// iframe SDK-плеера прозрачен для курсора)
export function TwitchFrame({ el, onPlayer }: { el: StreamElement; onPlayer: (id: string, p: any | null) => void }) {
	const ref = useRef<HTMLDivElement | null>(null)
	useEffect(() => {
		let cancelled = false
		const divId = 'twitch-' + el.id
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
				onPlayer(el.id, p)
			} catch {}
		})()
		return () => {
			cancelled = true
			onPlayer(el.id, null)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [el.id, el.src])
	return <div ref={ref} data-id={el.id} style={{ width: '100%', height: '100%', pointerEvents: 'none' }} />
}
