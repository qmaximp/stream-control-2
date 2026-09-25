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

  const state = {
    elements: [],
    canvasW: CANVAS_W,
    canvasH: CANVAS_H,
  };

  io.on('connection', (socket) => {
    socket.emit('state:init', state);

    socket.on('canvas:resize', (dims) => {
      state.canvasW = dims.w;
      state.canvasH = dims.h;
      io.emit('canvas:resize', dims);
    });

    socket.on('element:add', (el) => {
      el.id = el.id || Date.now() + '-' + Math.random().toString(36).slice(2, 9);
      el.zIndex = el.zIndex ?? state.elements.length;
      el.visible = el.visible ?? true;
      state.elements.push(el);
      io.emit('element:added', el);
    });

    socket.on('element:update', (partial) => {
      const idx = state.elements.findIndex(e => e.id === partial.id);
      if (idx >= 0) {
        state.elements[idx] = { ...state.elements[idx], ...partial };
        socket.broadcast.emit('element:updated', state.elements[idx]);
      }
    });

    socket.on('element:move', (data) => {
      const idx = state.elements.findIndex(e => e.id === data.id);
      if (idx >= 0) {
        state.elements[idx].x = data.x;
        state.elements[idx].y = data.y;
        socket.broadcast.emit('element:moved', data);
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
        socket.broadcast.emit('element:resized', data);
      }
    });

    socket.on('element:delete', (id) => {
      state.elements = state.elements.filter(e => e.id !== id);
      io.emit('element:deleted', id);
    });

    socket.on('element:reorder', ({ id, direction }) => {
      const idx = state.elements.findIndex(e => e.id === id);
      if (idx < 0) return;
      const swap = direction === 'up' ? idx + 1 : idx - 1;
      if (swap < 0 || swap >= state.elements.length) return;
      const zi = state.elements[idx].zIndex;
      state.elements[idx].zIndex = state.elements[swap].zIndex;
      state.elements[swap].zIndex = zi;
      io.emit('element:zorder', state.elements.map(e => e.id));
    });

    socket.on('element:toggle-visible', (id) => {
      const idx = state.elements.findIndex(e => e.id === id);
      if (idx >= 0) {
        state.elements[idx].visible = !state.elements[idx].visible;
        socket.broadcast.emit('element:updated', state.elements[idx]);
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
        io.emit('element:updated', el);
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
        io.emit('element:updated', el);
      }
    });

    socket.on('timer:reset', (data) => {
      const idx = state.elements.findIndex(e => e.id === data.id);
      if (idx >= 0) {
        state.elements[idx].isRunning = false;
        state.elements[idx].startTime = null;
        state.elements[idx].elapsed = 0;
        io.emit('element:updated', state.elements[idx]);
      }
    });

    socket.on('elements:clear', () => {
      state.elements = [];
      io.emit('elements:cleared');
    });
  });

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log('\n  ➜  Panel:   http://localhost:' + port + '/panel');
    console.log('  ➜  Overlay: http://localhost:' + port + '/overlay\n');
  });
});
