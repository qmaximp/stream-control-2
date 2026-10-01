const { createServer } = require('http')
const next = require('next')
const { Server } = require('socket.io')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

const CANVAS_W = 1920
const CANVAS_H = 1080

app.prepare().then(() => {
	const server = createServer((req, res) => {
		handle(req, res)
	})

	const io = new Server(server, {
		cors: { origin: '*', methods: ['GET', 'POST'] },
		maxHttpBufferSize: 50 * 1024 * 1024,
	})

	// комнаты: у каждой ссылки (?room=токен) своё независимое состояние;
	// прямой доступ без ?room= попадает в общую комнату "default"
	const rooms = new Map() // key -> { state: {elements, canvasW, canvasH}, lastActivity: number }

	function getRoom(key) {
		let r = rooms.get(key)
		if (!r) {
			r = {
				state: { elements: [], canvasW: CANVAS_W, canvasH: CANVAS_H },
				lastActivity: Date.now(),
			}
			rooms.set(key, r)
		}
		return r
	}

	// автоочистка: 3 часа без изменений — элементы стираются (даже если вкладки открыты);
	// комната совсем без подключений удаляется через 12 часов
	const IDLE_CLEAR_MS = 3 * 60 * 60 * 1000
	const ROOM_DELETE_MS = 12 * 60 * 60 * 1000
	setInterval(() => {
		const now = Date.now()
		for (const [key, r] of rooms) {
			if (r.state.elements.length > 0 && now - r.lastActivity > IDLE_CLEAR_MS) {
				r.state.elements = []
				io.to(key).emit('elements:cleared')
				console.log(
					'[ovrly] элементы очищены: 3 часа без изменений —',
					key.slice(0, 12),
				)
			}
			const sockets = io.sockets.adapter.rooms.get(key)
			if (
				(!sockets || sockets.size === 0) &&
				now - r.lastActivity > ROOM_DELETE_MS
			) {
				rooms.delete(key)
				console.log(
					'[ovrly] комната удалена: 12 часов без подключений —',
					key.slice(0, 12),
				)
			}
		}
	}, 60 * 1000)

	// владелец комнаты (стример) по токену ссылки: data/links.json — login -> { token }
	let linksCache = { mtime: 0, map: new Map() }
	function roomOwner(token) {
		try {
			const file = path.join(__dirname, 'data', 'links.json')
			const mtime = fs.statSync(file).mtimeMs
			if (linksCache.mtime !== mtime) {
				const map = new Map()
				const data = JSON.parse(fs.readFileSync(file, 'utf8'))
				for (const [login, rec] of Object.entries(data)) {
					if (rec && rec.token) map.set(rec.token, login)
				}
				linksCache = { mtime, map }
			}
			return linksCache.map.get(token) || null
		} catch {
			return null
		}
	}

	// доступ модератора к панели: приглашение принято и не отозвано/не приостановлено.
	// Проверяется на каждое действие — отзыв доступа действует мгновенно, без обновления страницы
	let invitesCache = { mtime: 0, data: {} }
	function invitesData() {
		try {
			const file = path.join(__dirname, 'data', 'invites.json')
			const mtime = fs.statSync(file).mtimeMs
			if (invitesCache.mtime !== mtime) {
				invitesCache = { mtime, data: JSON.parse(fs.readFileSync(file, 'utf8')) }
			}
			return invitesCache.data
		} catch {
			return {}
		}
	}
	function hasPanelAccess(room, login) {
		const owner = roomOwner(room)
		if (!owner) return false // комната без владельца — панель не отдаём
		if (login.toLowerCase() === owner.toLowerCase()) return true // стример — всегда
		const entry = invitesData()[owner]?.moderators?.[login]
		return !!entry && entry.status === 'accepted' && !entry.suspended
	}

	io.on('connection', socket => {
		// комната из handshake (?room=токен), иначе общая default-комната
		const room = ((socket.handshake.query.room || 'default') + '').slice(0, 64)
		socket.join(room)
		const roomRec = getRoom(room)
		const state = roomRec.state

		socket.emit('state:init', state)

		// живые курсоры: ретрансляция позиции мыши другим участникам комнаты.
		// Логин берём из handshake (?login=) — данные косметические, авторизация не нужна
		const userLogin = ((socket.handshake.query.login || 'гость') + '').slice(
			0,
			40,
		)
		roomRec.locks = roomRec.locks ?? new Map() // id элемента -> { socketId, login, until }
		// стример (владелец комнаты) может перехватывать элементы у модераторов всегда
		const isStreamer =
			!!roomOwner(room) && userLogin.toLowerCase() === roomOwner(room).toLowerCase()

		// мгновенная проверка доступа: у отозванного модератора соединение закрывается
		// и панель показывает «доступ отозван» (гость = оверлей, он только слушает)
		const isGuest = userLogin === 'гость' || userLogin === 'гость'.toLowerCase()
		if (!isGuest && !hasPanelAccess(room, userLogin)) {
			console.log('[io] доступ отозван, отключаю:', userLogin, 'room:', room.slice(0, 12))
			socket.emit('access:revoked')
			socket.disconnect(true)
			return
		}
		console.log('[io] connect:', socket.id, 'room:', room, 'login:', userLogin)

		// любое событие от клиента считается активностью и отодвигает автоочистку;
		// здесь же проверяем доступ: отзыв у модератора действует мгновенно
		socket.use((event, next) => {
			roomRec.lastActivity = Date.now()
			if (!isGuest && !isStreamer && !hasPanelAccess(room, userLogin)) {
				console.log('[io] доступ отозван на событии:', event, userLogin)
				socket.emit('access:revoked')
				socket.disconnect(true)
				return next(new Error('access revoked'))
			}
			next()
		})

		socket.on('cursor:move', data => {
			if (
				!data ||
				typeof data.x !== 'number' ||
				typeof data.y !== 'number' ||
				!isFinite(data.x) ||
				!isFinite(data.y)
			)
				return
			const x = Math.max(-100000, Math.min(100000, data.x))
			const y = Math.max(-100000, Math.min(100000, data.y))
			socket.broadcast.to(room).emit('cursor:update', {
				id: socket.id,
				login: userLogin,
				x,
				y,
				hidden: !!data.hidden,
			})
		})

		// блокировка объекта на время перетаскивания: пока один тащит, другой перехватить не может;
		// лок живёт 5 секунд после последнего движения (после остановки — ещё 5 секунд и свободно).
		// Исключение — стример: берёт элемент всегда, лок переходит к нему
		socket.on('element:grab', ({ id } = {}) => {
			if (!state.elements.some(e => e.id === id)) return
			const now = Date.now()
			const lock = roomRec.locks.get(id)
			const takenByOther =
				lock && lock.socketId !== socket.id && now < lock.until
			if (takenByOther && !isStreamer) return // занято другим
			if (takenByOther) {
				console.log(
					'[io] перехват стримером:',
					id.slice(0, 8),
					'был у',
					lock.login,
				)
			}
			roomRec.locks.set(id, {
				socketId: socket.id,
				login: userLogin,
				until: now + 5000,
			})
			io.to(room).emit('element:lock', { id, by: userLogin, until: now + 5000 })
		})

		socket.on('disconnect', () => {
			io.to(room).emit('cursor:leave', { id: socket.id })
			// снимаем локи отключившегося
			for (const [id, lock] of roomRec.locks) {
				if (lock.socketId === socket.id) {
					roomRec.locks.delete(id)
					io.to(room).emit('element:unlock', { id })
				}
			}
		})

		socket.on('canvas:resize', dims => {
			state.canvasW = dims.w
			state.canvasH = dims.h
			io.to(room).emit('canvas:resize', dims)
		})

		socket.on('element:add', el => {
			el.id = el.id || Date.now() + '-' + Math.random().toString(36).slice(2, 9)
			el.zIndex = el.zIndex ?? state.elements.length
			el.visible = el.visible ?? true
			state.elements.push(el)
			io.to(room).emit('element:added', el)
		})

		socket.on('element:update', partial => {
			const idx = state.elements.findIndex(e => e.id === partial.id)
			if (idx >= 0) {
				state.elements[idx] = { ...state.elements[idx], ...partial }
				socket.broadcast.to(room).emit('element:updated', state.elements[idx])
			}
		})

		socket.on('element:move', data => {
			const idx = state.elements.findIndex(e => e.id === data.id)
			if (idx >= 0) {
				const lock = roomRec.locks.get(data.id)
				const now = Date.now()
				if (lock && lock.socketId !== socket.id && now < lock.until) {
					if (!isStreamer) return // объект тащит другой
					// стример двигает чужой элемент — лок переходит к нему
					roomRec.locks.set(data.id, {
						socketId: socket.id,
						login: userLogin,
						until: now + 5000,
					})
					io.to(room).emit('element:lock', {
						id: data.id,
						by: userLogin,
						until: now + 5000,
					})
				} else if (lock && lock.socketId === socket.id) {
					lock.until = now + 5000 // продлеваем лок, пока тащат
				}
				state.elements[idx].x = data.x
				state.elements[idx].y = data.y
				socket.broadcast.to(room).emit('element:moved', data)
			}
		})

		socket.on('element:resize', data => {
			const idx = state.elements.findIndex(e => e.id === data.id)
			if (idx >= 0) {
				const lock = roomRec.locks.get(data.id)
				const now = Date.now()
				if (lock && lock.socketId !== socket.id && now < lock.until) {
					if (!isStreamer) return // объект тащит другой
					roomRec.locks.set(data.id, {
						socketId: socket.id,
						login: userLogin,
						until: now + 5000,
					})
					io.to(room).emit('element:lock', {
						id: data.id,
						by: userLogin,
						until: now + 5000,
					})
				} else if (lock && lock.socketId === socket.id) {
					lock.until = now + 5000
				}
				const el = state.elements[idx]
				if (data.x !== undefined) el.x = data.x
				if (data.y !== undefined) el.y = data.y
				el.width = data.width
				el.height = data.height
				socket.broadcast.to(room).emit('element:resized', data)
			}
		})

		socket.on('element:delete', id => {
			state.elements = state.elements.filter(e => e.id !== id)
			io.to(room).emit('element:deleted', id)
		})

		socket.on('element:reorder', ({ id, direction }) => {
			const idx = state.elements.findIndex(e => e.id === id)
			if (idx < 0) return
			if (direction === 'front' || direction === 'back') {
				// прыжок на самый верх/низ с нормализацией zIndex в 0..n-1
				const zis = state.elements.map(e => e.zIndex)
				state.elements[idx].zIndex =
					direction === 'front' ? Math.max(...zis) + 1 : Math.min(...zis) - 1
				state.elements
					.slice()
					.sort((a, b) => a.zIndex - b.zIndex)
					.forEach((e, i) => {
						e.zIndex = i
					})
			} else {
				const swap = direction === 'up' ? idx + 1 : idx - 1
				if (swap < 0 || swap >= state.elements.length) return
				const zi = state.elements[idx].zIndex
				state.elements[idx].zIndex = state.elements[swap].zIndex
				state.elements[swap].zIndex = zi
			}
			// рассылаем порядок именно по слоям, а не по порядку вставки
			io.to(room).emit(
				'element:zorder',
				state.elements
					.slice()
					.sort((a, b) => a.zIndex - b.zIndex)
					.map(e => e.id),
			)
		})

		socket.on('element:toggle-visible', id => {
			const idx = state.elements.findIndex(e => e.id === id)
			if (idx >= 0) {
				state.elements[idx].visible = !state.elements[idx].visible
				socket.broadcast.to(room).emit('element:updated', state.elements[idx])
			}
		})

		socket.on('timer:start', data => {
			const idx = state.elements.findIndex(e => e.id === data.id)
			if (idx >= 0) {
				const el = state.elements[idx]
				if (el.isRunning) return
				let elapsed = el.elapsed || 0
				if (
					el.timerDirection === 'down' &&
					el.duration &&
					elapsed >= el.duration * 1000
				) {
					elapsed = 0
				}
				el.startTime = Date.now() - elapsed
				el.isRunning = true
				io.to(room).emit('element:updated', el)
			}
		})

		socket.on('timer:pause', data => {
			const idx = state.elements.findIndex(e => e.id === data.id)
			if (idx >= 0) {
				const el = state.elements[idx]
				if (el.isRunning && el.startTime) {
					el.elapsed = Date.now() - el.startTime
				}
				el.isRunning = false
				io.to(room).emit('element:updated', el)
			}
		})

		socket.on('timer:reset', data => {
			const idx = state.elements.findIndex(e => e.id === data.id)
			if (idx >= 0) {
				state.elements[idx].isRunning = false
				state.elements[idx].startTime = null
				state.elements[idx].elapsed = 0
				io.to(room).emit('element:updated', state.elements[idx])
			}
		})

		// команды медиа-плееру из панели (плей/пауза/перемотка/звук/субтитры)
		socket.on('element:command', data => {
			if (!data || typeof data.id !== 'string' || typeof data.cmd !== 'string') return
			socket.broadcast.to(room).emit('element:command', data)
		})

		// оверлей (пере)подключился — панель с выбранным играющим элементом отдаст состояние
		socket.on('overlay:hello', () => {
			socket.broadcast.to(room).emit('overlay:hello')
		})

		socket.on('elements:clear', () => {
			state.elements = []
			io.to(room).emit('elements:cleared')
		})
	})

	const port = process.env.PORT || 3000
	server.listen(port, () => {
		console.log('  ➜  Main:   http://localhost:' + port)
		console.log('  ➜  Panel:   http://localhost:' + port + '/panel')
		console.log('  ➜  Overlay: http://localhost:' + port + '/overlay\n')
	})
})
