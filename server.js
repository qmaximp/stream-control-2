const { createServer } = require('http');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const CANVAS_W = 1920;
const CANVAS_H = 1080;

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res);
  });

  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    maxHttpBufferSize: 50 * 1024 * 1024,
  });

  // комнаты: у каждой ссылки (?room=токен) своё независимое состояние;
  // прямой доступ без ?room= попадает в общую комнату "default"
  const rooms = new Map(); // key -> { state: {elements, canvasW, canvasH}, lastActivity: number }

  function getRoom(key) {
    let r = rooms.get(key);
    if (!r) {
      r = {
        state: { elements: [], canvasW: CANVAS_W, canvasH: CANVAS_H },
        lastActivity: Date.now(),
      };
      rooms.set(key, r);
    }
    return r;
  }

  // автоочистка: 3 часа без изменений — элементы стираются (даже если вкладки открыты);
  // комната совсем без подключений удаляется через 12 часов
  const IDLE_CLEAR_MS = 3 * 60 * 60 * 1000;
  const ROOM_DELETE_MS = 12 * 60 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [key, r] of rooms) {
      if (r.state.elements.length > 0 && now - r.lastActivity > IDLE_CLEAR_MS) {
        r.state.elements = [];
        io.to(key).emit('elements:cleared');
        console.log('[ovrly] элементы очищены: 3 часа без изменений —', key.slice(0, 12));
      }
      const sockets = io.sockets.adapter.rooms.get(key);
      if ((!sockets || sockets.size === 0) && now - r.lastActivity > ROOM_DELETE_MS) {
        rooms.delete(key);
        console.log('[ovrly] комната удалена: 12 часов без подключений —', key.slice(0, 12));
      }
    }
  }, 60 * 1000);

  io.on('connection', (socket) => {
    // комната из handshake (?room=токен), иначе общая default-комната
    const room = ((socket.handshake.query.room || 'default') + '').slice(0, 64);
    socket.join(room);
    const roomRec = getRoom(room);
    const state = roomRec.state;

    // любое событие от клиента считается активностью и отодвигает автоочистку
    socket.use((event, next) => {
      roomRec.lastActivity = Date.now();
      next();
    });

    socket.emit('state:init', state);

    // живые курсоры: ретрансляция позиции мыши другим участникам комнаты.
    // Логин берём из handshake (?login=) — данные косметические, авторизация не нужна
    const cursorLogin = ((socket.handshake.query.login || 'гость') + '').slice(0, 40);

    socket.on('cursor:move', (data) => {
      if (!data || typeof data.x !== 'number' || typeof data.y !== 'number' || !isFinite(data.x) || !isFinite(data.y)) return;
      const x = Math.max(-100000, Math.min(100000, data.x));
      const y = Math.max(-100000, Math.min(100000, data.y));
      socket.broadcast.to(room).emit('cursor:update', { id: socket.id, login: cursorLogin, x, y, hidden: !!data.hidden });
    });

    socket.on('disconnect', () => {
      io.to(room).emit('cursor:leave', { id: socket.id });
    });

    socket.on('canvas:resize', (dims) => {
      state.canvasW = dims.w;
      state.canvasH = dims.h;
      io.to(room).emit('canvas:resize', dims);
    });

    socket.on('element:add', (el) => {
      el.id = el.id || Date.now() + '-' + Math.random().toString(36).slice(2, 9);
      el.zIndex = el.zIndex ?? state.elements.length;
      el.visible = el.visible ?? true;
      state.elements.push(el);
      io.to(room).emit('element:added', el);
    });

    socket.on('element:update', (partial) => {
      const idx = state.elements.findIndex(e => e.id === partial.id);
      if (idx >= 0) {
        state.elements[idx] = { ...state.elements[idx], ...partial };
        socket.broadcast.to(room).emit('element:updated', state.elements[idx]);
      }
    });

    socket.on('element:move', (data) => {
      const idx = state.elements.findIndex(e => e.id === data.id);
      if (idx >= 0) {
        state.elements[idx].x = data.x;
        state.elements[idx].y = data.y;
        socket.broadcast.to(room).emit('element:moved', data);
      }
    });

    socket.on('element:resize', (data) => {
      const idx = state.elements.findIndex(e => e.id === data.id);
      if (idx >= 0) {
        const el = state.elements[idx];
        if (data.x !== undefined) el.x = data.x;
        if (data.y !== undefined) el.y = data.y;
        el.width = data.width;
        el.height = data.height;
        socket.broadcast.to(room).emit('element:resized', data);
      }
    });

    socket.on('element:delete', (id) => {
      state.elements = state.elements.filter(e => e.id !== id);
      io.to(room).emit('element:deleted', id);
    });

    socket.on('element:reorder', ({ id, direction }) => {
      const idx = state.elements.findIndex(e => e.id === id);
      if (idx < 0) return;
      if (direction === 'front' || direction === 'back') {
        // прыжок на самый верх/низ с нормализацией zIndex в 0..n-1
        const zis = state.elements.map(e => e.zIndex);
        state.elements[idx].zIndex = direction === 'front' ? Math.max(...zis) + 1 : Math.min(...zis) - 1;
        state.elements.slice().sort((a, b) => a.zIndex - b.zIndex).forEach((e, i) => { e.zIndex = i; });
      } else {
        const swap = direction === 'up' ? idx + 1 : idx - 1;
        if (swap < 0 || swap >= state.elements.length) return;
        const zi = state.elements[idx].zIndex;
        state.elements[idx].zIndex = state.elements[swap].zIndex;
        state.elements[swap].zIndex = zi;
      }
      // рассылаем порядок именно по слоям, а не по порядку вставки
      io.to(room).emit('element:zorder', state.elements.slice().sort((a, b) => a.zIndex - b.zIndex).map(e => e.id));
    });

    socket.on('element:toggle-visible', (id) => {
      const idx = state.elements.findIndex(e => e.id === id);
      if (idx >= 0) {
        state.elements[idx].visible = !state.elements[idx].visible;
        socket.broadcast.to(room).emit('element:updated', state.elements[idx]);
      }
    });

    socket.on('timer:start', (data) => {
      const idx = state.elements.findIndex(e => e.id === data.id);
      if (idx >= 0) {
        const el = state.elements[idx];
        if (el.isRunning) return;
        let elapsed = el.elapsed || 0;
        if (el.timerDirection === 'down' && el.duration && elapsed >= el.duration * 1000) {
          elapsed = 0;
        }
        el.startTime = Date.now() - elapsed;
        el.isRunning = true;
        io.to(room).emit('element:updated', el);
      }
    });

    socket.on('timer:pause', (data) => {
      const idx = state.elements.findIndex(e => e.id === data.id);
      if (idx >= 0) {
        const el = state.elements[idx];
        if (el.isRunning && el.startTime) {
          el.elapsed = Date.now() - el.startTime;
        }
        el.isRunning = false;
        io.to(room).emit('element:updated', el);
      }
    });

    socket.on('timer:reset', (data) => {
      const idx = state.elements.findIndex(e => e.id === data.id);
      if (idx >= 0) {
        state.elements[idx].isRunning = false;
        state.elements[idx].startTime = null;
        state.elements[idx].elapsed = 0;
        io.to(room).emit('element:updated', state.elements[idx]);
      }
    });

    socket.on('element:command', (data) => {
      socket.broadcast.to(room).emit('element:command', data);
    });

    socket.on('elements:clear', () => {
      state.elements = [];
      io.to(room).emit('elements:cleared');
    });
  });

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log('\n  ➜  Panel:   http://localhost:' + port + '/panel');
    console.log('  ➜  Overlay: http://localhost:' + port + '/overlay\n');
  });
});
