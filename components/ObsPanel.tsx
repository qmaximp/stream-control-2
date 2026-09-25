"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import OBSWebSocket from "obs-websocket-js";
import type { ObsScene, ObsSceneItem } from "@/lib/types";

export default function ObsPanel() {
  const obsRef = useRef<OBSWebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("4455");
  const [password, setPassword] = useState("");
  const [scenes, setScenes] = useState<ObsScene[]>([]);
  const [currentScene, setCurrentScene] = useState("");
  const [items, setItems] = useState<ObsSceneItem[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const loadSceneItems = useCallback(async (sceneName: string) => {
    const obs = obsRef.current;
    if (!obs) return;
    try {
      const res = await obs.call("GetSceneItemList", { sceneName });
      const allItems: ObsSceneItem[] = [];
      for (const item of res.sceneItems as any[]) {
        const sceneItem: ObsSceneItem = {
          itemId: item.sceneItemId, sourceName: item.sourceName,
          sourceType: item.inputKind || item.sourceKind || "unknown",
          sceneName, visible: item.sceneItemEnabled, isGroup: item.isGroup, children: [],
        };
        if (item.isGroup) {
          try {
            const groupRes = await obs.call("GetGroupSceneItemList", { sceneName: item.sourceName });
            sceneItem.children = (groupRes.sceneItems as any[]).map((child) => ({
              itemId: child.sceneItemId, sourceName: child.sourceName,
              sourceType: child.inputKind || child.sourceKind || "unknown",
              sceneName: item.sourceName, visible: child.sceneItemEnabled,
              isGroup: false, groupName: item.sourceName,
            }));
          } catch (err) { console.error("Group items error:", err); }
        }
        allItems.push(sceneItem);
      }
      setItems(allItems);
    } catch (e) { console.error("Load items error:", e); }
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true); setError("");
    try {
      const obs = new OBSWebSocket();
      await obs.connect(`ws://${host}:${port}`, password || undefined);
      obsRef.current = obs; setConnected(true); setConnecting(false);

      const sceneList = await obs.call("GetSceneList");
      const s: ObsScene[] = sceneList.scenes.map((sc: any, i: number) => ({
        name: sc.sceneName, index: i, isCurrent: sc.sceneName === sceneList.currentProgramSceneName,
      }));
      setScenes(s); setCurrentScene(sceneList.currentProgramSceneName);
      await loadSceneItems(sceneList.currentProgramSceneName);

      obs.on("CurrentProgramSceneChanged", (data: any) => {
        setCurrentScene(data.sceneName);
        setScenes((prev) => prev.map((sc) => ({ ...sc, isCurrent: sc.name === data.sceneName })));
        loadSceneItems(data.sceneName);
      });
      obs.on("SceneItemEnableStateChanged", (data: any) => {
        setItems((prev) => prev.map((it) =>
          it.itemId === data.sceneItemId && it.sceneName === data.sceneName
            ? { ...it, visible: data.sceneItemEnabled } : it));
      });
      obs.on("ConnectionClosed", () => { setConnected(false); setScenes([]); setItems([]); });
    } catch (e: any) {
      setError(e.message || "Ошибка подключения к OBS WebSocket");
      setConnecting(false); setConnected(false);
    }
  }, [host, port, password, loadSceneItems]);

  const disconnect = () => { obsRef.current?.disconnect(); obsRef.current = null; setConnected(false); setScenes([]); setItems([]); };

  const toggleItem = async (item: ObsSceneItem) => {
    const obs = obsRef.current; if (!obs) return;
    try {
      await obs.call("SetSceneItemEnabled", { sceneName: item.sceneName, sceneItemId: item.itemId, sceneItemEnabled: !item.visible });
      setItems((prev) => prev.map((it) => {
        if (it.itemId === item.itemId && it.sceneName === item.sceneName) return { ...it, visible: !it.visible };
        if (it.children) return { ...it, children: it.children.map((c) =>
          c.itemId === item.itemId && c.sceneName === item.sceneName ? { ...c, visible: !c.visible } : c) };
        return it;
      }));
    } catch (e) { console.error("Toggle error:", e); }
  };

  const switchScene = async (sceneName: string) => {
    const obs = obsRef.current; if (!obs) return;
    try { await obs.call("SetCurrentProgramScene", { sceneName }); setCurrentScene(sceneName); await loadSceneItems(sceneName); }
    catch (e) { console.error("Switch scene error:", e); }
  };

  const moveItem = async (item: ObsSceneItem, direction: "up" | "down") => {
    const obs = obsRef.current; if (!obs) return;
    try {
      const res = await obs.call("GetSceneItemList", { sceneName: item.sceneName });
      const allItems = res.sceneItems as any[];
      const idx = allItems.findIndex((i: any) => i.sceneItemId === item.itemId);
      if (idx < 0) return;
      const newIndex = direction === "up" ? Math.max(0, idx - 1) : Math.min(allItems.length - 1, idx + 1);
      if (newIndex === idx) return;
      await obs.call("SetSceneItemIndex", { sceneName: item.sceneName, sceneItemId: item.itemId, sceneItemIndex: newIndex });
      await loadSceneItems(item.sceneName);
    } catch (e) { console.error("Move item error:", e); }
  };

  const toggleGroup = (name: string) => {
    setExpandedGroups((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  };

  return (
    <div className="min-h-[calc(100vh-100px)] p-6">
      <div className="max-w-md bg-panel rounded-xl border border-border p-5 mb-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} />
          Подключение к OBS WebSocket
        </h2>
        {!connected ? (
          <>
            <p className="text-sm text-gray-400 mb-4">В OBS: <b>Tools → WebSocket Server Settings</b>, включите сервер. Порт по умолчанию — <code className="bg-bg px-1 rounded">4455</code>.</p>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs text-gray-500 block mb-1">Хост</label>
                <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost" className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm" /></div>
              <div><label className="text-xs text-gray-500 block mb-1">Порт</label>
                <input type="text" value={port} onChange={(e) => setPort(e.target.value)} placeholder="4455" className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm" /></div>
            </div>
            <div className="mt-3"><label className="text-xs text-gray-500 block mb-1">Пароль</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="пароль OBS WebSocket" className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm" /></div>
            {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
            <button onClick={connect} disabled={connecting} className="w-full mt-4 px-4 py-2.5 bg-accent hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors">
              {connecting ? "Подключение…" : "Подключиться"}
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-green-400 mb-3">✓ Подключено к {host}:{port}</p>
            <button onClick={disconnect} className="px-4 py-2 bg-red-800 hover:bg-red-700 text-white text-sm rounded-lg">Отключиться</button>
          </>
        )}
      </div>

      {connected && (
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="bg-panel rounded-xl border border-border p-5">
            <h3 className="text-base font-semibold mb-3">Сцены OBS</h3>
            <div className="space-y-2">
              {scenes.map((scene) => (
                <div key={scene.name} onClick={() => switchScene(scene.name)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${scene.isCurrent ? "bg-accent text-white" : "hover:bg-border text-gray-300"}`}>
                  <span className={`w-2 h-2 rounded-full ${scene.isCurrent ? "bg-white" : "bg-gray-600"}`} />
                  <span className="flex-1 text-sm">{scene.name}</span>
                  {scene.isCurrent && <span className="text-xs opacity-80">активная</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-panel rounded-xl border border-border p-5">
            <h3 className="text-base font-semibold mb-3">Источники сцены: <span className="text-accent2">{currentScene}</span></h3>
            <div className="space-y-1 max-h-[500px] overflow-y-auto">
              {items.map((item) => (
                <div key={item.itemId + "-" + item.sceneName}>
                  <div className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-border/50">
                    <button onClick={() => toggleItem(item)}
                      className={`w-9 h-5 rounded-full transition-colors shrink-0 relative ${item.visible ? "bg-green-500" : "bg-gray-600"}`}>
                      <span className="absolute top-[2px] w-4 h-4 bg-white rounded-full transition-all"
                        style={{ left: item.visible ? 18 : 2 }} />
                    </button>
                    <span className="flex-1 text-sm truncate">{item.sourceName}</span>
                    <span className="text-xs text-gray-500 hidden sm:inline">{item.sourceType}</span>
                    {item.isGroup && (
                      <button onClick={() => toggleGroup(item.sourceName)} className="shrink-0 text-gray-400 hover:text-white px-1">
                        {expandedGroups.has(item.sourceName) ? "▼" : "▶"}
                      </button>
                    )}
                    <div className="flex gap-1 shrink-0">
                      <button onClick={() => moveItem(item, "up")} className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white hover:bg-border rounded">↑</button>
                      <button onClick={() => moveItem(item, "down")} className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white hover:bg-border rounded">↓</button>
                    </div>
                  </div>
                  {item.isGroup && item.children && expandedGroups.has(item.sourceName) && (
                    <div className="ml-8 space-y-1">
                      {item.children.map((child) => (
                        <div key={child.itemId + "-" + child.sourceName} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-border/50">
                          <button onClick={() => toggleItem(child)}
                            className={`w-9 h-5 rounded-full transition-colors shrink-0 relative ${child.visible ? "bg-green-500" : "bg-gray-600"}`}>
                            <span className="absolute top-[2px] w-4 h-4 bg-white rounded-full transition-all"
                              style={{ left: child.visible ? 18 : 2 }} />
                          </button>
                          <span className="flex-1 text-sm truncate">{child.sourceName}</span>
                          <span className="text-xs text-gray-600">📁 {child.groupName}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {items.length === 0 && <p className="text-sm text-gray-600 px-2 py-4">Нет источников в сцене.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
