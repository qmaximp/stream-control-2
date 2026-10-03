'use client'

import LogoMark from '@/components/LogoMark'
import {
	MediaChrome,
	TwitchFrame,
	type ChromeCtl,
	type MediaSt,
} from '@/components/MediaPlayer'
import ObsPanel from '@/components/ObsPanel'
import { noteServerClock, serverClockLag } from '@/lib/clock'
import { toEmbedUrl } from '@/lib/embed'
import {
	isMediaUrl,
	loadTwitchSdk,
	parseMediaUrl,
	youtubeEmbedUrl,
} from '@/lib/media'
import { playFinishSound } from '@/lib/sound'
import type { StreamElement, SyncState } from '@/lib/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io as ioInit, Socket } from 'socket.io-client'

const CANVAS_W = 1920
const CANVAS_H = 1080

type Emote = { platform: string; code: string; url: string }

export default function PanelClient({
	channel,
	room,
	userLogin,
}: {
	channel?: string | null
	room?: string | null
	userLogin?: string | null
}) {
	const [state, setState] = useState<SyncState>({
		elements: [],
		canvasW: CANVAS_W,
		canvasH: CANVAS_H,
	})
	const [connected, setConnected] = useState(false)
	// стример отозвал доступ — сервер закрыл соединение; блокируем панель целиком
	const [accessRevoked, setAccessRevoked] = useState(false)
	const [tab, setTab] = useState<'elements' | 'obs'>('elements')
	const [theme, setTheme] = useState<'dark' | 'light'>('dark')
	const [previewOn, setPreviewOn] = useState(false)
	const [previewKey, setPreviewKey] = useState(0)
	const [twitchLive, setTwitchLive] = useState<boolean | null>(null)
	const [mounted, setMounted] = useState(false)
	useEffect(() => {
		setMounted(true)
	}, [])
	const parentHost =
		typeof window !== 'undefined' ? window.location.hostname : 'localhost'
	const [emoteOpen, setEmoteOpen] = useState(false)
	const [emotes, setEmotes] = useState<Emote[]>([])
	const [emoteLoading, setEmoteLoading] = useState(false)
	const [emoteError, setEmoteError] = useState('')
	const [emoteQuery, setEmoteQuery] = useState('')
	const [emotePlatform, setEmotePlatform] = useState<
		'all' | 'twitch' | '7tv' | 'bttv' | 'ffz'
	>('all')
	const [emoteNotes, setEmoteNotes] = useState<string[]>([])
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const selectedIdRef = useRef<string | null>(null)
	selectedIdRef.current = selectedId
	// мультивыделение: рамкой по пустому холсту (мышь) или ctrl+клик;
	// драг любого выбранного двигает всю группу, Delete удаляет все выбранные
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
	const selectedIdsRef = useRef<Set<string>>(new Set())
	selectedIdsRef.current = selectedIds
	// рамка выделения: координаты относительно вьюпорта холста
	const [marquee, setMarquee] = useState<{
		x1: number
		y1: number
		x2: number
		y2: number
	} | null>(null)
	const [interactiveIframeId, setInteractiveIframeId] = useState<string | null>(
		null,
	)
	// медиа-плееры (YouTube/Twitch): состояние элементов + SDK-плееры Twitch
	const [mediaStates, setMediaStates] = useState<Map<string, MediaSt>>(
		new Map(),
	)
	const mediaStatesRef = useRef<Map<string, MediaSt>>(mediaStates)
	const twitchPlayers = useRef<Map<string, any>>(new Map())
	const twitchStRef = useRef<Map<string, number>>(new Map()) // 1 играет / 2 пауза (из событий SDK)
	const chromeCtlRefs = useRef<Map<string, ChromeCtl>>(new Map())
	const lastYtCmdRef = useRef<Map<string, 'play' | 'pause'>>(new Map())
	const ccStatesRef = useRef<Map<string, number>>(new Map())
	const [addSheet, setAddSheet] = useState<null | 'image' | 'video'>(null)
	const [addSheetClosing, setAddSheetClosing] = useState(false)
	const addSheetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const closeAddSheet = () => {
		if (addSheetTimer.current) clearTimeout(addSheetTimer.current)
		setAddSheetClosing(true)
		addSheetTimer.current = setTimeout(() => {
			addSheetTimer.current = null
			setAddSheetClosing(false)
			setAddSheet(null)
		}, 180)
	}
	const socketRef = useRef<Socket | null>(null)
	const [view, setView] = useState({ x: 0, y: 0, s: 0.3 })
	const viewRef = useRef(view)
	viewRef.current = view
	const [panning, setPanning] = useState(false)
	type RemoteCursor = {
		id: string
		login: string
		x: number
		y: number
		hidden: boolean
		t: number
	}
	const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([])
	const cursorLastSent = useRef(0)
	// локи объектов: пока один тащит, другой перехватить не может; +5 секунд после остановки.
	// Стример (владелец комнаты) — исключение: двигает элементы всегда, сервер отдаёт ему лок
	const [elementLocks, setElementLocks] = useState<
		Record<string, { by: string; until: number }>
	>({})
	const isStreamer =
		!!channel &&
		!!userLogin &&
		userLogin.toLowerCase() === channel.toLowerCase()
	const isLockedByOther = useCallback(
		(id: string) => {
			if (isStreamer) return false
			const l = elementLocks[id]
			return !!l && l.until > Date.now() && l.by !== (userLogin ?? '')
		},
		[elementLocks, userLogin, isStreamer],
	)
	const [isCoarse, setIsCoarse] = useState(false)
	useEffect(() => {
		setIsCoarse(
			window.matchMedia?.('(pointer: coarse)').matches ||
				navigator.maxTouchPoints > 0,
		)
	}, [])
	const viewportRef = useRef<HTMLDivElement | null>(null)
	// канвас появляется/исчезает при повороте телефона — эффекты панорамы/зума должны
	// перепривязываться к фактическому монтированию, а не только к первому рендеру
	const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null)
	const setViewportEl = useCallback((el: HTMLDivElement | null) => {
		viewportRef.current = el
		setCanvasEl(prev => (prev === el ? prev : el))
	}, [])
	const baseViewRef = useRef<{ x: number; y: number; s: number } | null>(null)
	// минимальный абсолютный масштаб: отдаляться можно до 5% от базового (вписанного) вида —
	// дальше холст становится микроскопическим, а превью Twitch нечитаемым
	const minScale = useCallback(() => {
		const base = baseViewRef.current?.s
		return base ? base * 0.05 : 0.001
	}, [])
	// свежий стейт для колбэков, замороженных useCallback'ом (паркинг считает каскад по актуальным элементам)
	const stateRef = useRef(state)
	stateRef.current = state

	// мобильные устройства: портрет блокируется экраном «поверни телефон», ландшафт — компактный тулбар
	const [isPortrait, setIsPortrait] = useState(false)
	const [isMobile, setIsMobile] = useState(false)
	const [sheetOpen, setSheetOpen] = useState(false)
	const [menuOpen, setMenuOpen] = useState(false)
	// плавное закрытие бургера: на время exit-анимации меню остаётся в DOM
	const [menuClosing, setMenuClosing] = useState(false)
	const menuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const openBurger = () => {
		if (menuCloseTimer.current) {
			clearTimeout(menuCloseTimer.current)
			menuCloseTimer.current = null
		}
		setMenuClosing(false)
		setMenuOpen(true)
	}
	const closeBurger = () => {
		if (menuCloseTimer.current) clearTimeout(menuCloseTimer.current)
		setMenuClosing(true)
		menuCloseTimer.current = setTimeout(() => {
			menuCloseTimer.current = null
			setMenuClosing(false)
			setMenuOpen(false)
		}, 200)
	}
	const isMobileRef = useRef(false)
	isMobileRef.current = isMobile

	useEffect(() => {
		const pq = window.matchMedia(
			'(orientation: portrait) and (max-width: 820px) and (pointer: coarse)',
		)
		const mq = window.matchMedia(
			// мобильная раскладка только на реально узких экранах: широкий тач-экран
			// (планшет/ландшафт) получает десктопную — она полностью работает от тапов
			'(max-width: 950px), (pointer: coarse) and (max-width: 820px)',
		)
		const upd = () => {
			setIsPortrait(pq.matches)
			setIsMobile(mq.matches && !pq.matches)
		}
		upd()
		pq.addEventListener('change', upd)
		mq.addEventListener('change', upd)
		return () => {
			pq.removeEventListener('change', upd)
			mq.removeEventListener('change', upd)
		}
	}, [])

	useEffect(() => {
		const socket = ioInit({
			transports: ['websocket', 'polling'],
			query: { room: room || 'default', login: userLogin || '' },
		})
		socketRef.current = socket
		;(window as any).__ovrlySocket = socket // TODO: убрать после отладки

		// живые курсоры других пользователей этой комнаты
		socket.on(
			'cursor:update',
			(c: {
				id: string
				login: string
				x: number
				y: number
				hidden?: boolean
			}) => {
				setRemoteCursors(prev => {
					const next = prev.filter(p => p.id !== c.id)
					if (!c.hidden)
						next.push({
							id: c.id,
							login: c.login,
							x: c.x,
							y: c.y,
							hidden: false,
							t: Date.now(),
						})
					return next
				})
			},
		)
		socket.on('cursor:leave', ({ id }: { id: string }) => {
			setRemoteCursors(prev => prev.filter(p => p.id !== id))
		})
		socket.on(
			'element:lock',
			({ id, by, until }: { id: string; by: string; until: number }) => {
				setElementLocks(prev => ({ ...prev, [id]: { by, until } }))
				// лок перехватили у нас (например, стример забрал элемент) — принудительно
				// прекращаем перетаскивание и возвращаем элемент в серверную позицию:
				// иначе на нашем экране он «уезжает» локально, хотя сервер другие изменения отклонил
				if (by !== (userLogin ?? '')) {
					if (dragRef.current?.id === id) {
						dragRef.current = null
						lastMoveRef.current = null
						document.body.classList.remove('dragging')
						const start = dragStartPosRef.current
						if (start && start.id === id) {
							setState(p => ({
								...p,
								elements: p.elements.map(e =>
									e.id === id ? { ...e, x: start.x, y: start.y } : e,
								),
							}))
						}
					}
					if (resizeRef.current?.id === id) {
						resizeRef.current = null
						document.body.classList.remove('dragging')
						const snap = resizeSnapRef.current
						if (snap && snap.id === id) {
							setState(p => ({
								...p,
								elements: p.elements.map(e =>
									e.id === id
										? {
												...e,
												x: snap.el.x,
												y: snap.el.y,
												width: snap.el.width,
												height: snap.el.height,
											}
										: e,
								),
							}))
						}
					}
				}
			},
		)
		socket.on('element:unlock', ({ id }: { id: string }) => {
			setElementLocks(prev => {
				if (!(id in prev)) return prev
				const next = { ...prev }
				delete next[id]
				return next
			})
		})

		socket.on('connect', () => setConnected(true))
		socket.on('disconnect', () => setConnected(false))
		// стример отозвал доступ: сервер закрыл соединение — блокируем панель
		socket.on('access:revoked', () => {
			socket.disconnect()
			setAccessRevoked(true)
		})
		// оверлей (пере)подключился — отдаём ему текущее состояние играющего выбранного элемента
		socket.on('overlay:hello', () => {
			const sel = selectedIdRef.current
			if (!sel) return
			const st = mediaStatesRef.current.get(sel)
			if (st?.st === 1) {
				socket.emit('element:command', { id: sel, cmd: 'play' })
				socket.emit('element:command', { id: sel, cmd: 'seek', value: st.t })
				if (st.kind === 'youtube')
					socket.emit('element:command', {
						id: sel,
						cmd: 'cc',
						value: ccStatesRef.current.get(sel) ?? 0,
					})
			}
		})
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
			(d: {
				id: string
				x?: number
				y?: number
				width: number
				height: number
			}) =>
				setState(p => ({
					...p,
					elements: p.elements.map(e =>
						e.id === d.id
							? {
									...e,
									x: d.x ?? e.x,
									y: d.y ?? e.y,
									width: d.width,
									height: d.height,
								}
							: e,
					),
				})),
		)
		socket.on('element:deleted', (id: string) =>
			setState(p => ({ ...p, elements: p.elements.filter(e => e.id !== id) })),
		)
		socket.on('element:zorder', (ids: string[]) =>
			setState(p => {
				const z = new Map(ids.map((id, i) => [id, i]))
				return {
					...p,
					elements: p.elements.map(e => ({
						...e,
						zIndex: z.get(e.id) ?? e.zIndex,
					})),
				}
			}),
		)
		socket.on('elements:cleared', () => setState(p => ({ ...p, elements: [] })))

		return () => {
			socket.disconnect()
		}
	}, [room, userLogin])

	// курсоры пропадают, если участник перестал двигать мышью или отключился;
	// локи объектов чистятся по истечении TTL
	useEffect(() => {
		const t = setInterval(() => {
			setRemoteCursors(prev =>
				prev.some(p => Date.now() - p.t > 5000)
					? prev.filter(p => Date.now() - p.t <= 5000)
					: prev,
			)
			setElementLocks(prev => {
				const next: typeof prev = {}
				let changed = false
				for (const [id, l] of Object.entries(prev)) {
					if (l.until > Date.now()) next[id] = l
					else changed = true
				}
				return changed ? next : prev
			})
		}, 3000)
		return () => clearInterval(t)
	}, [])

	// отправка позиции мыши на канвасе другим участникам (не чаще ~20 раз/с)
	useEffect(() => {
		const vp = canvasEl
		if (!vp) return
		const send = (x: number, y: number, hidden: boolean) => {
			const now = performance.now()
			if (!hidden && now - cursorLastSent.current < 50) return
			cursorLastSent.current = now
			socketRef.current?.emit('cursor:move', { x, y, hidden })
		}
		const onMove = (e: PointerEvent) => {
			if (e.pointerType !== 'mouse') return
			const rect = vp.getBoundingClientRect()
			send(
				(e.clientX - rect.left - viewRef.current.x) / viewRef.current.s,
				(e.clientY - rect.top - viewRef.current.y) / viewRef.current.s,
				false,
			)
		}
		const onLeave = () => send(0, 0, true)
		vp.addEventListener('pointermove', onMove)
		vp.addEventListener('pointerleave', onLeave)
		return () => {
			vp.removeEventListener('pointermove', onMove)
			vp.removeEventListener('pointerleave', onLeave)
		}
	}, [canvasEl])

	const emit = useCallback((event: string, data?: any) => {
		socketRef.current?.emit(event, data)
	}, [])

	useEffect(() => {
		setTheme(
			document.documentElement.classList.contains('light') ? 'light' : 'dark',
		)
	}, [])

	const applyTheme = useCallback((next: 'dark' | 'light') => {
		const root = document.documentElement
		const isLight = root.classList.contains('light')
		if ((next === 'light') === isLight) return
		setTheme(next)
		root.classList.add('theme-anim')
		root.classList.toggle('light', next === 'light')
		try {
			localStorage.setItem('theme', next)
		} catch {}
		window.setTimeout(() => root.classList.remove('theme-anim'), 450)
	}, [])

	// локально применяем мгновенно; на сервер уходит не чаще ~8 раз/с (склейка правок)
	const pendingUpdatesRef = useRef<
		Map<
			string,
			{ partial: Partial<StreamElement>; timer: ReturnType<typeof setTimeout> }
		>
	>(new Map())

	const updateElement = useCallback(
		(id: string, partial: Partial<StreamElement>) => {
			setState(p => ({
				...p,
				elements: p.elements.map(e => (e.id === id ? { ...e, ...partial } : e)),
			}))
			const pending = pendingUpdatesRef.current.get(id)
			const merged = { ...(pending?.partial || {}), ...partial }
			if (pending) clearTimeout(pending.timer)
			const timer = setTimeout(() => {
				pendingUpdatesRef.current.delete(id)
				emit('element:update', { id, ...merged })
			}, 120)
			pendingUpdatesRef.current.set(id, { partial: merged, timer })
		},
		[emit],
	)

	// ===== медиа-плееры (YouTube / Twitch) =====
	// Ретрансляция в оверлей. Позиция (seek 1/с) — для ВСЕХ играющих элементов:
	// если держать позицию только выбранного, у остальных на оверлее цель устаревает
	// и дрейф-коррекция мотает их назад по кругу. Плей/пауза/звук — на смене состояния,
	// а такие смены происходят при взаимодействии, которое всегда выбирает элемент.
	const lastTimeRelayPerElRef = useRef<Map<string, number>>(new Map())
	const relayMedia = useCallback(
		(id: string, next: MediaSt, cur?: MediaSt) => {
			const now = performance.now()
			if (
				next.st === 1 &&
				now - (lastTimeRelayPerElRef.current.get(id) ?? 0) >= 1000
			) {
				lastTimeRelayPerElRef.current.set(id, now)
				emit('element:command', { id, cmd: 'seek', value: next.t })
			}
			if (id !== selectedIdRef.current) return
			if (next.st !== (cur?.st ?? -1)) {
				if (next.st === 1) emit('element:command', { id, cmd: 'play' })
				else if (next.st === 2 || next.st === 0)
					emit('element:command', { id, cmd: 'pause' })
			}
			if (cur && next.muted !== cur.muted)
				emit('element:command', { id, cmd: next.muted ? 'mute' : 'unmute' })
			if (cur && next.vol !== cur.vol)
				emit('element:command', { id, cmd: 'volume', value: next.vol })
		},
		[emit],
	)

	const applyMediaState = useCallback(
		(id: string, patch: Partial<MediaSt>) => {
			const cur = mediaStatesRef.current.get(id)
			const base: MediaSt = cur ?? {
				vid: patch.vid ?? '',
				kind: patch.kind ?? 'youtube',
				st: -1,
				t: 0,
				dur: 0,
				muted: true,
				vol: 100,
			}
			// периодические infoDelivery несут только позицию — undefined-поля патча
			// НЕ должны затирать известное состояние (иначе панель «забывает» st/dur)
			const clean: Partial<MediaSt> = {}
			for (const [k, v] of Object.entries(patch))
				if (v !== undefined) (clean as any)[k] = v
			const next: MediaSt = { ...base, ...clean }
			if (
				cur &&
				cur.vid === next.vid &&
				cur.st === next.st &&
				Math.abs(cur.t - next.t) < 0.25 &&
				Math.abs(cur.dur - next.dur) < 0.5 &&
				cur.muted === next.muted &&
				Math.abs(cur.vol - next.vol) < 1
			)
				return
			const m = new Map(mediaStatesRef.current)
			m.set(id, next)
			mediaStatesRef.current = m
			setMediaStates(m)
			relayMedia(id, next, cur)
		},
		[relayMedia],
	)

	// команда локальному плееру элемента (YT — postMessage, Twitch — SDK)
	const localMediaCommand = useCallback(
		(id: string, cmd: string, value?: number) => {
			const el = stateRef.current.elements.find(x => x.id === id)
			const info = el ? parseMediaUrl(el.src || '') : null
			if (info?.kind === 'youtube') {
				const f = document.querySelector(
					`iframe[data-id="${id}"]`,
				) as HTMLIFrameElement | null
				if (!f?.contentWindow) return
				// handshake перед каждой командой: команды, ушедшие до готовности API,
				// плеер молча игнорирует (handshake сразу перед командой гарантирует доставку)
				f.contentWindow.postMessage(
					JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }),
					'*',
				)
				const map: Record<string, [string, any[]]> = {
					play: ['playVideo', []],
					pause: ['pauseVideo', []],
					seek: ['seekTo', [value ?? 0, true]],
					volume: ['setVolume', [value ?? 100]],
					mute: ['mute', []],
					unmute: ['unMute', []],
					cc: [value ? 'loadModule' : 'unloadModule', ['captions']],
				}
				const [func, args] = map[cmd] ?? ['', []]
				if (func)
					f.contentWindow.postMessage(
						JSON.stringify({ event: 'command', func, args }),
						'*',
					)
				return
			}
			const p = twitchPlayers.current.get(id)
			if (!p) return
			try {
				if (cmd === 'play') p.play()
				else if (cmd === 'pause') p.pause()
				else if (cmd === 'seek') p.seek(value ?? 0)
				else if (cmd === 'volume') p.setVolume((value ?? 100) / 100)
				else if (cmd === 'mute') p.mute?.()
				else if (cmd === 'unmute') p.unmute?.()
			} catch {}
		},
		[],
	)

	// команда: локальному плееру + сразу в оверлей (для действий плашки)
	const mediaCommand = useCallback(
		(id: string, cmd: string, value?: number) => {
			if (cmd === 'cc') ccStatesRef.current.set(id, value ?? 0)
			localMediaCommand(id, cmd, value)
			emit('element:command', { id, cmd, value })
		},
		[emit, localMediaCommand],
	)

	// плей/пауза (клик по видео и кнопка на плашке); при буферизации (st=3) повторный
	// клик означает паузу, а не ещё один play
	const mediaToggle = useCallback(
		(id: string) => {
			const stNow = mediaStatesRef.current.get(id)?.st
			const playing =
				stNow === 1 || (stNow === 3 && lastYtCmdRef.current.get(id) === 'play')
			localMediaCommand(id, playing ? 'pause' : 'play')
			lastYtCmdRef.current.set(id, playing ? 'pause' : 'play')
			chromeCtlRefs.current.get(id)?.note()
		},
		[localMediaCommand],
	)

	const registerChromeCtl = useCallback((id: string, ctl: ChromeCtl | null) => {
		if (ctl) chromeCtlRefs.current.set(id, ctl)
		else chromeCtlRefs.current.delete(id)
	}, [])

	// SDK-плеер Twitch смонтирован: подписываемся на события плей/пауза
	const onTwitchPlayer = useCallback((id: string, p: any | null) => {
		if (!p) {
			twitchPlayers.current.delete(id)
			twitchStRef.current.delete(id)
			return
		}
		twitchPlayers.current.set(id, p)
		try {
			const Tw = (window as any).Twitch
			if (Tw?.Player) {
				p.addEventListener(Tw.Player.PLAY, () => {
					twitchStRef.current.set(id, 1)
				})
				p.addEventListener(Tw.Player.PAUSE, () => {
					twitchStRef.current.set(id, 2)
				})
			}
		} catch {}
	}, [])

	// опрос Twitch-плееров: позиция/громкость для плашки и ретрансляции
	useEffect(() => {
		const i = setInterval(() => {
			for (const [id, p] of twitchPlayers.current) {
				try {
					const t = p.getCurrentTime?.() ?? 0
					const dur = p.getDuration?.() ?? 0
					const vol = Math.round((p.getVolume?.() ?? 1) * 100)
					const muted =
						typeof p.isMuted === 'function'
							? !!p.isMuted()
							: (mediaStatesRef.current.get(id)?.muted ?? true)
					const st = twitchStRef.current.get(id) ?? -1
					const el = stateRef.current.elements.find(x => x.id === id)
					const info = el ? parseMediaUrl(el.src || '') : null
					const vid = info
						? info.kind +
							':' +
							('channel' in info
								? info.channel
								: 'id' in info
									? info.id
									: 'slug' in info
										? info.slug
										: '')
						: ''
					applyMediaState(id, { vid, kind: 'twitch', st, t, dur, muted, vol })
				} catch {}
			}
		}, 1000)
		return () => clearInterval(i)
	}, [applyMediaState])

	// YouTube-плееры reports: infoDelivery → состояние элемента
	useEffect(() => {
		const onMsg = (e: MessageEvent) => {
			let elId: string | null = null
			const nodes = document.querySelectorAll('iframe[data-id]')
			for (const n of nodes) {
				if ((n as HTMLIFrameElement).contentWindow === e.source) {
					elId = n.getAttribute('data-id')
					break
				}
			}
			if (!elId) return
			try {
				const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
				// initialDelivery приходит после handshake и несёт duration/playerState,
				// infoDelivery — периодические обновления позиции
				if (
					!d ||
					(d.event !== 'infoDelivery' && d.event !== 'initialDelivery') ||
					!d.info
				)
					return
				const info = d.info
				const el = stateRef.current.elements.find(x => x.id === elId)
				const parsed = el ? parseMediaUrl(el.src || '') : null
				const vid = parsed?.kind === 'youtube' ? 'youtube:' + parsed.id : ''
				if (!vid) return
				applyMediaState(elId, {
					vid,
					kind: 'youtube',
					st: info.playerState,
					t: info.currentTime,
					dur: info.duration,
					muted: info.muted,
					vol: info.volume !== undefined ? Math.round(info.volume) : undefined,
				} as Partial<MediaSt>)
			} catch {}
		}
		window.addEventListener('message', onMsg)
		return () => window.removeEventListener('message', onMsg)
	}, [applyMediaState])

	// выбранный играющий элемент раз в 5с подтверждаем оверлею (закрывает рефреш
	// оверлея / переподключение без действий пользователя)
	useEffect(() => {
		const t = setInterval(() => {
			const sel = selectedIdRef.current
			if (!sel) return
			const st = mediaStatesRef.current.get(sel)
			if (st?.st === 1) {
				emit('element:command', { id: sel, cmd: 'play' })
				emit('element:command', { id: sel, cmd: 'seek', value: st.t })
				if (st.kind === 'youtube')
					emit('element:command', {
						id: sel,
						cmd: 'cc',
						value: ccStatesRef.current.get(sel) ?? 0,
					})
			}
		}, 5000)
		return () => clearInterval(t)
	}, [emit])

	// интерактив iframe действует только пока выбран именно он
	useEffect(() => {
		if (selectedId !== interactiveIframeId) setInteractiveIframeId(null)
	}, [selectedId, interactiveIframeId])

	// Twitch-превью фоном холста (как в pogly): стрим тянется напрямую с канала через
	// официальный SDK. Оффлайн — Twitch сам показывает арт канала, при эфире — стрим.
	// URL-параметры автозапуска ненадёжны (браузер блокирует play() до применения мьюта),
	// поэтому после READY/PAUSE дёргаем play() по расписанию (~40 секунд страховки)
	const twitchPreviewRef = useRef<HTMLDivElement | null>(null)
	const twitchPlayerRef = useRef<any>(null)

	useEffect(() => {
		if (!previewOn || !channel || !mounted) return
		const target = twitchPreviewRef.current
		if (!target) return
		let cancelled = false
		let cleanupTimers: (() => void) | null = null

		;(async () => {
			try {
				const Tw = await loadTwitchSdk()
				if (cancelled || !twitchPreviewRef.current) return
				let resumeAttempts = 0
				const player = new Tw.Player('twitch-preview', {
					width: '100%',
					height: '100%',
					channel,
					parent: parentHost,
					autoplay: true,
					muted: true,
				})
				twitchPlayerRef.current = player
				const resume = () => {
					try {
						if (player.getMuted?.() === false) player.setMuted(true)
						player.play()
					} catch {}
				}
				player.addEventListener(Tw.Player.READY, () => setTimeout(resume, 200))
				player.addEventListener(Tw.Player.PLAY, () => {
					resumeAttempts = 0
				})
				player.addEventListener(Tw.Player.PAUSE, () => {
					// авто-возобновление (до 6 попыток), чтобы браузерная блокировка автозапуска не оставляла плеер на паузе
					if (resumeAttempts >= 6) return
					resumeAttempts += 1
					setTimeout(resume, 500)
				})
				player.addEventListener(Tw.Player.ONLINE, resume)
				// страховка: на мобильных плеер цепляет HLS долго — дёргаем play() по расписанию ~40 секунд
				// (play() на уже играющем плеере — no-op)
				const delays = [
					300, 700, 1500, 2500, 4000, 6000, 8000, 11000, 14000, 18000, 22000,
					26000, 30000, 35000, 40000,
				]
				const timers = delays.map(d =>
					setTimeout(() => {
						if (!cancelled) resume()
					}, d),
				)
				cleanupTimers = () => timers.forEach(clearTimeout)
			} catch {}
		})()

		return () => {
			cancelled = true
			cleanupTimers?.()
			twitchPlayerRef.current = null
			if (twitchPreviewRef.current) twitchPreviewRef.current.innerHTML = ''
		}
	}, [previewOn, channel, mounted, previewKey, parentHost])

	// статус эфира: пока показан плейсхолдер «не в эфире» — опрашиваем каждые 15 секунд,
	// когда стрим играется — раз в минуту. Значение меняется только на точно известное
	useEffect(() => {
		if (!previewOn || !channel) return
		let stopped = false
		let prev: boolean | null = null
		const tick = async () => {
			try {
				const res = await fetch(
					`/api/twitch-live?channel=${encodeURIComponent(channel)}`,
				)
				const j = await res.json()
				if (stopped) return
				if (j?.live !== true && j?.live !== false) return // неизвестно (нет ключей/сеть) — ничего не меняем
				setTwitchLive(j.live)
				if (prev === false && j.live === true) setPreviewKey(k => k + 1)
				prev = j.live
			} catch {}
		}
		tick()
		let t: ReturnType<typeof setInterval> | null = null
		const schedule = () => {
			t = setInterval(tick, twitchLive === false ? 15000 : 60000)
		}
		schedule()
		return () => {
			stopped = true
			if (t) clearInterval(t)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [previewOn, channel, twitchLive === false])

	const addElement = useCallback(
		(el: Omit<StreamElement, 'id' | 'zIndex' | 'visible'>) => {
			emit('element:add', { ...el, visible: true })
		},
		[emit],
	)

	const fileToDataUrl = (file: File): Promise<string> =>
		new Promise((res, rej) => {
			const r = new FileReader()
			r.onload = () => res(r.result as string)
			r.onerror = rej
			r.readAsDataURL(file)
		})

	// пробуем натуральный размер картинки, чтобы элемент спавнился без искажений
	const getImageSize = (src: string): Promise<{ w: number; h: number }> =>
		new Promise(resolve => {
			const img = new Image()
			img.onload = () =>
				resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 225 })
			img.onerror = () => resolve({ w: 400, h: 225 })
			img.src = src
		})

	const selected = state.elements.find(e => e.id === selectedId) || null

	const rotateRef = useRef<{
		el: StreamElement
		cx: number
		cy: number
		startAngle: number
		startRotation: number
	} | null>(null)

	const handleRotateStart = useCallback(
		(e: React.PointerEvent, el: StreamElement) => {
			if (isLockedByOther(el.id)) return
			e.preventDefault()
			e.stopPropagation()
			emit('element:grab', { id: el.id })
			if (!viewportRef.current) return
			const rect = viewportRef.current.getBoundingClientRect()
			const { x: vx, y: vy, s } = viewRef.current
			// центр элемента в экранных координатах — вокруг него и вращаем
			const cx = rect.left + vx + (el.x + el.width / 2) * s
			const cy = rect.top + vy + (el.y + el.height / 2) * s
			rotateRef.current = {
				el,
				cx,
				cy,
				startAngle:
					(Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI,
				startRotation: el.rotation ?? 0,
			}
		},
		[],
	)

	const handleRotateMove = useCallback(
		(e: PointerEvent) => {
			const r = rotateRef.current
			if (!r) return
			const cur =
				(Math.atan2(e.clientY - r.cy, e.clientX - r.cx) * 180) / Math.PI
			let rot = r.startRotation + (cur - r.startAngle)
			if (e.shiftKey)
				rot = Math.round(rot / 15) * 15 // шаг 15° с зажатым Shift
			else rot = Math.round(rot)
			updateElement(r.el.id, { rotation: rot })
		},
		[updateElement, isLockedByOther, emit],
	)

	useEffect(() => {
		const fn = () => {
			rotateRef.current = null
		}
		window.addEventListener('pointerup', fn)
		window.addEventListener('pointercancel', fn)
		window.addEventListener('pointermove', handleRotateMove)
		return () => {
			window.removeEventListener('pointerup', fn)
			window.removeEventListener('pointercancel', fn)
			window.removeEventListener('pointermove', handleRotateMove)
		}
	}, [handleRotateMove])

	// на телефоне новые элементы появляются в зоне предзагрузки под экраном,
	// по горизонтали — по центру того, что сейчас видно; на ПК — как раньше (0, 1200).
	// Каскад по уже запаркованным: элементы не ложатся в одну точку стопкой
	// (иначе добавленные подряд два видео неотличимы от «одного загрузившегося»)
	const parkingSpot = (w = 0, h = 0) => {
		const st = stateRef.current
		const k = st.elements.filter(e => e.y > st.canvasH).length % 8
		if (isMobileRef.current) {
			const vp = viewportRef.current
			const { x: vx, s } = viewRef.current
			const cx = vp ? Math.round((vp.clientWidth / 2 - vx) / s - w / 2) : 0
			const x = Math.min(
				Math.max(cx, -200),
				Math.max(-200, st.canvasW - 50 - w),
			)
			return { x: x + k * 40, y: st.canvasH + 120 + k * 24 }
		}
		return { x: k * 40, y: 1200 + k * 24 }
	}

	const openEmotePicker = useCallback(async () => {
		setEmoteOpen(true)
		setEmoteLoading(true)
		setEmoteError('')
		setEmoteQuery('')
		setEmotePlatform('all')
		try {
			const res = await fetch(
				`/api/emotes${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`,
			)
			const j = await res.json()
			if (!res.ok) throw new Error(j?.error || 'Ошибка загрузки')
			setEmotes(j.emotes ?? [])
			setEmoteNotes(j.notes ?? [])
			if (!j.emotes?.length)
				setEmoteError(
					'Смайлики не найдены. Проверьте TWITCH_CLIENT_ID/SECRET в .env.local или попробуйте позже.',
				)
		} catch (e: any) {
			setEmoteError(e?.message || 'Не удалось загрузить смайлики')
		} finally {
			setEmoteLoading(false)
		}
	}, [channel])

	const addEmote = useCallback(
		(em: Emote) => {
			const p = parkingSpot(96, 96)
			addElement({
				type: 'image',
				src: em.url,
				...p,
				width: 96,
				height: 96,
				text: '',
			})
		},
		[addElement],
	)

	// обработчики добавления — общие для сайдбара и мобильного тулбара
	// добавление с устройства: input добавляем в DOM — на iOS detached-инпут может не открыть выбор файла
	const addImagePC = useCallback(() => {
		const input = document.createElement('input')
		input.type = 'file'
		input.accept = 'image/*'
		input.style.display = 'none'
		input.onchange = async () => {
			const f = input.files?.[0]
			if (!f) {
				input.remove()
				return
			}
			const dataUrl = await fileToDataUrl(f)
			const size = await getImageSize(dataUrl)
			const k = Math.min(1, 1280 / Math.max(size.w, size.h))
			const w = Math.round(size.w * k),
				h = Math.round(size.h * k)
			const p = parkingSpot(w, h)
			addElement({
				type: 'image',
				src: dataUrl,
				...p,
				width: w,
				height: h,
				text: '',
			})
			input.remove()
		}
		document.body.appendChild(input)
		input.click()
	}, [addElement])

	const addVideoPC = useCallback(() => {
		const input = document.createElement('input')
		input.type = 'file'
		input.accept = 'video/*'
		input.style.display = 'none'
		input.onchange = async () => {
			const f = input.files?.[0]
			if (!f) {
				input.remove()
				return
			}
			if (f.size > 40 * 1024 * 1024) {
				alert('Файл больше 40 МБ. Лучше использовать ссылку.')
				input.remove()
				return
			}
			const dataUrl = await fileToDataUrl(f)
			const p = parkingSpot(480, 270)
			addElement({
				type: 'video',
				src: dataUrl,
				...p,
				width: 480,
				height: 270,
				text: '',
			})
			input.remove()
		}
		document.body.appendChild(input)
		input.click()
	}, [addElement])

	// добавление по ссылке — общее для сайдбара на ПК и мобильного шита
	const addImageUrl = useCallback(async () => {
		const url = prompt('Ссылка на картинку:')
		if (!url) return
		const size = await getImageSize(url)
		const k = Math.min(1, 1280 / Math.max(size.w, size.h))
		const p = parkingSpot()
		addElement({
			type: 'image',
			src: url,
			...p,
			width: Math.round(size.w * k),
			height: Math.round(size.h * k),
			text: '',
		})
	}, [addElement])

	const addVideoUrl = useCallback(() => {
		const url = prompt('Ссылка на видео (MP4, WebM):')
		const p = parkingSpot()
		if (url)
			addElement({
				type: 'video',
				src: url,
				...p,
				width: 480,
				height: 270,
				text: '',
			})
	}, [addElement])

	// drag&drop из проводника: брошенный файл попадает в ЗОНУ ПРЕДЗАГРУЗКИ —
	// так же, как при добавлении через кнопки (не на сам канвас с превью)
	const [dropHover, setDropHover] = useState(false)
	const dragDepth = useRef(0)
	const isImageFile = (f: File) =>
		f.type.startsWith('image/') ||
		/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name)
	const isVideoFile = (f: File) =>
		f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(f.name)
	// форматы, которые браузер не воспроизведёт (типичные записи OBS — mkv)
	const UNPLAYABLE_VIDEO_RE = /\.(mkv|avi|flv|ts|wmv)$/i
	const handleDropFiles = useCallback(
		async (files: File[]) => {
			for (const f of files) {
				if (isImageFile(f)) {
					const dataUrl = await fileToDataUrl(f)
					const size = await getImageSize(dataUrl)
					const k = Math.min(1, 1280 / Math.max(size.w, size.h))
					const w = Math.round(size.w * k),
						h = Math.round(size.h * k)
					const p = parkingSpot(w, h)
					addElement({
						type: 'image',
						src: dataUrl,
						...p,
						width: w,
						height: h,
						text: '',
					})
				} else if (isVideoFile(f)) {
					if (f.size > 40 * 1024 * 1024) {
						alert(`«${f.name}» больше 40 МБ — добавьте видео по ссылке.`)
						continue
					}
					const dataUrl = await fileToDataUrl(f)
					const p = parkingSpot(480, 270)
					addElement({
						type: 'video',
						src: dataUrl,
						...p,
						width: 480,
						height: 270,
						text: '',
					})
				} else if (UNPLAYABLE_VIDEO_RE.test(f.name)) {
					alert(
						`«${f.name}» — браузер не воспроизводит этот формат (частый случай у записей OBS). Конвертируйте в MP4/WebM или добавьте по ссылке.`,
					)
				} else {
					alert(`«${f.name}» — это не картинка и не видео.`)
				}
			}
		},
		[addElement],
	)

	const addIframeEl = useCallback(() => {
		const p = parkingSpot(560, 315)
		const url = prompt(
			'Ссылка на сайт, YouTube или Twitch (например, https://youtube.com/watch?v=...):',
		)
		// без autoplay: новое видео стоит на превью-заставке (как на референсе) —
		// играет в панели и на оверлее только после нажатия play
		if (url)
			addElement({
				type: 'iframe',
				src: url,
				...p,
				width: 560,
				height: 315,
				text: '',
			})
	}, [addElement])

	// вставка медиа из буфера (Ctrl+V): скриншоты, файлы из проводника, ссылки на картинки и YouTube
	useEffect(() => {
		const onPaste = (e: ClipboardEvent) => {
			// не мешаем вставке текста в поля ввода
			const t = e.target as HTMLElement | null
			if (
				t &&
				(t.tagName === 'INPUT' ||
					t.tagName === 'TEXTAREA' ||
					t.isContentEditable)
			)
				return
			const cd = e.clipboardData
			if (!cd) return
			const files: File[] = []
			for (const it of Array.from(cd.items)) {
				if (it.kind === 'file') {
					const f = it.getAsFile()
					if (f) files.push(f)
				}
			}
			if (files.length) {
				e.preventDefault()
				void handleDropFiles(files)
				return
			}
			// текстом — ссылка: YouTube/Twitch → медиа-элемент, картинка по расширению → картинка
			const text = (cd.getData('text/plain') || '').trim()
			if (!/^https?:\/\//i.test(text)) return
			if (isMediaUrl(text)) {
				e.preventDefault()
				const p = parkingSpot(560, 315)
				addElement({
					type: 'iframe',
					src: text,
					...p,
					width: 560,
					height: 315,
					text: '',
				})
				return
			}
			if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(text)) {
				e.preventDefault()
				void (async () => {
					try {
						const size = await getImageSize(text)
						const k = Math.min(1, 1280 / Math.max(size.w, size.h))
						const p = parkingSpot()
						addElement({
							type: 'image',
							src: text,
							...p,
							width: Math.round(size.w * k),
							height: Math.round(size.h * k),
							text: '',
						})
					} catch {
						alert('Не удалось загрузить картинку по этой ссылке.')
					}
				})()
			}
		}
		window.addEventListener('paste', onPaste)
		return () => window.removeEventListener('paste', onPaste)
	}, [handleDropFiles, addElement])

	const addTextEl = useCallback(() => {
		const p = parkingSpot(300, 60)
		addElement({
			type: 'text',
			...p,
			width: 300,
			height: 60,
			text: 'Новый текст',
			fontSize: 36,
			color: '#ffffff',
			fontWeight: 'bold',
			bgColor: 'transparent',
		})
	}, [addElement])

	const addTimerEl = useCallback(() => {
		const p = parkingSpot(200, 60)
		addElement({
			type: 'timer',
			...p,
			width: 200,
			height: 60,
			text: '',
			duration: 300,
			timerDirection: 'down',
			fontSize: 40,
			color: '#ffffff',
			fontWeight: 'bold',
			bgColor: 'transparent',
			startTime: null,
			isRunning: false,
			timerLabel: '',
		})
	}, [addElement])

	const dragRef = useRef<{
		id: string
		offX: number
		offY: number
		type: string
		moved: boolean
		sx: number
		sy: number
	} | null>(null)
	// серверная позиция тащимого элемента: если лок перехватили — откатываем элемент сюда
	const dragStartPosRef = useRef<{ id: string; x: number; y: number } | null>(
		null,
	)
	// снимок элемента на старте ресайза — для такого же отката
	const resizeSnapRef = useRef<{ id: string; el: StreamElement } | null>(null)

	const handleDragStart = (e: React.PointerEvent, el: StreamElement) => {
		if (el.locked) return
		if (e.button !== 0) return
		if (isLockedByOther(el.id)) return // объект тащит другой модератор
		// ctrl/shift+клик — добавить/убрать элемент из выделения (без драга)
		if (e.shiftKey || e.ctrlKey || e.metaKey) {
			setSelectedIds(prev => {
				const n = new Set(prev)
				if (n.has(el.id)) n.delete(el.id)
				else n.add(el.id)
				return n
			})
			setSelectedId(null)
			return
		}
		// драг выделенного при мультивыделении — двигаем всю группу
		if (selectedIdsRef.current.has(el.id) && selectedIdsRef.current.size > 1) {
			if (isLockedByOther(el.id)) return
			e.preventDefault()
			e.stopPropagation()
			const items: { id: string; x: number; y: number }[] = []
			for (const id of selectedIdsRef.current) {
				if (isLockedByOther(id)) continue // заблокированные другими пропускаем
				const it = stateRef.current.elements.find(x => x.id === id)
				if (it && !it.locked) {
					items.push({ id: it.id, x: it.x, y: it.y })
					emit('element:grab', { id: it.id })
				}
			}
			if (items.length < 2) {
				setSelectedIds(new Set())
				return
			}
			groupDragRef.current = {
				sx: e.clientX,
				sy: e.clientY,
				dx: 0,
				dy: 0,
				items,
				lastTick: 0,
			}
			document.body.classList.add('dragging')
			return
		}
		// обычный клик по элементу — одиночное выделение
		if (selectedIdsRef.current.size) setSelectedIds(new Set())
		e.preventDefault()
		e.stopPropagation()
		emit('element:grab', { id: el.id })
		const { x: vx, y: vy, s } = viewRef.current
		const rect = viewportRef.current!.getBoundingClientRect()
		const lx = (e.clientX - rect.left - vx) / s
		const ly = (e.clientY - rect.top - vy) / s
		dragRef.current = {
			id: el.id,
			offX: lx - el.x,
			offY: ly - el.y,
			type: el.type,
			moved: false,
			sx: e.clientX,
			sy: e.clientY,
		}
		dragStartPosRef.current = { id: el.id, x: el.x, y: el.y }
		if (el.type !== 'iframe') setInteractiveIframeId(null)
		document.body.classList.add('dragging')
		setSelectedId(el.id)
	}

	// оптимистично двигаем локально; на сервер шлём не чаще ~30 раз/с, финал — на mouseup
	const moveThrottleRef = useRef(0)
	const lastMoveRef = useRef<{ id: string; x: number; y: number } | null>(null)
	// групповое перемещение выбранных элементов
	const groupDragRef = useRef<{
		sx: number
		sy: number
		dx: number
		dy: number
		items: { id: string; x: number; y: number }[]
		lastTick: number
	} | null>(null)
	// масштабирование группы за угловую ручку бокса
	const groupScaleRef = useRef<{
		sx: number
		sy: number
		dx: number
		dy: number
		bx: number
		by: number
		bw: number
		bh: number
		corner: string
		items: { id: string; x: number; y: number; w: number; h: number }[]
		lastTick: number
	} | null>(null)

	const handleMouseMove = useCallback(
		(e: PointerEvent) => {
			const gs = groupScaleRef.current
			if (gs) {
				// дельта курсора — в экранных пикселях: переводим в мировые (делим на зум),
				// иначе при отдалении группа масштабируется медленнее курсора
				const s = viewRef.current.s || 1
				gs.dx = (e.clientX - gs.sx) / s
				gs.dy = (e.clientY - gs.sy) / s
				let fx = 1
				let fy = 1
				if (gs.corner.includes('e')) fx = (gs.bw + gs.dx) / gs.bw
				if (gs.corner.includes('w')) fx = (gs.bw - gs.dx) / gs.bw
				if (gs.corner.includes('s')) fy = (gs.bh + gs.dy) / gs.bh
				if (gs.corner.includes('n')) fy = (gs.bh - gs.dy) / gs.bh
				fx = Math.max(0.05, fx)
				fy = Math.max(0.05, fy)
				// неподвижный угол — противоположный тянемому
				const ox = gs.corner.includes('w') ? gs.bx + gs.bw : gs.bx
				const oy = gs.corner.includes('n') ? gs.by + gs.bh : gs.by
				setState(p => ({
					...p,
					elements: p.elements.map(el => {
						const it = gs.items.find(i => i.id === el.id)
						if (!it) return el
						return {
							...el,
							x: Math.round(ox + (it.x - ox) * fx),
							y: Math.round(oy + (it.y - oy) * fy),
							width: Math.max(4, Math.round(it.w * fx)),
							height: Math.max(4, Math.round(it.h * fy)),
						}
					}),
				}))
				const now = performance.now()
				if (now - gs.lastTick >= 33) {
					gs.lastTick = now
					gs.items.forEach(it => {
						const el = stateRef.current.elements.find(x => x.id === it.id)
						if (el)
							emit('element:resize', {
								id: it.id,
								x: el.x,
								y: el.y,
								width: el.width,
								height: el.height,
							})
					})
				}
				return
			}
			const g = groupDragRef.current
			if (g) {
				// дельта курсора — в экранных пикселях: делим на зум, иначе при
				// отдалении группа ползёт медленнее курсора
				const s = viewRef.current.s || 1
				g.dx = (e.clientX - g.sx) / s
				g.dy = (e.clientY - g.sy) / s
				const { dx, dy } = g
				setState(p => ({
					...p,
					elements: p.elements.map(el => {
						const it = g.items.find(i => i.id === el.id)
						return it
							? { ...el, x: Math.round(it.x + dx), y: Math.round(it.y + dy) }
							: el
					}),
				}))
				const now = performance.now()
				if (now - g.lastTick >= 33) {
					g.lastTick = now
					g.items.forEach(it =>
						emit('element:move', {
							id: it.id,
							x: Math.round(it.x + dx),
							y: Math.round(it.y + dy),
						}),
					)
				}
				return
			}
			if (!dragRef.current || !viewportRef.current) return
			const { x: vx, y: vy, s } = viewRef.current
			const rect = viewportRef.current.getBoundingClientRect()
			const lx = (e.clientX - rect.left - vx) / s
			const ly = (e.clientY - rect.top - vy) / s
			if (
				!dragRef.current.moved &&
				(Math.abs(e.clientX - dragRef.current.sx) > 4 ||
					Math.abs(e.clientY - dragRef.current.sy) > 4)
			)
				dragRef.current.moved = true
			const x = Math.round(lx - dragRef.current.offX)
			const y = Math.round(ly - dragRef.current.offY)
			const id = dragRef.current.id
			setState(p => ({
				...p,
				elements: p.elements.map(el => (el.id === id ? { ...el, x, y } : el)),
			}))
			lastMoveRef.current = { id, x, y }
			const now = performance.now()
			if (now - moveThrottleRef.current >= 33) {
				moveThrottleRef.current = now
				emit('element:move', { id, x, y })
			}
		},
		[emit],
	)

	const handleMouseUp = useCallback(() => {
		const gs = groupScaleRef.current
		if (gs) {
			// финальные размеры группы
			gs.items.forEach(it => {
				const el = stateRef.current.elements.find(x => x.id === it.id)
				if (el)
					emit('element:resize', {
						id: it.id,
						x: el.x,
						y: el.y,
						width: el.width,
						height: el.height,
					})
			})
			groupScaleRef.current = null
			document.body.classList.remove('dragging')
			return
		}
		const g = groupDragRef.current
		if (g) {
			// финальная позиция группы
			g.items.forEach(it => {
				const x = Math.round(it.x + g.dx)
				const y = Math.round(it.y + g.dy)
				if (x !== it.x || y !== it.y) emit('element:move', { id: it.id, x, y })
			})
			groupDragRef.current = null
			document.body.classList.remove('dragging')
			return
		}
		const dr = dragRef.current
		if (dr?.type === 'iframe' && !dr.moved) {
			const el = stateRef.current.elements.find(x => x.id === dr.id)
			if (el && isMediaUrl(el.src || '')) {
				// клик по медиа (YouTube/Twitch) — плей/пауза (iframe всегда прозрачен для курсора)
				mediaToggle(dr.id)
			} else {
				// клик по сайту без перетаскивания = активируем интерактив (управление сайтом внутри)
				setInteractiveIframeId(dr.id)
			}
		}
		dragRef.current = null
		document.body.classList.remove('dragging')
		if (lastMoveRef.current) {
			moveThrottleRef.current = 0
			emit('element:move', lastMoveRef.current)
			lastMoveRef.current = null
		}
	}, [emit, mediaToggle])

	// групповой бокс выделения: общие границы выбранных элементов
	const groupBox = useMemo(() => {
		if (selectedIds.size < 2) return null
		const items = stateRef.current.elements.filter(e => selectedIds.has(e.id))
		if (items.length < 2) return null
		const x1 = Math.min(...items.map(e => e.x))
		const y1 = Math.min(...items.map(e => e.y))
		const x2 = Math.max(...items.map(e => e.x + e.width))
		const y2 = Math.max(...items.map(e => e.y + e.height))
		return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
	}, [state, selectedIds])

	// тянем грань бокса — двигаем группу (тот же groupDrag, что и при драге элемента)
	const startGroupMove = useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0) return
			e.preventDefault()
			e.stopPropagation()
			const items: { id: string; x: number; y: number }[] = []
			for (const id of selectedIdsRef.current) {
				const it = stateRef.current.elements.find(x => x.id === id)
				if (it && !it.locked && !isLockedByOther(id)) {
					items.push({ id, x: it.x, y: it.y })
					emit('element:grab', { id })
				}
			}
			if (items.length < 2) return
			groupDragRef.current = {
				sx: e.clientX,
				sy: e.clientY,
				dx: 0,
				dy: 0,
				items,
				lastTick: 0,
			}
			document.body.classList.add('dragging')
		},
		[emit, isLockedByOther],
	)

	// тянем угловую ручку бокса — масштабируем всю группу
	const startGroupScale = useCallback(
		(e: React.PointerEvent, corner: string) => {
			if (e.button !== 0 || !groupBox) return
			e.preventDefault()
			e.stopPropagation()
			const items: {
				id: string
				x: number
				y: number
				w: number
				h: number
			}[] = []
			for (const id of selectedIdsRef.current) {
				const it = stateRef.current.elements.find(x => x.id === id)
				if (it && !it.locked && !isLockedByOther(id))
					items.push({ id, x: it.x, y: it.y, w: it.width, h: it.height })
			}
			if (items.length < 2) return
			items.forEach(it => emit('element:grab', { id: it.id }))
			groupScaleRef.current = {
				sx: e.clientX,
				sy: e.clientY,
				dx: 0,
				dy: 0,
				bx: groupBox.x,
				by: groupBox.y,
				bw: groupBox.w,
				bh: groupBox.h,
				corner,
				items,
				lastTick: 0,
			}
			document.body.classList.add('dragging')
		},
		[groupBox, emit, isLockedByOther],
	)

	useEffect(() => {
		window.addEventListener('pointermove', handleMouseMove)
		window.addEventListener('pointerup', handleMouseUp)
		window.addEventListener('pointercancel', handleMouseUp)
		return () => {
			window.removeEventListener('pointermove', handleMouseMove)
			window.removeEventListener('pointerup', handleMouseUp)
			window.removeEventListener('pointercancel', handleMouseUp)
		}
	}, [handleMouseMove, handleMouseUp])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Delete') return
			const ids = new Set(selectedIdsRef.current)
			if (selectedId) ids.add(selectedId)
			if (!ids.size) return
			const t = e.target as HTMLElement | null
			if (
				t &&
				(t.tagName === 'INPUT' ||
					t.tagName === 'TEXTAREA' ||
					t.tagName === 'SELECT' ||
					t.isContentEditable)
			)
				return
			ids.forEach(id => emit('element:delete', id))
			setSelectedId(null)
			setSelectedIds(new Set())
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [selectedId, emit])

	const resizeRef = useRef<{
		id: string
		dir: string
		sx: number
		sy: number
		orig: StreamElement
	} | null>(null)
	const resizeThrottleRef = useRef(0)
	const lastResizeRef = useRef<{
		id: string
		x: number
		y: number
		width: number
		height: number
	} | null>(null)

	const handleResizeStart = (
		e: React.PointerEvent,
		el: StreamElement,
		dir: string,
	) => {
		if (isLockedByOther(el.id)) return
		e.preventDefault()
		e.stopPropagation()
		emit('element:grab', { id: el.id })
		document.body.classList.add('dragging')
		resizeRef.current = {
			id: el.id,
			dir,
			sx: e.clientX,
			sy: e.clientY,
			orig: { ...el },
		}
		resizeSnapRef.current = { id: el.id, el: { ...el } }
	}

	const handleResizeMove = useCallback(
		(e: PointerEvent) => {
			if (!resizeRef.current || !viewportRef.current) return
			const { dir, orig } = resizeRef.current
			const { x: vx, y: vy, s } = viewRef.current
			const rect = viewportRef.current.getBoundingClientRect()
			const lx = (e.clientX - rect.left - vx) / s
			const ly = (e.clientY - rect.top - vy) / s
			let width, height, x, y
			if (dir.length === 2 && e.shiftKey) {
				const ox = dir.includes('w') ? orig.x + orig.width : orig.x
				const oy = dir.includes('n') ? orig.y + orig.height : orig.y
				const k = Math.max(
					Math.abs(lx - ox) / Math.max(orig.width, 1),
					Math.abs(ly - oy) / Math.max(orig.height, 1),
				)
				width = Math.max(30, Math.round(orig.width * k))
				height = Math.max(20, Math.round(orig.height * k))
				x = Math.round(dir.includes('w') ? ox - width : orig.x)
				y = Math.round(dir.includes('n') ? oy - height : orig.y)
			} else {
				const dx = (e.clientX - resizeRef.current.sx) / s
				const dy = (e.clientY - resizeRef.current.sy) / s
				let dw = 0,
					dh = 0
				if (dir.includes('e')) dw = dx
				if (dir.includes('w')) dw = -dx
				if (dir.includes('s')) dh = dy
				if (dir.includes('n')) dh = -dy
				width = Math.max(30, Math.round(orig.width + dw))
				height = Math.max(20, Math.round(orig.height + dh))
				x = Math.round(orig.x + (dir.includes('w') ? orig.width - width : 0))
				y = Math.round(orig.y + (dir.includes('n') ? orig.height - height : 0))
			}
			setState(p => ({
				...p,
				elements: p.elements.map(el =>
					el.id === orig.id ? { ...el, x, y, width, height } : el,
				),
			}))
			lastResizeRef.current = { id: orig.id, x, y, width, height }
			const now = performance.now()
			if (now - resizeThrottleRef.current >= 33) {
				resizeThrottleRef.current = now
				emit('element:resize', { id: orig.id, x, y, width, height })
			}
		},
		[emit],
	)

	useEffect(() => {
		const fn = () => {
			resizeRef.current = null
			document.body.classList.remove('dragging')
			if (lastResizeRef.current) {
				resizeThrottleRef.current = 0
				emit('element:resize', lastResizeRef.current)
				lastResizeRef.current = null
			}
		}
		window.addEventListener('pointerup', fn)
		window.addEventListener('pointercancel', fn)
		window.addEventListener('pointermove', handleResizeMove)
		return () => {
			window.removeEventListener('pointerup', fn)
			window.removeEventListener('pointercancel', fn)
			window.removeEventListener('pointermove', handleResizeMove)
		}
	}, [handleResizeMove, emit])

	// стартовый вид: считается при монтировании канваса (в т.ч. после поворота телефона
	// из портретного экрана, где канваса нет)
	useEffect(() => {
		const vp = canvasEl
		if (!vp || baseViewRef.current) return
		if (!isMobileRef.current) {
			const s = Math.min(
				(vp.clientWidth - 80) / state.canvasW,
				(vp.clientHeight - 80) / state.canvasH,
			)
			const base = {
				s,
				x: (vp.clientWidth - state.canvasW * s) / 2,
				y: (vp.clientHeight - state.canvasH * s) / 2,
			}
			baseViewRef.current = base
			setView(base)
			return
		}
		// на телефоне начальный вид показывает и парковку под канвасом:
		// иначе добавленные элементы «далеко от превью», и их приходится долго искать
		const w = state.canvasW + 240
		const h = state.canvasH + 60 + 560
		const s = Math.min((vp.clientWidth - 20) / w, (vp.clientHeight - 20) / h)
		const cx = state.canvasW / 2
		const cy = (state.canvasH - 60 + 560) / 2
		const base = {
			s,
			x: vp.clientWidth / 2 - cx * s,
			y: vp.clientHeight / 2 - cy * s,
		}
		baseViewRef.current = base
		setView(base)
	}, [canvasEl, state.canvasW, state.canvasH])

	useEffect(() => {
		const vp = canvasEl
		if (!vp) return
		const onWheel = (e: WheelEvent) => {
			e.preventDefault()
			const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
			const { x, y, s } = viewRef.current
			const ns = Math.min(200, Math.max(minScale(), s * factor))
			if (ns === s) return
			const rect = vp.getBoundingClientRect()
			const mx = e.clientX - rect.left,
				my = e.clientY - rect.top
			setView({
				s: ns,
				x: mx - ((mx - x) / s) * ns,
				y: my - ((my - y) / s) * ns,
			})
		}
		vp.addEventListener('wheel', onWheel, { passive: false })
		return () => vp.removeEventListener('wheel', onWheel)
	}, [canvasEl])

	// кнопки зума −/+ : приближение к центру видимой области
	const zoomBy = useCallback((factor: number) => {
		const vp = viewportRef.current
		if (!vp) return
		const { x, y, s } = viewRef.current
		const ns = Math.min(200, Math.max(minScale(), s * factor))
		if (ns === s) return
		const mx = vp.clientWidth / 2,
			my = vp.clientHeight / 2
		setView({ s: ns, x: mx - ((mx - x) / s) * ns, y: my - ((my - y) / s) * ns })
	}, [])

	// панорама и щипок — единая pointer-реализация: работает одинаково мышью и пальцами
	// на всех телефонах (старый вариант на touch-событиях вёл себя по-разному в разных браузерах).
	// Перепривязывается при монтировании канваса (поворот телефона из портретного экрана)
	useEffect(() => {
		const vp = canvasEl
		if (!vp) return
		const pointers = new Map<number, { x: number; y: number }>()
		let marquee: { id: number; x1: number; y1: number } | null = null
		let pan: {
			id: number
			x: number
			y: number
			vx: number
			vy: number
		} | null = null
		let pinch: null | { d0: number; s0: number; vx: number; vy: number } = null

		const cancelOneFingerGestures = () => {
			dragRef.current = null
			rotateRef.current = null
			resizeRef.current = null
			pan = null
			document.body.classList.remove('dragging')
			setPanning(false)
		}

		const startPinch = () => {
			cancelOneFingerGestures()
			const pts = [...pointers.values()]
			if (pts.length < 2) return
			const [a, b] = pts
			pinch = {
				d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
				s0: viewRef.current.s,
				vx: viewRef.current.x,
				vy: viewRef.current.y,
			}
		}

		const down = (e: PointerEvent) => {
			const target = e.target as HTMLElement | null
			const onNoPan = !!target?.closest?.('[data-nopan]')
			const onEl = !!target?.closest?.('[data-elwrap]')
			if (e.button === 1) {
				e.preventDefault()
				e.stopPropagation()
				pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
				pan = {
					id: e.pointerId,
					x: e.clientX,
					y: e.clientY,
					vx: viewRef.current.x,
					vy: viewRef.current.y,
				}
				setPanning(true)
				return
			}
			if (e.button !== 0 || onNoPan) return
			// мышь по пустому холсту — рамка мультивыделения (пан — средняя кнопка/тач)
			if (e.pointerType === 'mouse' && !onEl) {
				e.preventDefault() // без этого браузер выделяет текст под рамкой
				const rect = vp.getBoundingClientRect()
				marquee = {
					id: e.pointerId,
					x1: e.clientX - rect.left,
					y1: e.clientY - rect.top,
				}
				setMarquee({
					x1: marquee.x1,
					y1: marquee.y1,
					x2: marquee.x1,
					y2: marquee.y1,
				})
				return
			}
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
			if (pointers.size === 2) {
				// второй палец — щипок, гасим драг/поворот/ресайз и панораму
				startPinch()
			} else if (pointers.size === 1 && !onEl) {
				// палец/клик по пустому месту холста — панорама
				pan = {
					id: e.pointerId,
					x: e.clientX,
					y: e.clientY,
					vx: viewRef.current.x,
					vy: viewRef.current.y,
				}
				setPanning(true)
			}
		}

		const move = (e: PointerEvent) => {
			if (marquee && e.pointerId === marquee.id) {
				const rect = vp.getBoundingClientRect()
				setMarquee(m =>
					m ? { ...m, x2: e.clientX - rect.left, y2: e.clientY - rect.top } : m,
				)
				return
			}
			const pt = pointers.get(e.pointerId)
			if (!pt) return
			pt.x = e.clientX
			pt.y = e.clientY
			if (pinch && pointers.size >= 2) {
				const pts = [...pointers.values()]
				const [a, b] = pts
				const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
				const rect = vp.getBoundingClientRect()
				const mx = (a.x + b.x) / 2 - rect.left
				const my = (a.y + b.y) / 2 - rect.top
				const ns = Math.min(200, Math.max(minScale(), pinch.s0 * (d / pinch.d0)))
				setView({
					s: ns,
					x: mx - ((mx - pinch.vx) / pinch.s0) * ns,
					y: my - ((my - pinch.vy) / pinch.s0) * ns,
				})
				return
			}
			if (pan && e.pointerId === pan.id) {
				const p = pan
				setView(v => ({
					...v,
					x: p.vx + (e.clientX - p.x),
					y: p.vy + (e.clientY - p.y),
				}))
			}
		}

		const up = (e: PointerEvent) => {
			if (marquee && e.pointerId === marquee.id) {
				const m = marquee
				marquee = null
				const rect = vp.getBoundingClientRect()
				setMarquee(null)
				// отменяем совместимые mouse-события: иначе следующий click по холсту
				// сразу стирает только что сделанное выделение
				e.preventDefault()
				// экран -> мир
				const s = viewRef.current.s
				const wx1 =
					(Math.min(m.x1, e.clientX - rect.left) - viewRef.current.x) / s
				const wy1 =
					(Math.min(m.y1, e.clientY - rect.top) - viewRef.current.y) / s
				const wx2 =
					(Math.max(m.x1, e.clientX - rect.left) - viewRef.current.x) / s
				const wy2 =
					(Math.max(m.y1, e.clientY - rect.top) - viewRef.current.y) / s
				if (wx2 - wx1 < 5 && wy2 - wy1 < 5) {
					// клик по пустому — снять выделение
					setSelectedIds(new Set())
					return
				}
				const hits = stateRef.current.elements
					.filter(
						el =>
							el.visible !== false &&
							el.x < wx2 &&
							el.x + el.width > wx1 &&
							el.y < wy2 &&
							el.y + el.height > wy1,
					)
					.map(el => el.id)
				setSelectedIds(new Set(hits))
				if (hits.length) setSelectedId(null)
				return
			}
			pointers.delete(e.pointerId)
			if (pan && e.pointerId === pan.id) {
				pan = null
				setPanning(false)
			}
			if (pinch && pointers.size < 2) pinch = null
			// после щипка не возобновляем панораму до нового касания
		}

		vp.addEventListener('pointerdown', down)
		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', up)
		window.addEventListener('pointercancel', up)
		return () => {
			vp.removeEventListener('pointerdown', down)
			window.removeEventListener('pointermove', move)
			window.removeEventListener('pointerup', up)
			window.removeEventListener('pointercancel', up)
		}
	}, [canvasEl])

	// вертикальная ориентация телефона — просим повернуть (как на референсе)
	if (isPortrait) {
		return (
			<div className='min-h-[100dvh] bg-bg flex items-center justify-center p-6'>
				<div className='bg-panel border border-border rounded-2xl p-8 text-center max-w-xs w-full'>
					<div className='text-5xl mb-4'>📱</div>
					<h1 className='text-lg font-semibold mb-2'>
						Поверните телефон горизонтально
					</h1>
					<p className='text-sm text-gray-400 mb-5'>
						Панели нужно широкое поле для работы с оверлеем
					</p>
				</div>
			</div>
		)
	}

	// пилюля Превью: на ПК и мобильном — закреплена в правом нижнем углу окна превью
	// бокс превью (как в pogly): скейлится с зумом только ДО 67% базового масштаба,
	// ниже — размер ФИКСИРОВАННЫЙ на экране (~2/3 размера холста при 100%): плеер
	// не ресайзится при каждом шаге зума (нет глитчей) и остаётся читаемым при отдалении
	const pvBaseW = state.canvasW * (baseViewRef.current?.s ?? view.s)
	const pvBaseH = state.canvasH * (baseViewRef.current?.s ?? view.s)
	const pvK = Math.max(1, (pvBaseW * 0.67) / (state.canvasW * view.s))
	const pvW = state.canvasW * view.s * pvK
	const pvH = state.canvasH * view.s * pvK
	const pvX = view.x + (state.canvasW * view.s - pvW) / 2
	const pvY = view.y + (state.canvasH * view.s - pvH) / 2
	const previewPill = (
		<div
			className='absolute right-4 bottom-3 z-10 flex items-center gap-2 bg-panel border border-border rounded-full pl-3 pr-3 py-1.5 pointer-events-auto'
			style={{ boxShadow: '0 2px 10px rgba(0,0,0,.25)' }}
			data-nopan='1'
			onPointerDown={e => e.stopPropagation()}
		>
			<span className='text-xs text-gray-300 select-none'>Превью</span>
			<button
				onClick={() => setPreviewOn(v => !v)}
				disabled={!channel}
				title={
					channel
						? 'Стрим Twitch в превью холста'
						: 'Вход не выполнен: превью доступно после входа через Twitch'
				}
				className={`w-9 h-5 rounded-full transition-colors shrink-0 relative ${previewOn ? 'bg-green-500' : 'bg-gray-600'} ${channel ? '' : 'opacity-50 cursor-not-allowed'}`}
			>
				<span
					className='absolute top-[2px] w-4 h-4 bg-white rounded-full transition-all'
					style={{ left: previewOn ? 18 : 2 }}
				/>
			</button>
		</div>
	)

	return (
		<div className='h-[100dvh] overflow-hidden flex flex-col bg-bg'>
			{accessRevoked && (
				<div className='fixed inset-0 z-[200] bg-bg flex flex-col items-center justify-center text-center px-4'>
					<div className='text-5xl mb-4'>🚫</div>
					<h1 className='text-xl font-semibold text-white mb-2'>
						Доступ отозван
					</h1>
					<p className='text-sm text-gray-500 max-w-sm mb-6'>
						Стример отозвал доступ к панели. Обновите страницу, чтобы проверить
						доступ ещё раз.
					</p>
					<a href='/' className='text-sm text-accent2 hover:underline'>
						На главную
					</a>
				</div>
			)}
			<header
				className={`flex items-center gap-3 bg-panel border-b border-border ${isMobile ? 'px-3 py-2' : 'px-5 py-3'}`}
			>
				{isMobile && (
					<button
						onClick={() =>
							menuOpen && !menuClosing ? closeBurger() : openBurger()
						}
						aria-label='Меню'
						className='w-9 h-9 rounded-lg bg-border hover:bg-gray-600 flex flex-col items-center justify-center gap-[3px] shrink-0'
					>
						<span className='block w-4 h-[2px] bg-gray-300 rounded' />
						<span className='block w-4 h-[2px] bg-gray-300 rounded' />
						<span className='block w-4 h-[2px] bg-gray-300 rounded' />
					</button>
				)}
				<a
					href='/'
					className='flex items-center gap-2 hover:opacity-80 transition-opacity'
				>
					<LogoMark size={isMobile ? 28 : 36} />
					<div>
						<h1
							className={`${isMobile ? 'text-sm' : 'text-base'} font-semibold leading-tight`}
						>
							Ovrly
						</h1>
						<p
							className={`${isMobile ? 'text-[10px]' : 'text-xs'} text-gray-500 leading-tight`}
						>
							Панель модератора
						</p>
					</div>
				</a>
				<div className='flex-1' />
				{isMobile && (
					<span className='text-right text-[10px] text-gray-500 leading-tight max-w-[40vw]'>
						Элементы удаляются через 3 часа без изменений
					</span>
				)}
				<div className={`flex items-center gap-3 ${isMobile ? 'hidden' : ''}`}>
					<button
						onClick={() => applyTheme(theme === 'dark' ? 'light' : 'dark')}
						title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
						aria-label={
							theme === 'dark'
								? 'Включить светлую тему'
								: 'Включить тёмную тему'
						}
						className={`w-9 h-9 rounded-full bg-border flex items-center justify-center transition-colors ${theme === 'dark' ? 'text-gray-300 hover:text-white' : 'text-[#443f66] hover:text-[#3a3750]'}`}
					>
						{theme === 'dark' ? <SunIcon /> : <MoonIcon />}
					</button>
					<span
						className={`flex items-center gap-1.5 text-sm ${connected ? 'text-green-400' : 'text-red-400'}`}
					>
						<span
							className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`}
						/>
						{connected ? 'Сервер: онлайн' : 'Сервер: оффлайн'}
					</span>
					<a
						href='https://dalink.to/jettle_'
						target='_blank'
						rel='noopener noreferrer'
						className='text-sm text-accent2 hover:underline'
					>
						Поддержать проект ❤️
					</a>
				</div>
			</header>

			<div
				className={`flex gap-1 px-5 pt-3 bg-panel border-b border-border ${isMobile ? 'hidden' : ''}`}
			>
				<button
					onClick={() => setTab('elements')}
					className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${tab === 'elements' ? 'bg-bg text-[color:var(--c-on-bg)] border-b-2 border-accent' : 'text-gray-500 hover:text-gray-300'}`}
				>
					Элементы оверлея
				</button>
				<button
					onClick={() => setTab('obs')}
					className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${tab === 'obs' ? 'bg-bg text-[color:var(--c-on-bg)] border-b-2 border-accent' : 'text-gray-500 hover:text-gray-300'}`}
				>
					Управление OBS
				</button>
			</div>

			<div
				className={`flex-1 flex overflow-hidden ${tab === 'elements' ? '' : 'hidden'}`}
			>
				{!isMobile && (
					<aside className='w-72 shrink-0 bg-panel border-r border-border p-4 overflow-y-auto'>
						<h2 className='text-sm font-semibold mb-3 text-gray-400 uppercase tracking-wide'>
							Добавить элемент
						</h2>
						<div className='space-y-2'>
							<div className='flex gap-2'>
								<button
									onClick={addImagePC}
									className='flex-1 px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors'
								>
									🖼 С ПК
								</button>
								<button
									onClick={addImageUrl}
									className='flex-1 px-3 py-2 bg-border hover:bg-gray-600 text-white text-sm rounded-lg transition-colors'
								>
									🔗 URL
								</button>
							</div>
							<div className='flex gap-2'>
								<button
									onClick={addVideoPC}
									className='flex-1 px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors'
								>
									🎬 С ПК
								</button>
								<button
									onClick={addVideoUrl}
									className='flex-1 px-3 py-2 bg-border hover:bg-gray-600 text-white text-sm rounded-lg transition-colors'
								>
									🔗 URL
								</button>
							</div>
							<button
								onClick={openEmotePicker}
								className='w-full px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors'
							>
								😀 Добавить смайлик
							</button>
							<button
								onClick={addIframeEl}
								className='w-full px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors'
							>
								🌐 Сайт
							</button>
							<button
								onClick={addTextEl}
								className='w-full px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors'
							>
								✏️ Текст
							</button>
							<button
								onClick={addTimerEl}
								className='w-full px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors'
							>
								⏱ Таймер
							</button>
						</div>

						<h2 className='text-sm font-semibold mt-6 mb-2 text-gray-400 uppercase tracking-wide'>
							Элементы ({state.elements.length})
						</h2>
						<div className='space-y-1'>
							{state.elements.map(el => (
								<div
									key={el.id}
									onClick={() => setSelectedId(el.id)}
									className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-sm transition-colors ${selectedId === el.id ? 'bg-accent text-white' : 'hover:bg-border text-gray-300'}`}
								>
									<button
										onClick={e => {
											e.stopPropagation()
											setState(p => ({
												...p,
												elements: p.elements.map(x =>
													x.id === el.id ? { ...x, visible: !x.visible } : x,
												),
											}))
											emit('element:toggle-visible', el.id)
										}}
										className='shrink-0'
									>
										{el.visible ? '👁' : '🚫'}
									</button>
									{el.alwaysLoaded && (
										<span
											className='shrink-0 text-[10px] opacity-70'
											title='Всегда загружен'
										>
											📦
										</span>
									)}
									{el.locked && (
										<span
											className='shrink-0 text-[10px] opacity-70'
											title='Заблокирован от перетаскивания'
										>
											🔒
										</span>
									)}
									<span className='flex-1 truncate'>
										{el.type === 'image' &&
											'🖼 ' + (el.src?.slice(0, 20) || 'image')}
										{el.type === 'video' &&
											'🎬 ' + (el.src?.slice(0, 20) || 'video')}
										{el.type === 'gif' &&
											'🎞 ' + (el.src?.slice(0, 20) || 'gif')}
										{el.type === 'iframe' &&
											'🌐 ' + (el.src?.slice(0, 25) || 'embed')}
										{el.type === 'text' && '✏️ ' + (el.text || 'text')}
										{el.type === 'timer' && '⏱ ' + (el.timerLabel || 'timer')}
									</span>
									<button
										onClick={e => {
											e.stopPropagation()
											emit('element:delete', el.id)
											if (selectedId === el.id) setSelectedId(null)
										}}
										className='shrink-0 text-red-400 hover:text-red-300'
									>
										✕
									</button>
								</div>
							))}
							{state.elements.length === 0 && (
								<p className='text-xs text-gray-600 px-2 py-4'>
									Нет элементов. Добавьте сверху.
								</p>
							)}
						</div>
						<button
							onClick={() => {
								if (confirm('Очистить все элементы?')) emit('elements:clear')
							}}
							className='w-full mt-4 px-3 py-2 text-sm text-red-400 hover:bg-red-950/40 rounded-lg border border-red-900/50 transition-colors'
						>
							Очистить всё
						</button>
					</aside>
				)}

				<div className='flex-1 flex flex-col bg-bg overflow-hidden'>
					<div
						ref={setViewportEl}
						className={`flex-1 relative overflow-hidden ${panning ? 'cursor-grabbing' : ''}`}
						style={{
							touchAction: 'none',
							background: 'var(--c-canvas)',
							backgroundImage:
								'radial-gradient(var(--c-dot) 1px, transparent 1px)',
							backgroundSize: `${Math.max(4, 22 * view.s)}px ${Math.max(4, 22 * view.s)}px`,
							backgroundPosition: `${view.x}px ${view.y}px`,
						}}
						onClick={e => {
							if (e.target === e.currentTarget) {
								setSelectedId(null)
								setInteractiveIframeId(null)
								// selectedIds здесь НЕ чистим: браузерный click после рамки
								// стирал бы только что сделанное выделение; рамка сама
								// снимает выделение кликом без движения
							}
						}}
						onDragEnter={e => {
							e.preventDefault()
							dragDepth.current += 1
							setDropHover(true)
						}}
						onDragOver={e => {
							e.preventDefault()
							if (!dropHover) setDropHover(true)
						}}
						onDragLeave={e => {
							dragDepth.current = Math.max(0, dragDepth.current - 1)
							if (dragDepth.current === 0) setDropHover(false)
						}}
						onDrop={e => {
							e.preventDefault()
							dragDepth.current = 0
							setDropHover(false)
							if (e.dataTransfer.files?.length) {
								void handleDropFiles([...e.dataTransfer.files])
								return
							}
							// перетаскивание картинки-ссылки из браузера — тоже в зону предзагрузки
							const url = (
								e.dataTransfer.getData('text/uri-list') ||
								e.dataTransfer.getData('text/plain')
							).trim()
							if (/^https?:\/\//i.test(url)) {
								void getImageSize(url).then(size => {
									const k = Math.min(1, 1280 / Math.max(size.w, size.h))
									const p = parkingSpot(
										Math.round(size.w * k),
										Math.round(size.h * k),
									)
									addElement({
										type: 'image',
										src: url,
										...p,
										width: Math.round(size.w * k),
										height: Math.round(size.h * k),
										text: '',
									})
								})
							}
						}}
					>
						{/* фон канваса + превью: ВНЕ transform-контейнера (transform предка блокирует
                  автовоспроизведение Twitch-плеера). Как в pogly: бокс стрима скейлится
                  с зумом до 67% базового масштаба, ниже держит ФИКСИРОВАННЫЙ экранный
                  размер (плеер не ресайзится и не глючит) и центрируется на холсте */}
						<div
							className='absolute rounded-md border border-border/50 pointer-events-none'
							style={{
								left: view.x,
								top: view.y,
								width: state.canvasW * view.s,
								height: state.canvasH * view.s,
							}}
						/>
						{mounted && previewOn && channel && (
							<div
								className='absolute bg-black border border-border rounded-md pointer-events-none overflow-hidden'
								style={{
									left: pvX,
									top: pvY,
									width: pvW,
									height: pvH,
								}}
							>
								<div
									key={previewKey}
									ref={twitchPreviewRef}
									id='twitch-preview'
									className='absolute inset-0'
								/>
							</div>
						)}
						{!(mounted && previewOn && channel) && (
							<div
								className='absolute bg-black border border-border rounded-md pointer-events-none overflow-hidden'
								style={{
									left: view.x,
									top: view.y,
									width: state.canvasW * view.s,
									height: state.canvasH * view.s,
								}}
							>
									<div
										className='absolute inset-0 opacity-10'
										style={{
											backgroundImage:
												'linear-gradient(#444 1px, transparent 1px), linear-gradient(90deg, #444 1px, transparent 1px)',
											backgroundSize: `${40 * view.s}px ${40 * view.s}px`,
										}}
									/>
								</div>
							)}
							<div
								className='absolute left-0 top-0'
							style={{
								transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
								transformOrigin: '0 0',
							}}
						>
							<span
								className='absolute text-center tracking-widest text-gray-600 uppercase pointer-events-none'
								style={{
									left: 0,
									top: -175,
									width: state.canvasW,
									fontSize: 28,
								}}
							>
								зона предзагрузки элементов
							</span>
							<span
								className='absolute text-center tracking-widest text-gray-600 uppercase pointer-events-none'
								style={{
									left: 0,
									top: state.canvasH + 175,
									width: state.canvasW,
									fontSize: 28,
								}}
							>
								зона предзагрузки элементов
							</span>
							<span
								className='absolute tracking-widest text-gray-600 uppercase pointer-events-none'
								style={{
									left: -175,
									top: 0,
									height: state.canvasH,
									writingMode: 'vertical-rl',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									fontSize: 28,
								}}
							>
								зона предзагрузки элементов
							</span>
							<span
								className='absolute tracking-widest text-gray-600 uppercase pointer-events-none'
								style={{
									left: state.canvasW + 175,
									top: 0,
									height: state.canvasH,
									writingMode: 'vertical-rl',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									fontSize: 28,
								}}
							>
								зона предзагрузки элементов
							</span>
							{state.elements.map(el => {
								const hs = 10 / view.s
								const isMedia =
									el.type === 'iframe' && !!parseMediaUrl(el.src || '')
								return (
									<div
										key={el.id}
										onPointerDown={e => handleDragStart(e, el)}
										data-elwrap='1'
										className={`absolute select-none group ${el.locked ? '' : 'cursor-grab'}`}
										style={{
											left: el.x,
											top: el.y,
											width: el.width,
											height: el.height,
											zIndex: el.zIndex,
											opacity: el.visible
												? Math.max(el.opacity ?? 1, 0.08)
												: 0.35,
											outline:
												selectedId === el.id
													? `${2 / view.s}px solid rgb(var(--c-accent2))`
													: selectedIds.has(el.id)
														? `${1.5 / view.s}px solid rgb(var(--c-accent2) / .6)`
														: undefined,
											transform:
												`${el.rotation ? `rotate(${el.rotation}deg)` : ''}${el.flipH || el.flipV ? ` scale(${el.flipH ? -1 : 1}, ${el.flipV ? -1 : 1})` : ''}` ||
												undefined,
											touchAction: 'none',
										}}
										onPointerEnter={
											isMedia
												? () => chromeCtlRefs.current.get(el.id)?.enter()
												: undefined
										}
										onPointerMove={
											isMedia
												? () => chromeCtlRefs.current.get(el.id)?.note()
												: undefined
										}
										onPointerLeave={
											isMedia
												? () => chromeCtlRefs.current.get(el.id)?.leave()
												: undefined
										}
									>
										<PreviewElement
											el={el}
											scale={1}
											interactive={interactiveIframeId === el.id}
											mounted={mounted}
											mediaSt={mediaStates.get(el.id)}
											chromeRegister={registerChromeCtl}
											mediaToggle={mediaToggle}
											mediaSelect={setSelectedId}
											mediaCommand={mediaCommand}
											onTwitchPlayer={onTwitchPlayer}
										/>
										{(() => {
											const l = elementLocks[el.id]
											return l &&
												l.until > Date.now() &&
												l.by !== (userLogin ?? '') ? (
												<div
													className='absolute pointer-events-none select-none'
													style={{
														left: 0,
														top: -24 / view.s,
														transform: `scale(${1 / view.s})`,
														transformOrigin: '0 0',
													}}
												>
													<span
														className='inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold text-white'
														style={{
															background: 'rgb(var(--c-accent))',
															boxShadow: '0 1px 4px rgba(0,0,0,.4)',
														}}
													>
														✋ {l.by}
													</span>
												</div>
											) : null
										})()}
										{/* слой ручек: контр-зеркалится, чтобы при flipH/flipV ручки не переворачивались вместе с элементом */}
										<div
											className='absolute inset-0 pointer-events-none'
											style={{
												transform: `scale(${el.flipH ? -1 : 1}, ${el.flipV ? -1 : 1})`,
											}}
										>
											{selectedId === el.id &&
												!el.locked &&
												(
													['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
												).map(dir => {
													const cursors: Record<string, string> = {
														n: 'ns-resize',
														s: 'ns-resize',
														e: 'ew-resize',
														w: 'ew-resize',
														ne: 'nesw-resize',
														sw: 'nesw-resize',
														nw: 'nwse-resize',
														se: 'nwse-resize',
													}
													const pos: React.CSSProperties = {
														position: 'absolute',
														width: hs,
														height: hs,
														pointerEvents: 'auto',
														background: 'rgb(var(--c-accent2))',
														border: `${2 / view.s}px solid #fff`,
														borderRadius: 2,
														cursor: cursors[dir],
													}
													if (dir.includes('n')) pos.top = -hs / 2
													if (dir.includes('s')) pos.bottom = -hs / 2
													if (dir.includes('e')) pos.right = -hs / 2
													if (dir.includes('w')) pos.left = -hs / 2
													if (dir === 'n' || dir === 's') {
														pos.left = '50%'
														pos.marginLeft = -hs / 2
													}
													if (dir === 'e' || dir === 'w') {
														pos.top = '50%'
														pos.marginTop = -hs / 2
													}
													return (
														<div
															key={dir}
															onPointerDown={e => handleResizeStart(e, el, dir)}
															className='handle'
															style={pos}
														/>
													)
												})}
											{el.type === 'iframe' &&
												selectedId === el.id &&
												!el.locked && (
													<div
														onPointerDown={e => {
															e.stopPropagation()
															handleDragStart(e, el)
														}}
														className='absolute flex items-center justify-center rounded-full pointer-events-auto'
														style={{
															left: `calc(50% - ${11 / view.s}px)`,
															top: -60 / view.s,
															width: 22 / view.s,
															height: 22 / view.s,
															background: 'rgb(var(--c-accent2))',
															border: `${2 / view.s}px solid #fff`,
															cursor: 'move',
															boxShadow: '0 1px 6px rgba(0,0,0,.5)',
														}}
													>
														<svg
															width={(22 / view.s) * 0.55}
															height={(22 / view.s) * 0.55}
															viewBox='0 0 24 24'
															fill='#fff'
														>
															<path d='M12 1.5 15.5 5h-2.5v4.5h-2V5H8.5L12 1.5z' />
															<path d='M12 22.5 8.5 19H11v-4.5h2V19h2.5L12 22.5z' />
															<path d='M1.5 12 5 8.5V11h4.5v2H5v2.5L1.5 12z' />
															<path d='M22.5 12 19 15.5V13h-4.5v-2H19V8.5L22.5 12z' />
														</svg>
													</div>
												)}
											{!el.locked && (
												<div
													onPointerDown={e => handleRotateStart(e, el)}
													title='Повернуть (Shift — шаг 15°)'
													className={`absolute rounded-full flex items-center justify-center transition-opacity pointer-events-auto ${selectedId === el.id ? '' : 'opacity-0 group-hover:opacity-100'}`}
													style={{
														left: `calc(50% - ${11 / view.s}px)`,
														top: -32 / view.s,
														width: 22 / view.s,
														height: 22 / view.s,
														background: 'rgb(var(--c-accent))',
														border: `${2 / view.s}px solid #fff`,
														cursor: 'grab',
														boxShadow: '0 1px 6px rgba(0,0,0,.5)',
													}}
												>
													<svg
														width={12 / view.s}
														height={12 / view.s}
														viewBox='0 0 24 24'
														fill='none'
														stroke='#fff'
														strokeWidth='2.5'
														strokeLinecap='round'
														style={{
															transform: `rotate(${-(el.rotation ?? 0)}deg)`,
														}}
													>
														<path d='M21 12a9 9 0 1 1-2.64-6.36' />
														<path d='M21 3v6h-6' />
													</svg>
												</div>
											)}
										</div>
									</div>
								)
							})}
							{/* групповой бокс выделения (как в pogly): тянешь грани — двигается группа,
							 угловая ручка — масштабирует всю группу */}
							{groupBox && selectedIds.size > 1 && (
								<>
									<div
										className='absolute border border-dashed pointer-events-none'
										style={{
											left: groupBox.x,
											top: groupBox.y,
											width: groupBox.w,
											height: groupBox.h,
											borderColor: 'rgb(var(--c-accent2))',
										}}
									/>
									{(
										[
											[
												'n',
												groupBox.x + groupBox.w / 2 - 30,
												groupBox.y - 5,
												60,
												10,
											],
											[
												's',
												groupBox.x + groupBox.w / 2 - 30,
												groupBox.y + groupBox.h - 5,
												60,
												10,
											],
											[
												'w',
												groupBox.x - 5,
												groupBox.y + groupBox.h / 2 - 30,
												10,
												60,
											],
											[
												'e',
												groupBox.x + groupBox.w - 5,
												groupBox.y + groupBox.h / 2 - 30,
												10,
												60,
											],
										] as const
									).map(([k, left, top, w, h]) => (
										<div
											key={'edge-' + k}
											className='absolute pointer-events-auto'
											data-nopan='1'
											style={{
												left,
												top,
												width: w,
												height: h,
												cursor: 'move',
												touchAction: 'none',
											}}
											onPointerDown={startGroupMove}
										/>
									))}
									{(
										[
											['nw', groupBox.x, groupBox.y, 'nwse-resize'],
											[
												'ne',
												groupBox.x + groupBox.w,
												groupBox.y,
												'nesw-resize',
											],
											[
												'sw',
												groupBox.x,
												groupBox.y + groupBox.h,
												'nesw-resize',
											],
											[
												'se',
												groupBox.x + groupBox.w,
												groupBox.y + groupBox.h,
												'nwse-resize',
											],
										] as const
									).map(([corner, left, top, cursor]) => (
										<div
											key={corner}
											className='absolute pointer-events-auto'
											data-nopan='1'
											style={{
												left: left - 5 / view.s,
												top: top - 5 / view.s,
												width: 10 / view.s,
												height: 10 / view.s,
												background: 'rgb(var(--c-accent2))',
												border: `${2 / view.s}px solid #fff`,
												borderRadius: 2,
												cursor,
												touchAction: 'none',
											}}
											onPointerDown={e => startGroupScale(e, corner)}
										/>
									))}
								</>
							)}
							{/* курсоры других участников: контр-скейл, чтобы курсор был одного размера на любом зуме */}
							{remoteCursors
								.filter(c => !c.hidden)
								.map(c => (
									<div
										key={c.id}
										className='absolute pointer-events-none select-none'
										style={{
											left: c.x,
											top: c.y,
											zIndex: 3000,
											transform: `scale(${1 / view.s})`,
											transformOrigin: '0 0',
											transition: 'left 70ms linear, top 70ms linear',
										}}
									>
										<svg
											width='16'
											height='21'
											viewBox='0 0 24 28'
											style={{
												filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.55))',
											}}
										>
											<path
												d='M4 2l14.5 10.6-6.8.7L14.6 21l-3.4 1.4-2.9-7.7L4 18.4z'
												fill='rgb(var(--c-accent2))'
												stroke='#fff'
												strokeWidth='1.6'
												strokeLinejoin='round'
											/>
										</svg>
										<div
											className='ml-2 mt-0.5 inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold text-white'
											style={{
												background: 'rgb(var(--c-accent))',
												boxShadow: '0 1px 4px rgba(0,0,0,.4)',
											}}
										>
											{c.login}
										</div>
									</div>
								))}
						</div>
						{previewPill}
						{marquee && (
							<div
								className='absolute z-30 pointer-events-none border border-accent2 bg-accent2/20'
								style={{
									left: Math.min(marquee.x1, marquee.x2),
									top: Math.min(marquee.y1, marquee.y2),
									width: Math.abs(marquee.x2 - marquee.x1),
									height: Math.abs(marquee.y2 - marquee.y1),
								}}
							/>
						)}
						{dropHover && (
							<div className='absolute inset-0 z-30 pointer-events-none flex items-center justify-center bg-black/40 border-2 border-dashed border-accent rounded-lg'>
								<span className='text-sm text-gray-200 bg-panel/95 border border-border px-4 py-2 rounded-lg'>
									Отпустите файл — картинка, гифка или видео добавятся на канвас
								</span>
							</div>
						)}
						{isMobile ? (
							// мобильный: левый нижний угол — «− +» в ряд (шириной с «Сбросить»), «Сбросить» под ними
							<div
								className='absolute left-4 bottom-3 z-10 flex flex-col items-stretch gap-1.5'
								data-nopan='1'
								onPointerDown={e => e.stopPropagation()}
							>
								<div className='flex items-stretch gap-1.5'>
									<button
										onClick={() => zoomBy(1 / 1.25)}
										title='Уменьшить'
										className='flex-1 h-6 rounded-md bg-panel border border-border text-gray-400 hover:text-white flex items-center justify-center text-xs'
									>
										−
									</button>
									<button
										onClick={() => zoomBy(1.25)}
										title='Увеличить'
										className='flex-1 h-6 rounded-md bg-panel border border-border text-gray-400 hover:text-white flex items-center justify-center text-xs'
									>
										+
									</button>
								</div>
								<button
									onClick={() => {
										if (baseViewRef.current) setView(baseViewRef.current)
									}}
									className='h-6 rounded-md bg-panel border border-border px-2 text-[11px] text-gray-400 hover:text-white transition-colors'
								>
									Сбросить
								</button>
							</div>
						) : (
							// ПК: левый нижний угол — процент зума + / − / Сбросить в один ряд, под ними предупреждение об автоочистке
							<div
								className='absolute left-4 bottom-3 z-10 flex flex-col items-start gap-1'
								data-nopan='1'
								onPointerDown={e => e.stopPropagation()}
							>
								<div className='flex items-center gap-1.5'>
									<span className='flex items-center gap-1.5 bg-panel border border-border rounded-md px-2 py-1 text-[11px] font-medium text-accent2'>
										<svg
											width='11'
											height='11'
											viewBox='0 0 24 24'
											fill='none'
											stroke='currentColor'
											strokeWidth='2.5'
											strokeLinecap='round'
											aria-hidden='true'
										>
											<circle cx='11' cy='11' r='7' />
											<line x1='21' y1='21' x2='16.2' y2='16.2' />
										</svg>
										{Math.round(
											(view.s / (baseViewRef.current?.s ?? view.s)) * 100,
										)}
										%
									</span>
									<button
										onClick={() => zoomBy(1.25)}
										title='Увеличить'
										className='w-6 h-6 rounded-md bg-panel border border-border text-gray-400 hover:text-white flex items-center justify-center text-xs'
									>
										+
									</button>
									<button
										onClick={() => zoomBy(1 / 1.25)}
										title='Уменьшить'
										className='w-6 h-6 rounded-md bg-panel border border-border text-gray-400 hover:text-white flex items-center justify-center text-xs'
									>
										−
									</button>
									<button
										onClick={() => {
											if (baseViewRef.current) setView(baseViewRef.current)
										}}
										className='rounded-md bg-panel border border-border px-2 py-1 text-[11px] text-gray-400 hover:text-white transition-colors'
									>
										Сбросить
									</button>
								</div>
								<span
									className='pl-0.5 text-[10px] text-gray-500'
									style={{ textShadow: '0 1px 3px rgba(0,0,0,.6)' }}
								>
									Элементы удаляются через 3 часа без изменений
								</span>
							</div>
						)}
					</div>
				</div>

				{selected && (
					<aside
						className={`w-72 shrink-0 bg-panel border-l border-border p-4 overflow-y-auto ${isMobile ? 'hidden' : ''}`}
					>
						<PropertyEditor
							el={selected}
							update={partial => updateElement(selected.id, partial)}
							emit={emit}
						/>
					</aside>
				)}
			</div>

			<div className={`flex-1 overflow-auto ${tab === 'obs' ? '' : 'hidden'}`}>
				<ObsPanel />
			</div>

			{/* бургер-меню: вкладки, тема, статус */}
			{isMobile && menuOpen && (
				<>
					<div
						className={`fixed inset-0 z-40 ${menuClosing ? 'fade-out' : 'fade-in'}`}
						onClick={closeBurger}
					/>
					<div
						className={`fixed top-[60px] left-2 z-50 w-64 bg-panel border border-border rounded-xl p-2 shadow-xl space-y-1 ${menuClosing ? 'pop-out' : 'pop-in'}`}
						style={{ transformOrigin: 'top left' }}
					>
						<button
							onClick={() => {
								setTab('elements')
								closeBurger()
							}}
							className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-colors ${tab === 'elements' ? 'bg-accent text-white' : 'text-gray-300 hover:bg-border'}`}
						>
							Элементы оверлея
						</button>
						<button
							onClick={() => {
								setTab('obs')
								closeBurger()
							}}
							className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-colors ${tab === 'obs' ? 'bg-accent text-white' : 'text-gray-300 hover:bg-border'}`}
						>
							Управление OBS
						</button>
						<div className='h-px bg-border my-1' />
						<div className='flex items-center justify-between px-3 py-1.5'>
							<span className='text-sm text-gray-300'>
								Тема: {theme === 'dark' ? 'тёмная' : 'светлая'}
							</span>
							<button
								onClick={() => applyTheme(theme === 'dark' ? 'light' : 'dark')}
								className={`w-9 h-9 rounded-full bg-border flex items-center justify-center transition-colors ${theme === 'dark' ? 'text-gray-300' : 'text-[#443f66]'}`}
							>
								{theme === 'dark' ? <SunIcon /> : <MoonIcon />}
							</button>
						</div>
						<div className='flex items-center gap-2 px-3 py-1.5'>
							<span
								className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`}
							/>
							<span
								className={`text-sm ${connected ? 'text-green-400' : 'text-red-400'}`}
							>
								Сервер: {connected ? 'онлайн' : 'оффлайн'}
							</span>
						</div>
						<a
							href='https://dalink.to/jettle_'
							target='_blank'
							rel='noopener noreferrer'
							className='block px-3 py-1.5 text-sm text-accent2 hover:bg-border rounded-lg'
						>
							Поддержать проект ❤️
						</a>
					</div>
				</>
			)}

			{/* мобильный тулбар: добавление элементов одним касанием */}
			{isMobile && (
				<div
					className='fixed inset-x-0 bottom-0 z-40 flex items-center justify-center px-3 pointer-events-none'
					style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
				>
					<div className='flex items-center gap-1 pointer-events-auto rounded-full border border-border bg-panel px-3 py-1'>
						<button
							title='Картинка'
							onClick={() => setAddSheet('image')}
							className='w-8 h-8 rounded-lg hover:bg-border active:bg-accent flex items-center justify-center text-sm'
						>
							🖼
						</button>
						<button
							title='Смайлик'
							onClick={openEmotePicker}
							className='w-8 h-8 rounded-lg hover:bg-border active:bg-accent flex items-center justify-center text-sm'
						>
							😀
						</button>
						<button
							title='Видео'
							onClick={() => setAddSheet('video')}
							className='w-8 h-8 rounded-lg hover:bg-border active:bg-accent flex items-center justify-center text-sm'
						>
							🎬
						</button>
						<button
							title='Сайт'
							onClick={addIframeEl}
							className='w-8 h-8 rounded-lg hover:bg-border active:bg-accent flex items-center justify-center text-sm'
						>
							🌐
						</button>
						<button
							title='Текст'
							onClick={addTextEl}
							className='w-8 h-8 rounded-lg hover:bg-border active:bg-accent flex items-center justify-center text-sm font-bold'
						>
							Т
						</button>
						<button
							title='Таймер'
							onClick={addTimerEl}
							className='w-8 h-8 rounded-lg hover:bg-border active:bg-accent flex items-center justify-center text-sm'
						>
							⏱
						</button>
						<button
							title={
								selected ? 'Свойства элемента' : 'Выберите элемент на холсте'
							}
							onClick={() => setSheetOpen(v => !v)}
							className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm ${sheetOpen && selected ? 'bg-accent text-white' : 'hover:bg-border'}`}
						>
							✏️
						</button>
					</div>
				</div>
			)}

			{/* мобильный шит: источник добавления — файл с устройства или ссылка */}
			{isMobile && addSheet && (
				<>
					<div
						className={`fixed inset-0 z-40 bg-black/50 ${addSheetClosing ? 'fade-out' : 'fade-in'}`}
						onClick={closeAddSheet}
					/>
					<div
						className={`fixed left-3 right-3 z-50 bg-panel border border-border rounded-2xl p-3 space-y-2 shadow-xl ${addSheetClosing ? 'pop-out' : 'pop-in'}`}
						style={{
							bottom: 'calc(76px + env(safe-area-inset-bottom))',
							transformOrigin: 'bottom center',
						}}
					>
						<p className='text-xs font-semibold text-gray-400 uppercase tracking-wide px-1 pt-1'>
							Добавить: {addSheet === 'image' ? 'картинку' : 'видео'}
						</p>
						<button
							onClick={() => {
								const kind = addSheet
								closeAddSheet()
								if (kind === 'image') addImagePC()
								else addVideoPC()
							}}
							className='w-full px-3 py-2.5 bg-accent hover:bg-violet-700 text-white text-sm rounded-xl transition-colors'
						>
							📱 Файл с устройства
						</button>
						<button
							onClick={() => {
								const kind = addSheet
								closeAddSheet()
								if (kind === 'image') addImageUrl()
								else addVideoUrl()
							}}
							className='w-full px-3 py-2.5 bg-border hover:bg-gray-600 text-white text-sm rounded-xl transition-colors'
						>
							🔗 Вставить ссылку (URL)
						</button>
						<button
							onClick={closeAddSheet}
							className='w-full px-3 py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors'
						>
							Отмена
						</button>
					</div>
				</>
			)}

			{/* мобильная шторка свойств выбранного элемента */}
			{isMobile && sheetOpen && selected && (
				<div
					className='fixed left-0 right-0 z-40 max-h-[46dvh] overflow-y-auto bg-panel border-t border-border p-4'
					style={{ bottom: 'calc(76px + env(safe-area-inset-bottom))' }}
				>
					<div className='flex items-center justify-between mb-3'>
						<span className='text-xs font-semibold text-gray-400 uppercase tracking-wide'>
							Свойства: {selected.type}
						</span>
						<div className='flex items-center gap-2'>
							<button
								onClick={() => {
									emit('element:delete', selected.id)
									setSelectedId(null)
									setSheetOpen(false)
								}}
								className='px-2 py-1 text-xs text-red-400 border border-red-900/50 rounded-lg'
							>
								Удалить
							</button>
							<button
								onClick={() => setSheetOpen(false)}
								className='w-7 h-7 rounded-lg bg-border text-gray-400 hover:text-white'
							>
								✕
							</button>
						</div>
					</div>
					<PropertyEditor
						el={selected}
						update={partial => updateElement(selected.id, partial)}
						emit={emit}
					/>
				</div>
			)}

			{emoteOpen && (
				<div
					className='fixed inset-0 z-50 bg-black/60 flex items-center justify-center'
					onMouseDown={() => setEmoteOpen(false)}
				>
					<div
						className='bg-panel border border-border rounded-xl w-[620px] max-w-[94vw] max-h-[78vh] flex flex-col'
						onMouseDown={e => e.stopPropagation()}
					>
						<div className='flex items-center justify-between px-4 py-3 border-b border-border'>
							<h3 className='text-sm font-semibold'>
								Смайлики{' '}
								{channel ? (
									<span className='text-gray-500 font-normal'>
										· канал {channel}
									</span>
								) : (
									<span className='text-gray-500 font-normal'>
										· только глобальные
									</span>
								)}
							</h3>
							<div className='flex items-center gap-1'>
								<button
									onClick={openEmotePicker}
									title='Обновить — подтянуть свежие смайлики'
									className='w-7 h-7 rounded-lg hover:bg-border text-gray-400 hover:text-white transition-colors'
								>
									↻
								</button>
								<button
									onClick={() => setEmoteOpen(false)}
									className='w-7 h-7 rounded-lg hover:bg-border text-gray-400 hover:text-white transition-colors'
								>
									✕
								</button>
							</div>
						</div>
						<div className='flex items-center gap-2 px-4 py-2 border-b border-border'>
							<input
								value={emoteQuery}
								onChange={e => setEmoteQuery(e.target.value)}
								placeholder='Поиск по названию…'
								className='flex-1 px-3 py-1.5 bg-bg border border-border rounded-lg text-sm'
							/>
							<div className='flex gap-1'>
								{(
									[
										['all', 'Все'],
										['twitch', 'Twitch'],
										['7tv', '7TV'],
										['bttv', 'BTTV'],
										['ffz', 'FFZ'],
									] as const
								).map(([k, label]) => (
									<button
										key={k}
										onClick={() => setEmotePlatform(k)}
										className={`px-2 py-1 text-xs rounded-lg transition-colors ${emotePlatform === k ? 'bg-accent text-white' : 'text-gray-400 hover:bg-border'}`}
									>
										{label}
									</button>
								))}
							</div>
						</div>
						<div className='flex-1 overflow-y-auto p-3'>
							{emoteNotes.map((n, i) => (
								<p
									key={i}
									className='text-xs text-amber-400/90 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2 mb-3'
								>
									{n}
								</p>
							))}
							{emoteLoading ? (
								<p className='text-sm text-gray-500 text-center py-10'>
									Загружаем смайлики с Twitch, 7TV, BetterTTV и FrankerFaceZ…
								</p>
							) : emoteError && emotes.length === 0 ? (
								<p className='text-sm text-red-400 text-center py-10'>
									{emoteError}
								</p>
							) : (
								(() => {
									const q = emoteQuery.trim().toLowerCase()
									const list = emotes.filter(
										e =>
											(emotePlatform === 'all' ||
												e.platform === emotePlatform) &&
											(!q || e.code.toLowerCase().includes(q)),
									)
									if (!list.length)
										return (
											<p className='text-sm text-gray-500 text-center py-10'>
												Ничего не найдено
											</p>
										)
									return (
										<div className='grid grid-cols-6 gap-1.5'>
											{list.slice(0, 300).map((e, i) => (
												<button
													key={e.platform + e.code + i}
													onClick={() => addEmote(e)}
													title={`${e.code} · ${e.platform}`}
													className='flex flex-col items-center gap-1 px-1 py-2 rounded-lg hover:bg-border transition-colors'
												>
													<img
														src={e.url}
														alt={e.code}
														className='w-9 h-9 object-contain'
														loading='lazy'
													/>
													<span className='text-[10px] text-gray-500 truncate w-full text-center'>
														{e.code}
													</span>
												</button>
											))}
										</div>
									)
								})()
							)}
						</div>
						<div className='px-4 py-2 border-t border-border text-[10px] text-gray-500'>
							Клик по смайлику — добавить на холст
							{emotes.length ? ` · синхронизировано: ${emotes.length}` : ''}
						</div>
					</div>
				</div>
			)}
		</div>
	)
}

function SunIcon() {
	return (
		<svg
			width='14'
			height='14'
			viewBox='0 0 24 24'
			fill='none'
			stroke='currentColor'
			strokeWidth='2'
			strokeLinecap='round'
			strokeLinejoin='round'
			aria-hidden='true'
		>
			<circle cx='12' cy='12' r='5' />
			<line x1='12' y1='1' x2='12' y2='3' />
			<line x1='12' y1='21' x2='12' y2='23' />
			<line x1='4.22' y1='4.22' x2='5.64' y2='5.64' />
			<line x1='18.36' y1='18.36' x2='19.78' y2='19.78' />
			<line x1='1' y1='12' x2='3' y2='12' />
			<line x1='21' y1='12' x2='23' y2='12' />
			<line x1='4.22' y1='19.78' x2='5.64' y2='18.36' />
			<line x1='18.36' y1='5.64' x2='19.78' y2='4.22' />
		</svg>
	)
}

function MoonIcon() {
	return (
		<svg
			width='14'
			height='14'
			viewBox='0 0 24 24'
			fill='none'
			stroke='currentColor'
			strokeWidth='2'
			strokeLinecap='round'
			strokeLinejoin='round'
			aria-hidden='true'
		>
			<path d='M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' />
		</svg>
	)
}

function PreviewElement({
	el,
	scale,
	interactive,
	mounted,
	mediaSt,
	chromeRegister,
	mediaToggle,
	mediaSelect,
	mediaCommand,
	onTwitchPlayer,
}: {
	el: StreamElement
	scale: number
	interactive?: boolean
	mounted?: boolean
	mediaSt?: MediaSt
	chromeRegister?: (id: string, ctl: ChromeCtl | null) => void
	mediaToggle?: (id: string) => void
	mediaSelect?: (id: string) => void
	mediaCommand?: (id: string, cmd: string, value?: number) => void
	onTwitchPlayer?: (id: string, p: any | null) => void
}) {
	if (el.type === 'image' || el.type === 'gif')
		return (
			<img
				src={el.src}
				alt=''
				className='w-full h-full object-fill pointer-events-none'
				draggable={false}
			/>
		)
	if (el.type === 'iframe') {
		const info = parseMediaUrl(el.src || '')
		if (
			info &&
			chromeRegister &&
			mediaToggle &&
			mediaSelect &&
			mediaCommand &&
			onTwitchPlayer
		) {
			// медиа (YouTube/Twitch): чистый кадр + своя панель управления;
			// iframe рендерится только после монтирования (origin известен только на клиенте)
			return (
				<>
					{mounted ? (
						info.kind === 'youtube' ? (
							<iframe
								src={youtubeEmbedUrl(info.id, window.location.origin)}
								title='media'
								data-id={el.id}
								className='w-full h-full'
								style={{ border: 0, pointerEvents: 'none' }}
								allow='autoplay; fullscreen'
								sandbox='allow-modals allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation'
							/>
						) : (
							<TwitchFrame el={el} onPlayer={onTwitchPlayer} />
						)
					) : (
						<div className='w-full h-full' style={{ background: '#000' }} />
					)}
					<MediaChrome
						el={el}
						st={mediaSt}
						register={chromeRegister}
						toggle={mediaToggle}
						select={mediaSelect}
						command={mediaCommand}
					/>
				</>
			)
		}
		return (
			<iframe
				src={toEmbedUrl(el.src || '')}
				title='embed'
				data-id={el.id}
				className='w-full h-full'
				style={{ border: 0, pointerEvents: interactive ? 'auto' : 'none' }}
				allow='autoplay; encrypted-media; picture-in-picture; fullscreen'
				allowFullScreen
			/>
		)
	}
	if (el.type === 'video')
		return (
			<video
				src={el.src}
				className='w-full h-full object-fill pointer-events-none'
				muted
				loop
				autoPlay
				playsInline
			/>
		)
	if (el.type === 'text')
		return (
			<div
				className='w-full h-full flex items-center justify-center pointer-events-none overflow-hidden'
				style={{
					fontSize: (el.fontSize || 24) * scale,
					color: el.color || '#fff',
					fontWeight: el.fontWeight || 'normal',
					background: el.bgColor === 'transparent' ? 'none' : el.bgColor,
					textAlign: 'center',
				}}
			>
				{el.text}
			</div>
		)
	if (el.type === 'timer') return <TimerPreview el={el} scale={1} />
	return null
}

function TimerPreview({ el, scale }: { el: StreamElement; scale: number }) {
	const [, force] = useState(0)
	const playedRef = useRef(false)

	useEffect(() => {
		if (!el.isRunning) return
		const i = setInterval(() => force(x => x + 1), 250)
		return () => clearInterval(i)
	}, [el.isRunning])

	const elapsedMs =
		el.isRunning && el.startTime
			? Math.max(0, Date.now() - serverClockLag.ms - el.startTime) // serverClockLag: часы устройства могут расходиться с серверными
			: el.elapsed || 0
	const elapsedSec = Math.floor(elapsedMs / 1000)
	const display =
		el.timerDirection === 'down' && el.duration
			? formatTime(Math.max(0, el.duration - elapsedSec))
			: formatTime(elapsedSec)
	// звук окончания — и в панели тоже (однократно на каждый запуск)
	const remaining =
		el.timerDirection === 'down' && el.duration
			? el.duration - elapsedSec
			: null
	if (remaining !== null && remaining <= 0) {
		if (el.isRunning && !playedRef.current) {
			playedRef.current = true
			playFinishSound()
		}
		if (!el.isRunning) playedRef.current = false
	} else {
		playedRef.current = false
	}
	const bg = el.bgColor === 'transparent' ? 'none' : el.bgColor

	return (
		<div className='w-full h-full flex flex-col items-center justify-center pointer-events-none overflow-hidden'>
			{el.timerLabel && (
				<div
					style={{
						fontSize: (el.fontSize || 40) * 0.5 * scale,
						color: el.color,
						fontWeight: el.fontWeight,
						background: bg,
						padding: '2px 8px',
						borderRadius: 4,
						marginBottom: 4,
					}}
				>
					{el.timerLabel}
				</div>
			)}
			<div
				style={{
					fontSize: (el.fontSize || 40) * scale,
					color: el.color || '#fff',
					fontWeight: el.fontWeight || 'bold',
					background: bg,
					padding: '4px 12px',
					borderRadius: 6,
					fontFamily: 'monospace',
					letterSpacing: 2,
					whiteSpace: 'nowrap',
				}}
			>
				{display}
			</div>
		</div>
	)
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60)
	const s = seconds % 60
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function PropertyEditor({
	el,
	update,
	emit,
}: {
	el: StreamElement
	update: (partial: Partial<StreamElement>) => void
	emit: (e: string, d?: any) => void
}) {
	return (
		<div className='space-y-4'>
			<h2 className='text-sm font-semibold text-gray-400 uppercase tracking-wide'>
				Свойства: {el.type}
			</h2>
			<div className='grid grid-cols-2 gap-2'>
				<NumberField label='X' value={el.x} onChange={v => update({ x: v })} />
				<NumberField label='Y' value={el.y} onChange={v => update({ y: v })} />
				<NumberField
					label='Ширина'
					value={el.width}
					onChange={v => update({ width: v })}
				/>
				<NumberField
					label='Высота'
					value={el.height}
					onChange={v => update({ height: v })}
				/>
			</div>
			<div className='grid grid-cols-2 gap-2 items-end'>
				<NumberField
					label='Поворот (°)'
					value={el.rotation ?? 0}
					onChange={v => update({ rotation: ((v % 360) + 360) % 360 })}
				/>
				<button
					onClick={() => update({ rotation: 0 })}
					className='px-2 py-1.5 text-xs bg-border hover:bg-gray-600 rounded-lg'
				>
					⟲ Сброс
				</button>
			</div>
			<div className='flex gap-2'>
				<button
					onClick={() =>
						emit('element:reorder', { id: el.id, direction: 'up' })
					}
					className='flex-1 px-2 py-1.5 text-xs bg-border hover:bg-gray-600 rounded-lg'
				>
					↑ Вперёд
				</button>
				<button
					onClick={() =>
						emit('element:reorder', { id: el.id, direction: 'down' })
					}
					className='flex-1 px-2 py-1.5 text-xs bg-border hover:bg-gray-600 rounded-lg'
				>
					↓ Назад
				</button>
			</div>
			<div className='flex gap-2'>
				<button
					onClick={() =>
						emit('element:reorder', { id: el.id, direction: 'front' })
					}
					className='flex-1 px-2 py-1.5 text-xs bg-border hover:bg-gray-600 rounded-lg'
				>
					⤒ На самый верх
				</button>
				<button
					onClick={() =>
						emit('element:reorder', { id: el.id, direction: 'back' })
					}
					className='flex-1 px-2 py-1.5 text-xs bg-border hover:bg-gray-600 rounded-lg'
				>
					⤓ На самый низ
				</button>
			</div>
			<div className='grid grid-cols-2 gap-2'>
				<button
					onClick={() => update({ flipH: !el.flipH })}
					className={`px-2 py-1.5 text-xs rounded-lg transition-colors ${el.flipH ? 'bg-accent text-white' : 'bg-border hover:bg-gray-600'}`}
				>
					⇋ Отразить ↔
				</button>
				<button
					onClick={() => update({ flipV: !el.flipV })}
					className={`px-2 py-1.5 text-xs rounded-lg transition-colors ${el.flipV ? 'bg-accent text-white' : 'bg-border hover:bg-gray-600'}`}
				>
					⇅ Отразить ↕
				</button>
			</div>
			<button
				onClick={() =>
					emit('element:add', {
						...el,
						id: undefined,
						zIndex: undefined,
						locked: false,
						x: el.x + 30,
						y: el.y + 30,
					})
				}
				className='w-full px-3 py-2 bg-border hover:bg-gray-600 text-white text-sm rounded-lg'
			>
				⧉ Дублировать элемент
			</button>
			<div className='flex items-center justify-between gap-2'>
				<div>
					<label className='text-xs text-gray-500 block'>Замок</label>
					<p className='text-[10px] text-gray-600 leading-tight'>
						Защита от случайного перетаскивания
					</p>
				</div>
				<button
					onClick={() => update({ locked: !el.locked })}
					className={`w-9 h-5 rounded-full transition-colors shrink-0 relative ${el.locked ? 'bg-green-500' : 'bg-gray-600'}`}
				>
					<span
						className='absolute top-[2px] w-4 h-4 bg-white rounded-full transition-all'
						style={{ left: el.locked ? 18 : 2 }}
					/>
				</button>
			</div>
			<div className='flex items-center justify-between gap-2'>
				<div>
					<label className='text-xs text-gray-500 block'>Всегда загружен</label>
					<p className='text-[10px] text-gray-600 leading-tight'>
						Скрытый элемент остаётся загруженным и появляется мгновенно, без
						перезагрузки
					</p>
				</div>
				<button
					onClick={() => update({ alwaysLoaded: !el.alwaysLoaded })}
					className={`w-9 h-5 rounded-full transition-colors shrink-0 relative ${el.alwaysLoaded ? 'bg-green-500' : 'bg-gray-600'}`}
				>
					<span
						className='absolute top-[2px] w-4 h-4 bg-white rounded-full transition-all'
						style={{ left: el.alwaysLoaded ? 18 : 2 }}
					/>
				</button>
			</div>
			<div>
				<label className='text-xs text-gray-500 block mb-1'>
					Прозрачность: {Math.round((el.opacity ?? 1) * 100)}%
				</label>
				{(() => {
					// заливка заканчивается по центру кружка (кружок 14px) — не торчит на краях
					const pct = Math.round((el.opacity ?? 1) * 100)
					const frac = (pct / 100).toFixed(4)
					const edge = `calc(7px + (100% - 14px) * ${frac})`
					return (
						<input
							type='range'
							min={0}
							max={100}
							step={5}
							value={pct}
							onChange={e => update({ opacity: Number(e.target.value) / 100 })}
							className='w-full'
							style={{
								background: `linear-gradient(to right, rgb(var(--c-accent)) 0, rgb(var(--c-accent)) ${edge}, rgb(var(--c-border)) ${edge}, rgb(var(--c-border)) 100%)`,
							}}
						/>
					)
				})()}
				{Math.round((el.opacity ?? 1) * 100) === 0 && (
					<p className='text-[10px] text-gray-600 mt-1'>
						Элемент скрыт на стриме; в превью он еле заметен
					</p>
				)}
			</div>
			{el.type === 'text' && (
				<>
					<div>
						<label className='text-xs text-gray-500 block mb-1'>Текст</label>
						<textarea
							value={el.text || ''}
							onChange={e => update({ text: e.target.value })}
							className='w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm resize-none'
							rows={3}
						/>
					</div>
					<div className='grid grid-cols-2 gap-2'>
						<NumberField
							label='Шрифт'
							value={el.fontSize || 24}
							onChange={v => update({ fontSize: v })}
						/>
						<div>
							<label className='text-xs text-gray-500 block mb-1'>Цвет</label>
							<input
								type='color'
								value={el.color || '#ffffff'}
								onChange={e => update({ color: e.target.value })}
								className='w-full h-9 rounded-lg border border-border bg-bg cursor-pointer'
							/>
						</div>
					</div>
					<div className='grid grid-cols-2 gap-2'>
						<div>
							<label className='text-xs text-gray-500 block mb-1'>Фон</label>
							<input
								type='color'
								value={
									el.bgColor === 'transparent'
										? '#000000'
										: el.bgColor || '#000000'
								}
								onChange={e => update({ bgColor: e.target.value })}
								className='w-full h-9 rounded-lg border border-border bg-bg cursor-pointer'
							/>
						</div>
						<div>
							<label className='text-xs text-gray-500 block mb-1'>
								Прозр. фон
							</label>
							<button
								onClick={() => update({ bgColor: 'transparent' })}
								className='w-full px-2 py-2 text-xs bg-border hover:bg-gray-600 rounded-lg'
							>
								Убрать фон
							</button>
						</div>
					</div>
					<div>
						<label className='text-xs text-gray-500 block mb-1'>Жирность</label>
						<select
							value={el.fontWeight || 'normal'}
							onChange={e => update({ fontWeight: e.target.value })}
							className='w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm'
						>
							<option value='normal'>Обычный</option>
							<option value='bold'>Жирный</option>
						</select>
					</div>
				</>
			)}
			{el.type === 'timer' && (
				<>
					<div>
						<label className='text-xs text-gray-500 block mb-1'>
							Направление
						</label>
						<select
							value={el.timerDirection || 'down'}
							onChange={e =>
								update({ timerDirection: e.target.value as 'up' | 'down' })
							}
							className='w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm'
						>
							<option value='down'>Обратный отсчёт</option>
							<option value='up'>Прямой отсчёт</option>
						</select>
					</div>
					{el.timerDirection === 'down' && (
						<div className='grid grid-cols-2 gap-2'>
							<NumberField
								label='Минуты'
								value={Math.floor((el.duration || 0) / 60)}
								onChange={v =>
									update({ duration: v * 60 + ((el.duration || 0) % 60) })
								}
							/>
							<NumberField
								label='Секунды'
								value={(el.duration || 0) % 60}
								onChange={v =>
									update({
										duration: Math.floor((el.duration || 0) / 60) * 60 + v,
									})
								}
							/>
						</div>
					)}
					<div>
						<label className='text-xs text-gray-500 block mb-1'>Подпись</label>
						<input
							type='text'
							value={el.timerLabel || ''}
							onChange={e => update({ timerLabel: e.target.value })}
							placeholder='Таймер'
							className='w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm'
						/>
					</div>
					<div className='grid grid-cols-2 gap-2'>
						<div>
							<label className='text-xs text-gray-500 block mb-1'>Цвет</label>
							<input
								type='color'
								value={el.color || '#ffffff'}
								onChange={e => update({ color: e.target.value })}
								className='w-full h-9 rounded-lg border border-border bg-bg cursor-pointer'
							/>
						</div>
						<NumberField
							label='Шрифт'
							value={el.fontSize || 40}
							onChange={v => update({ fontSize: v })}
						/>
					</div>
					<div className='flex gap-2 pt-2'>
						{!el.isRunning ? (
							<button
								onClick={() => emit('timer:start', { id: el.id })}
								className='flex-1 px-3 py-2 bg-green-700 hover:bg-green-600 text-white text-sm rounded-lg'
							>
								▶ Старт
							</button>
						) : (
							<button
								onClick={() => emit('timer:pause', { id: el.id })}
								className='flex-1 px-3 py-2 bg-yellow-700 hover:bg-yellow-600 text-white text-sm rounded-lg'
							>
								⏸ Пауза
							</button>
						)}
						<button
							onClick={() => emit('timer:reset', { id: el.id })}
							className='flex-1 px-3 py-2 bg-border hover:bg-gray-600 text-white text-sm rounded-lg'
						>
							⏹ Сброс
						</button>
					</div>
				</>
			)}
			{(el.type === 'image' ||
				el.type === 'video' ||
				el.type === 'gif' ||
				el.type === 'iframe') && (
				<div>
					<label className='text-xs text-gray-500 block mb-1'>
						Источник (URL)
					</label>
					{el.type === 'iframe' && (
						<p className='text-xs text-gray-600 mb-1'>
							YouTube-ссылки автоматически конвертируются в embed
						</p>
					)}
					<input
						type='text'
						value={el.src?.startsWith('data:') ? '(файл с ПК)' : el.src || ''}
						onChange={e => update({ src: e.target.value })}
						placeholder='https://...'
						className='w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm'
					/>
				</div>
			)}
		</div>
	)
}

function NumberField({
	label,
	value,
	onChange,
}: {
	label: string
	value: number
	onChange: (v: number) => void
}) {
	return (
		<div>
			<label className='text-xs text-gray-500 block mb-1'>{label}</label>
			<input
				type='number'
				value={value}
				onChange={e => onChange(parseInt(e.target.value) || 0)}
				className='w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm'
			/>
		</div>
	)
}
