"use client";

import { useEffect, useState } from "react";

function TwitchIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="#fff" width={size} height={size}>
      <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714H20.57z" />
    </svg>
  );
}

interface CabinetClientProps {
  login: string;
  displayName: string;
  avatar?: string;
  token: string | null;
  origin: string;
}

export default function CabinetClient({ login, displayName, avatar, token: initialToken, origin }: CabinetClientProps) {
  const [token, setToken] = useState<string | null>(initialToken);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // подтягиваем сохранённые ссылки при загрузке страницы
  useEffect(() => {
    fetch("/api/links")
      .then((r) => r.json())
      .then((d) => { if (d.token) setToken(d.token); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const generate = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/links", { method: "POST" });
      const d = await r.json();
      if (d.token) setToken(d.token);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {}
  };

  const links = token
    ? {
        panel: `${origin}/panel?room=${token}`,
        overlay: `${origin}/overlay?room=${token}`,
      }
    : null;

  const linkBlock = (title: string, url: string, key: string) => (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 uppercase tracking-wide">{title}</span>
        <button
          onClick={() => copy(url, key)}
          className="text-xs px-2 py-1 bg-border hover:bg-gray-600 text-gray-300 rounded transition-colors"
        >
          {copied === key ? "Скопировано ✓" : "Копировать"}
        </button>
      </div>
      <pre className="bg-panel border border-border rounded-lg p-3 text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">{url}</pre>
    </div>
  );

  return (
    <main className="min-h-screen bg-bg">
      <header className="flex items-center justify-between px-5 py-3 bg-panel border-b border-border">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-200 font-medium">{displayName}</span>
          {avatar ? (
            <img src={avatar} alt="" className="w-10 h-10 rounded-full shrink-0" />
          ) : (
            <span className="w-10 h-10 rounded-full bg-[#9146FF] flex items-center justify-center shrink-0">
              <TwitchIcon size={22} />
            </span>
          )}
        </div>
        <a
          href="/api/auth/logout"
          className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm rounded-lg transition-colors"
        >
          Выйти
        </a>
      </header>

      <div className="max-w-3xl mx-auto p-6">
        <h1 className="text-xl font-semibold text-white mb-1">Личный кабинет</h1>
        <p className="text-sm text-gray-500 mb-6">
          Аккаунт Twitch: <span className="text-gray-300">{login}</span>
        </p>

        {!loaded ? null : !links ? (
          <button
            onClick={generate}
            disabled={busy}
            className="px-4 py-2.5 bg-accent hover:bg-violet-700 text-white rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            {busy ? "Генерация…" : "Сгенерировать ссылки"}
          </button>
        ) : (
          <div className="space-y-5">
            <p className="text-xs text-gray-600">
              Ссылки привязаны к аккаунту <span className="text-gray-400">{login}</span> и сохранены — не сбрасываются при обновлении страницы.
            </p>
            {linkBlock("Панель для модераторов", links.panel, "panel")}
            {linkBlock("Оверлей для OBS (Browser Source, 1920×1080)", links.overlay, "overlay")}
            <button
              onClick={generate}
              disabled={busy}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors underline disabled:opacity-50"
            >
              {busy ? "Генерация…" : "Сгенерировать заново (старые ссылки перестанут работать)"}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
