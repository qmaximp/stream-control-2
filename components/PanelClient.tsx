"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { io as ioInit, Socket } from "socket.io-client";
import type { SyncState, StreamElement } from "@/lib/types";
import { toEmbedUrl } from "@/lib/embed";
import ObsPanel from "@/components/ObsPanel";

const CANVAS_W = 1920;
const CANVAS_H = 1080;

export default function PanelClient() {
  const [state, setState] = useState<SyncState>({ elements: [], canvasW: CANVAS_W, canvasH: CANVAS_H });
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<"elements" | "obs">("elements");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, s: 0.3 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [panning, setPanning] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const baseViewRef = useRef<{ x: number; y: number; s: number } | null>(null);

  useEffect(() => {
    const socket = ioInit({ transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("state:init", (s: SyncState) => setState(s));
    socket.on("element:added", (el: StreamElement) =>
      setState((p) => ({ ...p, elements: [...p.elements, el] }))
    );
    socket.on("element:updated", (el: StreamElement) =>
      setState((p) => ({
        ...p,
        elements: p.elements.map((e) => (e.id === el.id ? { ...e, ...el } : e)),
      }))
    );
    socket.on("element:moved", (d: { id: string; x: number; y: number }) =>
      setState((p) => ({
        ...p,
        elements: p.elements.map((e) => (e.id === d.id ? { ...e, x: d.x, y: d.y } : e)),
      }))
    );
    socket.on("element:resized", (d: { id: string; x?: number; y?: number; width: number; height: number }) =>
      setState((p) => ({
        ...p,
        elements: p.elements.map((e) =>
          e.id === d.id ? { ...e, x: d.x ?? e.x, y: d.y ?? e.y, width: d.width, height: d.height } : e
        ),
      }))
    );
    socket.on("element:deleted", (id: string) =>
      setState((p) => ({ ...p, elements: p.elements.filter((e) => e.id !== id) }))
    );
    socket.on("element:zorder", (ids: string[]) =>
      setState((p) => {
        const z = new Map(ids.map((id, i) => [id, i]));
        return { ...p, elements: p.elements.map((e) => ({ ...e, zIndex: z.get(e.id) ?? e.zIndex })) };
      })
    );
    socket.on("elements:cleared", () =>
      setState((p) => ({ ...p, elements: [] }))
    );

    return () => { socket.disconnect(); };
  }, []);

  const emit = useCallback((event: string, data?: any) => {
    socketRef.current?.emit(event, data);
  }, []);

  useEffect(() => {
    setTheme(document.documentElement.classList.contains("light") ? "light" : "dark");
  }, []);

  const applyTheme = useCallback((next: "dark" | "light") => {
    const root = document.documentElement;
    const isLight = root.classList.contains("light");
    if ((next === "light") === isLight) return;
    setTheme(next);
    root.classList.add("theme-anim");
    root.classList.toggle("light", next === "light");
    try { localStorage.setItem("theme", next); } catch {}
    window.setTimeout(() => root.classList.remove("theme-anim"), 450);
  }, []);

  // локально применяем мгновенно; на сервер уходит не чаще ~8 раз/с (склейка правок)
  const pendingUpdatesRef = useRef<Map<string, { partial: Partial<StreamElement>; timer: ReturnType<typeof setTimeout> }>>(new Map());

  const updateElement = useCallback((id: string, partial: Partial<StreamElement>) => {
    setState((p) => ({
      ...p,
      elements: p.elements.map((e) => (e.id === id ? { ...e, ...partial } : e)),
    }));
    const pending = pendingUpdatesRef.current.get(id);
    const merged = { ...(pending?.partial || {}), ...partial };
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      pendingUpdatesRef.current.delete(id);
      emit("element:update", { id, ...merged });
    }, 120);
    pendingUpdatesRef.current.set(id, { partial: merged, timer });
  }, [emit]);

  const addElement = useCallback(
    (el: Omit<StreamElement, "id" | "zIndex" | "visible">) => {
      emit("element:add", { ...el, visible: true });
    },
    [emit]
  );

  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = rej;
      r.readAsDataURL(file);
    });

  const selected = state.elements.find((e) => e.id === selectedId) || null;

  const parkingSpot = () => ({ x: -400, y: -400 });

  const dragRef = useRef<{ id: string; offX: number; offY: number } | null>(null);

  const handleDragStart = (e: React.MouseEvent, el: StreamElement) => {
    e.preventDefault();
    const { x: vx, y: vy, s } = viewRef.current;
    const rect = viewportRef.current!.getBoundingClientRect();
    const lx = (e.clientX - rect.left - vx) / s;
    const ly = (e.clientY - rect.top - vy) / s;
    dragRef.current = { id: el.id, offX: lx - el.x, offY: ly - el.y };
    setSelectedId(el.id);
  };

  // оптимистично двигаем локально; на сервер шлём не чаще ~30 раз/с, финал — на mouseup
  const moveThrottleRef = useRef(0);
  const lastMoveRef = useRef<{ id: string; x: number; y: number } | null>(null);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragRef.current || !viewportRef.current) return;
      const { x: vx, y: vy, s } = viewRef.current;
      const rect = viewportRef.current.getBoundingClientRect();
      const lx = (e.clientX - rect.left - vx) / s;
      const ly = (e.clientY - rect.top - vy) / s;
      const x = Math.round(lx - dragRef.current.offX);
      const y = Math.round(ly - dragRef.current.offY);
      const id = dragRef.current.id;
      setState((p) => ({
        ...p,
        elements: p.elements.map((el) => (el.id === id ? { ...el, x, y } : el)),
      }));
      lastMoveRef.current = { id, x, y };
      const now = performance.now();
      if (now - moveThrottleRef.current >= 33) {
        moveThrottleRef.current = now;
        emit("element:move", { id, x, y });
      }
    },
    [emit]
  );

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    if (lastMoveRef.current) {
      moveThrottleRef.current = 0;
      emit("element:move", lastMoveRef.current);
      lastMoveRef.current = null;
    }
  }, [emit]);

  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" || !selectedId) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      emit("element:delete", selectedId);
      setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, emit]);

  const resizeRef = useRef<{ id: string; dir: string; sx: number; sy: number; orig: StreamElement } | null>(null);
  const resizeThrottleRef = useRef(0);
  const lastResizeRef = useRef<{ id: string; x: number; y: number; width: number; height: number } | null>(null);

  const handleResizeStart = (e: React.MouseEvent, el: StreamElement, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      id: el.id, dir,
      sx: e.clientX, sy: e.clientY,
      orig: { ...el },
    };
  };

  const handleResizeMove = useCallback(
    (e: MouseEvent) => {
      if (!resizeRef.current || !viewportRef.current) return;
      const { dir, orig } = resizeRef.current;
      const { x: vx, y: vy, s } = viewRef.current;
      const rect = viewportRef.current.getBoundingClientRect();
      const lx = (e.clientX - rect.left - vx) / s;
      const ly = (e.clientY - rect.top - vy) / s;
      let width, height, x, y;
      if (dir.length === 2 && e.shiftKey) {
        const ox = dir.includes("w") ? orig.x + orig.width : orig.x;
        const oy = dir.includes("n") ? orig.y + orig.height : orig.y;
        const k = Math.max(
          Math.abs(lx - ox) / Math.max(orig.width, 1),
          Math.abs(ly - oy) / Math.max(orig.height, 1)
        );
        width = Math.max(30, Math.round(orig.width * k));
        height = Math.max(20, Math.round(orig.height * k));
        x = Math.round(dir.includes("w") ? ox - width : orig.x);
        y = Math.round(dir.includes("n") ? oy - height : orig.y);
      } else {
        const dx = (e.clientX - resizeRef.current.sx) / s;
        const dy = (e.clientY - resizeRef.current.sy) / s;
        let dw = 0, dh = 0;
        if (dir.includes("e")) dw = dx;
        if (dir.includes("w")) dw = -dx;
        if (dir.includes("s")) dh = dy;
        if (dir.includes("n")) dh = -dy;
        width = Math.max(30, Math.round(orig.width + dw));
        height = Math.max(20, Math.round(orig.height + dh));
        x = Math.round(orig.x + (dir.includes("w") ? orig.width - width : 0));
        y = Math.round(orig.y + (dir.includes("n") ? orig.height - height : 0));
      }
      setState((p) => ({
        ...p,
        elements: p.elements.map((el) => (el.id === orig.id ? { ...el, x, y, width, height } : el)),
      }));
      lastResizeRef.current = { id: orig.id, x, y, width, height };
      const now = performance.now();
      if (now - resizeThrottleRef.current >= 33) {
        resizeThrottleRef.current = now;
        emit("element:resize", { id: orig.id, x, y, width, height });
      }
    },
    [emit]
  );

  useEffect(() => {
    const fn = () => {
      resizeRef.current = null;
      if (lastResizeRef.current) {
        resizeThrottleRef.current = 0;
        emit("element:resize", lastResizeRef.current);
        lastResizeRef.current = null;
      }
    };
    window.addEventListener("mouseup", fn);
    window.addEventListener("mousemove", handleResizeMove);
    return () => {
      window.removeEventListener("mouseup", fn);
      window.removeEventListener("mousemove", handleResizeMove);
    };
  }, [handleResizeMove, emit]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || baseViewRef.current) return;
    const s = Math.min((vp.clientWidth - 80) / state.canvasW, (vp.clientHeight - 80) / state.canvasH);
    const base = { s, x: (vp.clientWidth - state.canvasW * s) / 2, y: (vp.clientHeight - state.canvasH * s) / 2 };
    baseViewRef.current = base;
    setView(base);
  }, [state.canvasW, state.canvasH]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const { x, y, s } = viewRef.current;
      const ns = Math.min(200, Math.max(0.001, s * factor));
      if (ns === s) return;
      const rect = vp.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      setView({ s: ns, x: mx - ((mx - x) / s) * ns, y: my - ((my - y) / s) * ns });
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const down = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      panRef.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
      setPanning(true);
    };
    const move = (e: MouseEvent) => {
      const p = panRef.current;
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      setView((v) => ({ ...v, x: p.vx + dx, y: p.vy + dy }));
    };
    const up = () => { panRef.current = null; setPanning(false); };
    vp.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      vp.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-bg">
      <header className="flex items-center gap-4 px-5 py-3 bg-panel border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-lg bg-accent flex items-center justify-center text-white font-bold text-lg">S</div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Stream Control</h1>
            <p className="text-xs text-gray-500 leading-tight">Панель модератора</p>
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-3">
          <button onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
            title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
            aria-label={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"}
            className={`w-9 h-9 rounded-full bg-border flex items-center justify-center transition-colors ${theme === "dark" ? "text-gray-300 hover:text-white" : "text-[#443f66] hover:text-[#3a3750]"}`}>
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <span className={`flex items-center gap-1.5 text-sm ${connected ? "text-green-400" : "text-red-400"}`}>
            <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} />
            {connected ? "Сервер: онлайн" : "Сервер: оффлайн"}
          </span>
          <a href="/overlay" target="_blank" className="text-sm text-accent2 hover:underline">Открыть оверлей ↗</a>
        </div>
      </header>

      <div className="flex gap-1 px-5 pt-3 bg-panel border-b border-border">
        <button
          onClick={() => setTab("elements")}
          className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${tab === "elements" ? "bg-bg text-[color:var(--c-on-bg)] border-b-2 border-accent" : "text-gray-500 hover:text-gray-300"}`}
        >Элементы оверлея</button>
        <button
          onClick={() => setTab("obs")}
          className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${tab === "obs" ? "bg-bg text-[color:var(--c-on-bg)] border-b-2 border-accent" : "text-gray-500 hover:text-gray-300"}`}
        >Управление OBS</button>
      </div>

      <div className={`flex-1 flex overflow-hidden ${tab === "elements" ? "" : "hidden"}`}>
          <aside className="w-72 shrink-0 bg-panel border-r border-border p-4 overflow-y-auto">
            <h2 className="text-sm font-semibold mb-3 text-gray-400 uppercase tracking-wide">Добавить элемент</h2>
            <div className="space-y-2">
              <div className="flex gap-2">
                <button onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file"; input.accept = "image/*";
                  input.onchange = async () => {
                    const f = input.files?.[0]; if (!f) return;
                    const dataUrl = await fileToDataUrl(f);
                    const p = parkingSpot();
                    addElement({ type: "image", src: dataUrl, ...p, width: 400, height: 225, text: "" });
                  };
                  input.click();
                }} className="flex-1 px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors">🖼 С ПК</button>
                <button onClick={() => {
                  const url = prompt("Ссылка на картинку:");
                  const p = parkingSpot();
                  if (url) addElement({ type: "image", src: url, ...p, width: 400, height: 225, text: "" });
                }} className="flex-1 px-3 py-2 bg-border hover:bg-gray-600 text-white text-sm rounded-lg transition-colors">🔗 URL</button>
              </div>
              <div className="flex gap-2">
                <button onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file"; input.accept = "video/*";
                  input.onchange = async () => {
                    const f = input.files?.[0]; if (!f) return;
                    if (f.size > 40 * 1024 * 1024) { alert("Файл больше 40 МБ. Лучше использовать ссылку."); return; }
                    const dataUrl = await fileToDataUrl(f);
                    const p = parkingSpot();
                    addElement({ type: "video", src: dataUrl, ...p, width: 480, height: 270, text: "" });
                  };
                  input.click();
                }} className="flex-1 px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors">🎬 С ПК</button>
                <button onClick={() => {
                  const url = prompt("Ссылка на видео (MP4, WebM):");
                  const p = parkingSpot();
                  if (url) addElement({ type: "video", src: url, ...p, width: 480, height: 270, text: "" });
                }} className="flex-1 px-3 py-2 bg-border hover:bg-gray-600 text-white text-sm rounded-lg transition-colors">🔗 URL</button>
              </div>
              <button onClick={() => {
                const p = parkingSpot();
                const url = prompt("Ссылка на сайт или YouTube (например, https://youtube.com/watch?v=...):");
                if (url) addElement({ type: "iframe", src: url, ...p, width: 560, height: 315, text: "" });
              }} className="w-full px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors">🌐 Сайт / YouTube</button>
              <button onClick={() => {
                const p = parkingSpot();
                addElement({ type: "text", ...p, width: 300, height: 60, text: "Новый текст", fontSize: 36, color: "#ffffff", fontWeight: "bold", bgColor: "transparent" });
              }}
                className="w-full px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors">✏️ Текст</button>
              <button onClick={() => {
                const p = parkingSpot();
                addElement({ type: "timer", ...p, width: 200, height: 60, text: "", duration: 300, timerDirection: "down", fontSize: 40, color: "#ffffff", fontWeight: "bold", bgColor: "transparent", startTime: null, isRunning: false, timerLabel: "" });
              }}
                className="w-full px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors">⏱ Таймер</button>
            </div>

            <h2 className="text-sm font-semibold mt-6 mb-2 text-gray-400 uppercase tracking-wide">Элементы ({state.elements.length})</h2>
            <div className="space-y-1">
              {state.elements.map((el) => (
                <div key={el.id} onClick={() => setSelectedId(el.id)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-sm transition-colors ${selectedId === el.id ? "bg-accent text-white" : "hover:bg-border text-gray-300"}`}>
                  <button onClick={(e) => {
                    e.stopPropagation();
                    setState((p) => ({
                      ...p,
                      elements: p.elements.map((x) => (x.id === el.id ? { ...x, visible: !x.visible } : x)),
                    }));
                    emit("element:toggle-visible", el.id);
                  }} className="shrink-0">{el.visible ? "👁" : "🚫"}</button>
                  {el.alwaysLoaded && <span className="shrink-0 text-[10px] opacity-70" title="Всегда загружен">📦</span>}
                  <span className="flex-1 truncate">
                    {el.type === "image" && "🖼 " + (el.src?.slice(0, 20) || "image")}
                    {el.type === "video" && "🎬 " + (el.src?.slice(0, 20) || "video")}
                    {el.type === "gif" && "🎞 " + (el.src?.slice(0, 20) || "gif")}
                    {el.type === "iframe" && "🌐 " + (el.src?.slice(0, 25) || "embed")}
                    {el.type === "text" && "✏️ " + (el.text || "text")}
                    {el.type === "timer" && "⏱ " + (el.timerLabel || "timer")}
                  </span>
                  <button onClick={(e) => { e.stopPropagation(); emit("element:delete", el.id); if (selectedId === el.id) setSelectedId(null); }}
                    className="shrink-0 text-red-400 hover:text-red-300">✕</button>
                </div>
              ))}
              {state.elements.length === 0 && <p className="text-xs text-gray-600 px-2 py-4">Нет элементов. Добавьте сверху.</p>}
            </div>
            <button onClick={() => { if (confirm("Очистить все элементы?")) emit("elements:clear"); }}
              className="w-full mt-4 px-3 py-2 text-sm text-red-400 hover:bg-red-950/40 rounded-lg border border-red-900/50 transition-colors">Очистить всё</button>
          </aside>

          <div className="flex-1 flex flex-col bg-bg overflow-hidden">
            <div
              ref={viewportRef}
              className={`flex-1 relative overflow-hidden ${panning ? "cursor-grabbing" : ""}`}
              style={{
                background: "var(--c-canvas)",
                backgroundImage: "radial-gradient(var(--c-dot) 1px, transparent 1px)",
                backgroundSize: `${Math.max(4, 22 * view.s)}px ${Math.max(4, 22 * view.s)}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
              }}
              onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}
            >
              <div className="absolute left-0 top-0"
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: "0 0" }}>
                <div className="absolute bg-black border border-border rounded-md pointer-events-none"
                  style={{ left: 0, top: 0, width: state.canvasW, height: state.canvasH }}>
                  <div className="absolute inset-0 opacity-10" style={{ backgroundImage: "linear-gradient(#444 1px, transparent 1px), linear-gradient(90deg, #444 1px, transparent 1px)", backgroundSize: "40px 40px" }} />
                  <span className="absolute text-gray-600 pointer-events-none"
                    style={{ bottom: 8, right: 16, fontSize: 20 }}>экран {state.canvasW} × {state.canvasH}</span>
                </div>
                <span className="absolute text-center tracking-widest text-gray-600 uppercase pointer-events-none"
                  style={{ left: 0, top: -175, width: state.canvasW, fontSize: 28 }}>зона предзагрузки элементов</span>
                <span className="absolute text-center tracking-widest text-gray-600 uppercase pointer-events-none"
                  style={{ left: 0, top: state.canvasH + 175, width: state.canvasW, fontSize: 28 }}>зона предзагрузки элементов</span>
                <span className="absolute tracking-widest text-gray-600 uppercase pointer-events-none"
                  style={{ left: -175, top: 0, height: state.canvasH, writingMode: "vertical-rl", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>зона предзагрузки элементов</span>
                <span className="absolute tracking-widest text-gray-600 uppercase pointer-events-none"
                  style={{ left: state.canvasW + 175, top: 0, height: state.canvasH, writingMode: "vertical-rl", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>зона предзагрузки элементов</span>
                {state.elements.map((el) => {
                  const hs = 10 / view.s;
                  return (
                    <div key={el.id} onMouseDown={(e) => handleDragStart(e, el)}
                      className="absolute select-none cursor-grab"
                      style={{
                        left: el.x, top: el.y, width: el.width, height: el.height,
                        zIndex: el.zIndex, opacity: el.visible ? (el.opacity ?? 1) : 0.35,
                        outline: selectedId === el.id ? `${2 / view.s}px solid rgb(var(--c-accent2))` : undefined,
                      }}>
                      <PreviewElement el={el} scale={1} />
                      {selectedId === el.id && (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((dir) => {
                        const cursors: Record<string, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
                        const pos: React.CSSProperties = {
                          position: "absolute", width: hs, height: hs,
                          background: "rgb(var(--c-accent2))", border: `${2 / view.s}px solid #fff`,
                          borderRadius: 2, cursor: cursors[dir],
                        };
                        if (dir.includes("n")) pos.top = -hs / 2;
                        if (dir.includes("s")) pos.bottom = -hs / 2;
                        if (dir.includes("e")) pos.right = -hs / 2;
                        if (dir.includes("w")) pos.left = -hs / 2;
                        if (dir === "n" || dir === "s") { pos.left = "50%"; pos.marginLeft = -hs / 2; }
                        if (dir === "e" || dir === "w") { pos.top = "50%"; pos.marginTop = -hs / 2; }
                        return (
                          <div key={dir} onMouseDown={(e) => handleResizeStart(e, el, dir)} className="handle" style={pos} />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-2 px-6 pb-3">
              <span className="bg-panel border border-border rounded px-2 py-1 text-[10px] text-gray-400">🔍 {Math.round((view.s / (baseViewRef.current?.s ?? view.s)) * 100)}%</span>
              <button onClick={() => { if (baseViewRef.current) setView(baseViewRef.current); }}
                className="bg-panel border border-border rounded px-2 py-1 text-[10px] text-gray-400 hover:text-white transition-colors">Сбросить</button>
              <span className="bg-panel border border-border rounded px-2 py-1 text-[10px] text-gray-500">колесо — зум · зажатое колесо — панорама</span>
            </div>
          </div>

          <aside className="w-72 shrink-0 bg-panel border-l border-border p-4 overflow-y-auto">
            {selected ? <PropertyEditor el={selected} update={(partial) => updateElement(selected.id, partial)} emit={emit} /> : (
              <div className="text-sm text-gray-600 mt-4 text-center">Выберите элемент, чтобы изменить его свойства.</div>
            )}
          </aside>
        </div>
      <div className={`flex-1 overflow-auto ${tab === "obs" ? "" : "hidden"}`}>
        <ObsPanel />
      </div>
    </div>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function PreviewElement({ el, scale }: { el: StreamElement; scale: number }) {
  if (el.type === "image" || el.type === "gif") return <img src={el.src} alt="" className="w-full h-full object-fill pointer-events-none" draggable={false} />;
  if (el.type === "iframe")
    return (
      <iframe src={toEmbedUrl(el.src || "")} title="embed"
        className="w-full h-full pointer-events-none" style={{ border: 0 }}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
    );
  if (el.type === "video") return <video src={el.src} className="w-full h-full object-fill pointer-events-none" muted loop autoPlay playsInline />;
  if (el.type === "text") return (
    <div className="w-full h-full flex items-center justify-center pointer-events-none overflow-hidden"
      style={{ fontSize: (el.fontSize || 24) * scale, color: el.color || "#fff", fontWeight: el.fontWeight || "normal", background: el.bgColor === "transparent" ? "none" : el.bgColor, textAlign: "center" }}>
      {el.text}
    </div>
  );
  if (el.type === "timer") return <TimerPreview el={el} scale={1} />;
  return null;
}

function TimerPreview({ el, scale }: { el: StreamElement; scale: number }) {
  const [, force] = useState(0);

  useEffect(() => {
    if (!el.isRunning) return;
    const i = setInterval(() => force((x) => x + 1), 250);
    return () => clearInterval(i);
  }, [el.isRunning]);

  const elapsedMs = el.isRunning && el.startTime ? Date.now() - el.startTime : el.elapsed || 0;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const display = el.timerDirection === "down" && el.duration
    ? formatTime(Math.max(0, el.duration - elapsedSec))
    : formatTime(elapsedSec);
  const bg = el.bgColor === "transparent" ? "none" : el.bgColor;

  return (
    <div className="w-full h-full flex flex-col items-center justify-center pointer-events-none overflow-hidden">
      {el.timerLabel && (
        <div style={{ fontSize: (el.fontSize || 40) * 0.5 * scale, color: el.color, fontWeight: el.fontWeight, background: bg, padding: "2px 8px", borderRadius: 4, marginBottom: 4 }}>
          {el.timerLabel}
        </div>
      )}
      <div style={{ fontSize: (el.fontSize || 40) * scale, color: el.color || "#fff", fontWeight: el.fontWeight || "bold", background: bg, padding: "4px 12px", borderRadius: 6, fontFamily: "monospace", letterSpacing: 2, whiteSpace: "nowrap" }}>
        {display}
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function PropertyEditor({ el, update, emit }: { el: StreamElement; update: (partial: Partial<StreamElement>) => void; emit: (e: string, d?: any) => void }) {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Свойства: {el.type}</h2>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="X" value={el.x} onChange={(v) => update({ x: v })} />
        <NumberField label="Y" value={el.y} onChange={(v) => update({ y: v })} />
        <NumberField label="Ширина" value={el.width} onChange={(v) => update({ width: v })} />
        <NumberField label="Высота" value={el.height} onChange={(v) => update({ height: v })} />
      </div>
      <div className="flex gap-2">
        <button onClick={() => emit("element:reorder", { id: el.id, direction: "up" })} className="flex-1 px-2 py-1.5 text-xs bg-border hover:bg-gray-600 rounded-lg">↑ Вперёд</button>
        <button onClick={() => emit("element:reorder", { id: el.id, direction: "down" })} className="flex-1 px-2 py-1.5 text-xs bg-border hover:bg-gray-600 rounded-lg">↓ Назад</button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div>
          <label className="text-xs text-gray-500 block">Всегда загружен</label>
          <p className="text-[10px] text-gray-600 leading-tight">Скрытый элемент остаётся загруженным и появляется мгновенно, без перезагрузки</p>
        </div>
        <button onClick={() => update({ alwaysLoaded: !el.alwaysLoaded })}
          className={`w-9 h-5 rounded-full transition-colors shrink-0 relative ${el.alwaysLoaded ? "bg-green-500" : "bg-gray-600"}`}>
          <span className="absolute top-[2px] w-4 h-4 bg-white rounded-full transition-all"
            style={{ left: el.alwaysLoaded ? 18 : 2 }} />
        </button>
      </div>
      {(el.type === "image" || el.type === "video" || el.type === "gif" || el.type === "text") && (
        <div>
          <label className="text-xs text-gray-500 block mb-1">Прозрачность: {Math.round((el.opacity ?? 1) * 100)}%</label>
          {(() => {
            // заливка заканчивается по центру кружка (кружок 14px) — не торчит на краях
            const frac = ((Math.round((el.opacity ?? 1) * 100) - 10) / 90).toFixed(4);
            const edge = `calc(7px + (100% - 14px) * ${frac})`;
            return (
              <input type="range" min={10} max={100} step={5} value={Math.round((el.opacity ?? 1) * 100)}
                onChange={(e) => update({ opacity: Number(e.target.value) / 100 })}
                className="w-full"
                style={{ background: `linear-gradient(to right, rgb(var(--c-accent)) 0, rgb(var(--c-accent)) ${edge}, rgb(var(--c-border)) ${edge}, rgb(var(--c-border)) 100%)` }} />
            );
          })()}
        </div>
      )}
      {el.type === "text" && (
        <>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Текст</label>
            <textarea value={el.text || ""} onChange={(e) => update({ text: e.target.value })} className="w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm resize-none" rows={3} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="Шрифт" value={el.fontSize || 24} onChange={(v) => update({ fontSize: v })} />
            <div>
              <label className="text-xs text-gray-500 block mb-1">Цвет</label>
              <input type="color" value={el.color || "#ffffff"} onChange={(e) => update({ color: e.target.value })} className="w-full h-9 rounded-lg border border-border bg-bg cursor-pointer" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Фон</label>
              <input type="color" value={el.bgColor === "transparent" ? "#000000" : el.bgColor || "#000000"} onChange={(e) => update({ bgColor: e.target.value })} className="w-full h-9 rounded-lg border border-border bg-bg cursor-pointer" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Прозр. фон</label>
              <button onClick={() => update({ bgColor: "transparent" })} className="w-full px-2 py-2 text-xs bg-border hover:bg-gray-600 rounded-lg">Убрать фон</button>
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Жирность</label>
            <select value={el.fontWeight || "normal"} onChange={(e) => update({ fontWeight: e.target.value })} className="w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm">
              <option value="normal">Обычный</option><option value="bold">Жирный</option>
            </select>
          </div>
        </>
      )}
      {el.type === "timer" && (
        <>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Направление</label>
            <select value={el.timerDirection || "down"} onChange={(e) => update({ timerDirection: e.target.value as "up" | "down" })} className="w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm">
              <option value="down">Обратный отсчёт</option><option value="up">Прямой отсчёт</option>
            </select>
          </div>
          {el.timerDirection === "down" && (
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Минуты" value={Math.floor((el.duration || 0) / 60)} onChange={(v) => update({ duration: v * 60 + ((el.duration || 0) % 60) })} />
              <NumberField label="Секунды" value={(el.duration || 0) % 60} onChange={(v) => update({ duration: Math.floor((el.duration || 0) / 60) * 60 + v })} />
            </div>
          )}
          <div>
            <label className="text-xs text-gray-500 block mb-1">Подпись</label>
            <input type="text" value={el.timerLabel || ""} onChange={(e) => update({ timerLabel: e.target.value })} placeholder="Таймер" className="w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Цвет</label>
              <input type="color" value={el.color || "#ffffff"} onChange={(e) => update({ color: e.target.value })} className="w-full h-9 rounded-lg border border-border bg-bg cursor-pointer" />
            </div>
            <NumberField label="Шрифт" value={el.fontSize || 40} onChange={(v) => update({ fontSize: v })} />
          </div>
          <div className="flex gap-2 pt-2">
            {!el.isRunning ? (
              <button onClick={() => emit("timer:start", { id: el.id })} className="flex-1 px-3 py-2 bg-green-700 hover:bg-green-600 text-white text-sm rounded-lg">▶ Старт</button>
            ) : (
              <button onClick={() => emit("timer:pause", { id: el.id })} className="flex-1 px-3 py-2 bg-yellow-700 hover:bg-yellow-600 text-white text-sm rounded-lg">⏸ Пауза</button>
            )}
            <button onClick={() => emit("timer:reset", { id: el.id })} className="flex-1 px-3 py-2 bg-border hover:bg-gray-600 text-white text-sm rounded-lg">⏹ Сброс</button>
          </div>
        </>
      )}
      {(el.type === "image" || el.type === "video" || el.type === "gif" || el.type === "iframe") && (
        <div>
          <label className="text-xs text-gray-500 block mb-1">Источник (URL)</label>
          {el.type === "iframe" && <p className="text-xs text-gray-600 mb-1">YouTube-ссылки автоматически конвертируются в embed</p>}
          <input type="text" value={el.src?.startsWith("data:") ? "(файл с ПК)" : el.src || ""} onChange={(e) => update({ src: e.target.value })} placeholder="https://..." className="w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm" />
        </div>
      )}
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="text-xs text-gray-500 block mb-1">{label}</label>
      <input type="number" value={value} onChange={(e) => onChange(parseInt(e.target.value) || 0)} className="w-full px-2 py-1.5 bg-bg border border-border rounded-lg text-sm" />
    </div>
  );
}
