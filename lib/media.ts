// Медиа-ссылки: YouTube (видео) и Twitch (канал / VOD / клип).
// Такие ссылки в iframe-элементе получают медиа-обработку (чистый кадр + свой плеер),
// остальные URL остаются обычными сайтами.

export type MediaInfo =
	| { kind: 'youtube'; id: string }
	| { kind: 'twitch-channel'; channel: string }
	| { kind: 'twitch-vod'; id: string }
	| { kind: 'twitch-clip'; slug: string }

export function parseMediaUrl(raw: string): MediaInfo | null {
	const url = (raw || '').trim()
	if (!url) return null
	const withProto = /^https?:\/\//i.test(url) ? url : 'https://' + url
	try {
		const u = new URL(withProto)
		const host = u.hostname.toLowerCase().replace(/^www\./, '')
		if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
			let id = ''
			if (u.pathname === '/watch') id = u.searchParams.get('v') || ''
			else if (u.pathname.startsWith('/embed/') || u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/'))
				id = u.pathname.split('/')[2] || ''
			return id ? { kind: 'youtube', id } : null
		}
		if (host === 'youtu.be') {
			const id = u.pathname.slice(1).split('/')[0]
			return id ? { kind: 'youtube', id } : null
		}
		if (host === 'twitch.tv' || host === 'm.twitch.tv') {
			const parts = u.pathname.split('/').filter(Boolean)
			if (parts[0] === 'videos' && parts[1]) return { kind: 'twitch-vod', id: parts[1].replace(/^v/, '') }
			if (parts[0] === 'clip' && parts[1]) return { kind: 'twitch-clip', slug: parts[1] }
			if (parts[0]) return { kind: 'twitch-channel', channel: parts[0].toLowerCase() }
			return null
		}
		if (host === 'clips.twitch.tv') {
			const slug = u.pathname.slice(1).split('/')[0]
			return slug ? { kind: 'twitch-clip', slug } : null
		}
		if (host === 'player.twitch.tv') {
			const clip = u.searchParams.get('clip')
			const vid = u.searchParams.get('video')
			const ch = u.searchParams.get('channel')
			if (clip) return { kind: 'twitch-clip', slug: clip }
			if (vid) return { kind: 'twitch-vod', id: vid.replace(/^v/, '') }
			if (ch) return { kind: 'twitch-channel', channel: ch.toLowerCase() }
			const parts = u.pathname.split('/').filter(Boolean)
			if (parts[0] === 'videos' && parts[1]) return { kind: 'twitch-vod', id: parts[1].replace(/^v/, '') }
			if (parts[0]) return { kind: 'twitch-channel', channel: parts[0].toLowerCase() }
			return null
		}
		return null
	} catch {
		return null
	}
}

export function isMediaUrl(raw: string): boolean {
	return parseMediaUrl(raw) !== null
}

// origin ОБЯЗАТЕЛЕН: без него YouTube молча игнорирует postMessage-команды
// и не присылает состояние плеера. mute=1 обязателен: программный play() со звуком
// без жеста пользователя браузер блокирует — стартуем без звука, звук включается
// кнопкой в панели и ретранслируется на оверлей
export function youtubeEmbedUrl(id: string, origin: string, muted = true): string {
	const p = new URLSearchParams({
		enablejsapi: '1',
		controls: '0',
		rel: '0',
		iv_load_policy: '3',
		disablekb: '1',
		origin,
	})
	if (muted) p.set('mute', '1')
	return `https://www.youtube.com/embed/${id}?${p.toString()}`
}

// iframe Twitch без родных контролов (для страниц, где API не нужен)
export function twitchEmbedUrl(info: NonNullable<MediaInfo>, parent: string): string {
	const p = new URLSearchParams({ parent, controls: 'false' })
	if (info.kind === 'twitch-channel') p.set('channel', info.channel)
	if (info.kind === 'twitch-vod') p.set('video', info.id)
	if (info.kind === 'twitch-clip') p.set('clip', info.slug)
	return `https://player.twitch.tv?${p.toString()}`
}

// Twitch SDK (embed.twitch.tv/embed/v1.js) — единственный способ управлять
// плеером Twitch из JS (postMessage-команд у player.twitch.tv нет)
export function loadTwitchSdk(): Promise<any> {
	const w = window as any
	if (w.Twitch?.Player) return Promise.resolve(w.Twitch)
	return new Promise((res, rej) => {
		const s = document.createElement('script')
		s.src = 'https://embed.twitch.tv/embed/v1.js'
		s.onload = () => (w.Twitch?.Player ? res(w.Twitch) : rej(new Error('twitch sdk: нет Twitch.Player')))
		s.onerror = () => rej(new Error('twitch sdk: не загрузился'))
		document.head.appendChild(s)
	})
}
