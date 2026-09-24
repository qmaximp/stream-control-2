"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { io as ioInit, Socket } from "socket.io-client";
import type { SyncState, StreamElement } from "@/lib/types";
import { toEmbedUrl } from "@/lib/embed";
import ObsPanel from "@/components/ObsPanel";

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const BUFFER = 600;

export default function PanelClient() {
  const [state, setState] = useState<SyncState>({ elements: [], canvasW: CANVAS_W, canvasH: CANVAS_H });
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<"elements" | "obs">("elements");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

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

    return () => { socket.disconnect(); };
  }, []);

  const emit = useCallback((event: string, data?: any) => {
    socketRef.current?.emit(event, data);
  }, []);

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

  const parkingSpot = (w: number) => {
    const idx = state.elements.filter((e) => e.x + e.width <= 0).length;
    return { x: -(w + 40), y: -BUFFER + 40 + (idx % 20) * 140 };
  };

  const dragRef = useRef<{ id: string; offX: number; offY: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const getScale = () => {
    if (!previewRef.current) return 1;
    const w = previewRef.current.clientWidth;
    const h = previewRef.current.clientHeight;
    return Math.min(w / (state.canvasW + BUFFER * 2), h / (state.canvasH + BUFFER * 2));
  };

  const handleDragStart = (e: React.MouseEvent, el: StreamElement) => {
    e.preventDefault();
    const scale = getScale();
    const rect = previewRef.current!.getBoundingClientRect();
    const px = (e.clientX - rect.left) / scale - BUFFER;
    const py = (e.clientY - rect.top) / scale - BUFFER;
    dragRef.current = { id: el.id, offX: px - el.x, offY: py - el.y };
    setSelectedId(el.id);
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragRef.current) return;
      const scale = getScale();
      const rect = previewRef.current!.getBoundingClientRect();
      const px = (e.clientX - rect.left) / scale - BUFFER;
      const py = (e.clientY - rect.top) / scale - BUFFER;
      const x = Math.min(state.canvasW + BUFFER - 40, Math.max(-BUFFER, Math.round(px - dragRef.current.offX)));
      const y = Math.min(state.canvasH + BUFFER - 40, Math.max(-BUFFER, Math.round(py - dragRef.current.offY)));
      emit("element:move", { id: dragRef.current.id, x, y });
    },
    [emit, state.canvasW, state.canvasH]
  );

  const handleMouseUp = useCallback(() => { dragRef.current = null; }, []);

  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const resizeRef = useRef<{ id: string; dir: string; sx: number; sy: number; orig: StreamElement } | null>(null);

  const handleResizeStart = (e: React.MouseEvent, el: StreamElement, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    const scale = getScale();
    const rect = previewRef.current!.getBoundingClientRect();
    resizeRef.current = {
      id: el.id, dir,
      sx: (e.clientX - rect.left) / scale,
      sy: (e.clientY - rect.top) / scale,
      orig: { ...el },
    };
  };

  const handleResizeMove = useCallback(
    (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const scale = getScale();
      const rect = previewRef.current!.getBoundingClientRect();
      const { dir, orig } = resizeRef.current;
      const dx = (e.clientX - rect.left) / scale - resizeRef.current.sx;
      const dy = (e.clientY - rect.top) / scale - resizeRef.current.sy;
      let { x, y, width, height } = orig;
      if (dir.includes("e")) width = orig.width + dx;
      if (dir.includes("w")) { width = orig.width - dx; x = orig.x + dx; }
      if (dir.includes("s")) height = orig.height + dy;
      if (dir.includes("n")) { height = orig.height - dy; y = orig.y + dy; }
      width = Math.max(30, Math.min(state.canvasW + BUFFER * 2, Math.round(width)));
      height = Math.max(20, Math.min(state.canvasH + BUFFER * 2, Math.round(height)));
      x = Math.min(state.canvasW + BUFFER - 40, Math.max(-BUFFER, Math.round(x)));
      y = Math.min(state.canvasH + BUFFER - 40, Math.max(-BUFFER, Math.round(y)));
      emit("element:resize", { id: orig.id, x, y, width, height });
    },
    [emit, state.canvasW, state.canvasH]
  );

  useEffect(() => {
    const fn = () => { resizeRef.current = null; };
    window.addEventListener("mouseup", fn);
    window.addEventListener("mousemove", handleResizeMove);
    return () => {
      window.removeEventListener("mouseup", fn);
      window.removeEventListener("mousemove", handleResizeMove);
    };
  }, [handleResizeMove]);

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
          className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${tab === "elements" ? "bg-bg text-white border-b-2 border-accent" : "text-gray-500 hover:text-gray-300"}`}
        >Элементы оверлея</button>
        <button
          onClick={() => setTab("obs")}
          className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${tab === "obs" ? "bg-bg text-white border-b-2 border-accent" : "text-gray-500 hover:text-gray-300"}`}
        >Управление OBS</button>
      </div>

      {tab === "elements" ? (
        <div className="flex-1 flex overflow-hidden">
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
                    const p = parkingSpot(400);
                    addElement({ type: "image", src: dataUrl, ...p, width: 400, height: 225, text: "" });
                  };
                  input.click();
                }} className="flex-1 px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors">🖼 С ПК</button>
                <button onClick={() => {
                  const url = prompt("Ссылка на картинку:");
                  const p = parkingSpot(400);
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
                    const p = parkingSpot(480);
                    addElement({ type: "video", src: dataUrl, ...p, width: 480, height: 270, text: "" });
                  };
                  input.click();
                }} className="flex-1 px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors">🎬 С ПК</button>
                <button onClick={() => {
                  const url = prompt("Ссылка на видео (MP4, WebM):");
                  const p = parkingSpot(480);
                  if (url) addElement({ type: "video", src: url, ...p, width: 480, height: 270, text: "" });
                }} className="flex-1 px-3 py-2 bg-border hover:bg-gray-600 text-white text-sm rounded-lg transition-colors">🔗 URL</button>
              </div>
              <button onClick={() => {
                const p = parkingSpot(560);
                const url = prompt("Ссылка на сайт или YouTube (например, https://youtube.com/watch?v=...):");
                if (url) addElement({ type: "iframe", src: url, ...p, width: 560, height: 315, text: "" });
              }} className="w-full px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors">🌐 Сайт / YouTube</button>
              <button onClick={() => {
                const p = parkingSpot(300);
                addElement({ type: "text", ...p, width: 300, height: 60, text: "Новый текст", fontSize: 36, color: "#ffffff", fontWeight: "bold", bgColor: "transparent" });
              }}
                className="w-full px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors">✏️ Текст</button>
              <button onClick={() => {
                const p = parkingSpot(200);
                addElement({ type: "timer", ...p, width: 200, height: 60, text: "", duration: 300, timerDirection: "down", fontSize: 40, color: "#ffffff", fontWeight: "bold", bgColor: "transparent", startTime: null, isRunning: false, timerLabel: "" });
              }}
                className="w-full px-3 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors">⏱ Таймер</button>
            </div>

            <h2 className="text-sm font-semibold mt-6 mb-2 text-gray-400 uppercase tracking-wide">Элементы ({state.elements.length})</h2>
            <div className="space-y-1">
              {state.elements.map((el) => (
                <div key={el.id} onClick={() => setSelectedId(el.id)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-sm transition-colors ${selectedId === el.id ? "bg-accent text-white" : "hover:bg-border text-gray-300"}`}>
                  <button onClick={(e) => { e.stopPropagation(); emit("element:toggle-visible", el.id); }} className="shrink-0">{el.visible ? "👁" : "🚫"}</button>
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
            <div className="flex-1 flex items-center justify-center p-6 overflow-hidden">
              <div ref={previewRef} className="relative rounded-lg overflow-hidden shadow-2xl"
                style={{
                  width: "100%", height: "100%", maxWidth: "100%",
                  aspectRatio: `${state.canvasW + BUFFER * 2} / ${state.canvasH + BUFFER * 2}`,
                  background: "#0c0c15",
                  backgroundImage: "radial-gradient(#26263a 1px, transparent 1px)",
                  backgroundSize: "22px 22px",
                }}
                onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}>
                <span className="absolute inset-x-0 text-center text-[10px] tracking-widest text-gray-600 uppercase pointer-events-none" style={{ top: 10 }}>element preload area</span>
                <span className="absolute inset-x-0 text-center text-[10px] tracking-widest text-gray-600 uppercase pointer-events-none" style={{ bottom: 10 }}>element preload area</span>
                <span className="absolute text-[10px] tracking-widest text-gray-600 uppercase pointer-events-none" style={{ left: 8, top: "50%", transform: "translateY(-50%)", writingMode: "vertical-rl" }}>element preload area</span>
                <span className="absolute text-[10px] tracking-widest text-gray-600 uppercase pointer-events-none" style={{ right: 8, top: "50%", transform: "translateY(-50%)", writingMode: "vertical-rl" }}>element preload area</span>
                <div className="absolute bg-black border border-border rounded-md pointer-events-none"
                  style={{ left: BUFFER * getScale(), top: BUFFER * getScale(), width: state.canvasW * getScale(), height: state.canvasH * getScale() }}>
                  <div className="absolute inset-0 opacity-10" style={{ backgroundImage: "linear-gradient(#444 1px, transparent 1px), linear-gradient(90deg, #444 1px, transparent 1px)", backgroundSize: "40px 40px" }} />
                  <span className="absolute bottom-1 right-2 text-[9px] text-gray-600">экран {state.canvasW} × {state.canvasH}</span>
                </div>
                {state.elements.map((el) => {
                  const scale = getScale();
                  return (
                    <div key={el.id} onMouseDown={(e) => handleDragStart(e, el)}
                      className={`absolute select-none cursor-grab ${selectedId === el.id ? "ring-2 ring-accent2" : ""}`}
                      style={{ left: (BUFFER + el.x) * scale, top: (BUFFER + el.y) * scale, width: el.width * scale, height: el.height * scale, zIndex: el.zIndex, opacity: el.visible ? (el.opacity ?? 1) : 0.35 }}>
                      <PreviewElement el={el} scale={scale} />
                      {selectedId === el.id && (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((dir) => {
                        const cursors: Record<string, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
                        const pos: React.CSSProperties = { position: "absolute", width: 10, height: 10, background: "#a78bfa", border: "2px solid #fff", borderRadius: 2, cursor: cursors[dir] };
                        if (dir.includes("n")) pos.top = -5;
                        if (dir.includes("s")) pos.bottom = -5;
                        if (dir.includes("e")) pos.right = -5;
                        if (dir.includes("w")) pos.left = -5;
                        if (dir === "n" || dir === "s") { pos.left = "50%"; pos.marginLeft = -5; }
                        if (dir === "e" || dir === "w") { pos.top = "50%"; pos.marginTop = -5; }
                        return (
                          <div key={dir} onMouseDown={(e) => handleResizeStart(e, el, dir)} className="handle" style={pos} />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <aside className="w-72 shrink-0 bg-panel border-l border-border p-4 overflow-y-auto">
            {selected ? <PropertyEditor el={selected} emit={emit} /> : (
              <div className="text-sm text-gray-600 mt-4 text-center">Выберите элемент, чтобы изменить его свойства.</div>
            )}
          </aside>
        </div>
      ) : (
        <div className="flex-1 overflow-auto"><ObsPanel /></div>
      )}
    </div>
  );
}

function PreviewElement({ el, scale }: { el: StreamElement; scale: number }) {
  if (el.type === "image" || el.type === "gif") return <img src={el.src} alt="" className="w-full h-full object-contain pointer-events-none" draggable={false} />;
  if (el.type === "iframe")
    return (
      <iframe src={toEmbedUrl(el.src || "")} title="embed"
        className="w-full h-full pointer-events-none" style={{ border: 0 }}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
    );
  if (el.type === "video") return <video src={el.src} className="w-full h-full object-contain pointer-events-none" muted loop autoPlay playsInline />;
  if (el.type === "text") return (
    <div className="w-full h-full flex items-center justify-center pointer-events-none overflow-hidden"
      style={{ fontSize: (el.fontSize || 24) * scale, color: el.color || "#fff", fontWeight: el.fontWeight || "normal", background: el.bgColor === "transparent" ? "none" : el.bgColor, textAlign: "center" }}>
      {el.text}
    </div>
  );
  if (el.type === "timer") return <TimerPreview el={el} scale={scale} />;
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

function PropertyEditor({ el, emit }: { el: StreamElement; emit: (e: string, d?: any) => void }) {
  const update = (partial: Partial<StreamElement>) => emit("element:update", { id: el.id, ...partial });
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
          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${el.alwaysLoaded ? "translate-x-4" : "translate-x-0.5"}`} />
        </button>
      </div>
      {(el.type === "image" || el.type === "video" || el.type === "gif" || el.type === "text") && (
        <div>
          <label className="text-xs text-gray-500 block mb-1">Прозрачность: {Math.round((el.opacity ?? 1) * 100)}%</label>
          <input type="range" min={10} max={100} value={Math.round((el.opacity ?? 1) * 100)}
            onChange={(e) => update({ opacity: Number(e.target.value) / 100 })}
            className="w-full accent-violet-500 cursor-pointer" />
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
