"use client";

import { useCallback, useEffect, useState } from "react";

function TwitchIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="#fff" width={size} height={size}>
      <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714H20.57z" />
    </svg>
  );
}

type InviteStatus = "pending" | "accepted";

type Invite = {
  owner: string;
  status: InviteStatus;
  suspended: boolean;
  token: string | null;
};

type Moderator = {
  login: string;
  status: InviteStatus;
  suspended: boolean;
  invitedAt: string;
  visitedAt?: string;
  acceptedAt?: string;
};

type InvitesPayload = {
  invites: Invite[];
  moderators: Moderator[];
  roomToken: string | null;
};

interface CabinetClientProps {
  login: string;
  displayName: string;
  avatar?: string;
  token: string | null;
  origin: string;
  // после входа по ссылке стримера кабинет открывается сразу на вкладке доступа
  defaultTab?: "links" | "access";
}

export default function CabinetClient({ login, displayName, avatar, token: initialToken, origin, defaultTab = "links" }: CabinetClientProps) {
  const [token, setToken] = useState<string | null>(initialToken);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // вкладки кабинета: ссылки / доступ к панели (инвайты)
  const [tab, setTab] = useState<"links" | "access">(defaultTab);
  const [inv, setInv] = useState<InvitesPayload | null>(null);
  const [invError, setInvError] = useState("");
  const [inviteNick, setInviteNick] = useState("");

  // подтягиваем сохранённые ссылки при загрузке страницы
  useEffect(() => {
    fetch("/api/links")
      .then((r) => r.json())
      .then((d) => { if (d.token) setToken(d.token); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const loadInvites = useCallback(() => {
    setInvError("");
    fetch("/api/invites")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error || "Ошибка загрузки");
        setInv(d);
      })
      .catch((e) => setInvError(e?.message || "Не удалось загрузить доступы"));
  }, []);

  useEffect(() => { loadInvites(); }, [loadInvites]);

  // живое обновление: статусы инвайтов и модераторов подтягиваются без перезагрузки страницы
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") loadInvites();
    }, 5000);
    return () => clearInterval(t);
  }, [loadInvites]);

  const act = useCallback(async (payload: Record<string, string>) => {
    setBusy(true);
    setInvError("");
    try {
      const r = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "Ошибка");
      loadInvites();
      return true;
    } catch (e: any) {
      setInvError(e?.message || "Ошибка");
      return false;
    } finally {
      setBusy(false);
    }
  }, [loadInvites]);

  const doInvite = async () => {
    if (!inviteNick.trim()) return;
    const ok = await act({ action: "invite", login: inviteNick.trim() });
    if (ok) setInviteNick("");
  };

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
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-500 uppercase tracking-wide">{title}</span>
        <div className="flex items-center gap-1">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-2 py-1 bg-border hover:bg-gray-600 text-gray-300 rounded transition-colors"
          >
            Перейти ↗
          </a>
          <button
            onClick={() => copy(url, key)}
            className="text-xs px-2 py-1 bg-border hover:bg-gray-600 text-gray-300 rounded transition-colors"
          >
            {copied === key ? "Скопировано ✓" : "Копировать"}
          </button>
        </div>
      </div>
      <pre className="bg-panel border border-border rounded-lg p-3 text-sm text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">{url}</pre>
    </div>
  );

  const tabBtn = (id: "links" | "access", label: string) => (
    <button
      onClick={() => setTab(id)}
      className={`px-4 py-2 text-sm rounded-lg transition-colors ${tab === id ? "bg-accent text-white" : "bg-border text-gray-300 hover:bg-gray-600"}`}
    >
      {label}
    </button>
  );

  const statusCls = (m: Moderator) =>
    m.status === "pending"
      ? "text-amber-400"
      : m.suspended
        ? "text-red-400"
        : "text-green-400";

  const statusText = (m: Moderator) =>
    m.status === "pending"
      ? m.visitedAt
        ? "Ждёт подтверждения"
        : "Приглашён (ещё не заходил)"
      : m.suspended
        ? "Отключён временно"
        : "Доступ открыт";

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

      <div className="max-w-3xl mx-auto px-6 pt-10 pb-8">
        <h1 className="text-2xl font-semibold text-white mb-2">Личный кабинет</h1>
        <p className="text-base text-gray-400 mb-6">
          Аккаунт Twitch: <span className="text-gray-200">{login}</span>
        </p>

        <div className="flex gap-2 mb-8">
          {tabBtn("links", "Мои ссылки")}
          {tabBtn("access", "Доступ к панели")}
        </div>

        {tab === "links" && (
          <>
            {!loaded ? null : !links ? (
              <button
                onClick={generate}
                disabled={busy}
                className="px-4 py-2.5 bg-accent hover:bg-violet-700 text-white rounded-lg text-base transition-colors disabled:opacity-50"
              >
                {busy ? "Генерация…" : "Сгенерировать ссылки"}
              </button>
            ) : (
              <div className="space-y-5">
                <p className="text-xs text-gray-600">
                  Ссылки привязаны к аккаунту <span className="text-gray-400">{login}</span>.
                </p>
                {linkBlock("Панель для модераторов", links.panel, "panel")}
                {linkBlock("Оверлей для OBS", links.overlay, "overlay")}
                <button
                  onClick={generate}
                  disabled={busy}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors underline disabled:opacity-50"
                >
                  {busy ? "Генерация…" : "Сгенерировать заново (старые ссылки перестанут работать, ссылки у модераторов обновятся автоматически)"}
                </button>
              </div>
            )}
          </>
        )}

        {tab === "access" && (
          <>
            {/* приглашения, выданные этому аккаунту другими стримерами */}
            <h2 className="text-sm text-gray-500 uppercase tracking-wide mb-3">Приглашения</h2>
            {invError && <p className="text-xs text-red-400 mb-3">{invError}</p>}
            {inv && inv.invites.length === 0 && (
              <p className="text-sm text-gray-500 mb-8">
                Пока нет приглашений. Стример выдаёт доступ по нику Twitch: попросите его пригласить вас во вкладке «Доступ к панели» его кабинета — приглашение появится здесь.
              </p>
            )}
            <div className="space-y-3 mb-10">
              {inv?.invites.map((i) => (
                <div key={i.owner} className="bg-panel border border-border rounded-xl p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <p className="text-sm text-gray-200">Стример: <span className="font-medium">{i.owner}</span></p>
                      <p className={`text-xs mt-1 ${i.status === "pending" ? "text-amber-400" : i.suspended ? "text-red-400" : "text-green-400"}`}>
                        {i.status === "pending"
                          ? "Ждёт твоего подтверждения"
                          : i.suspended
                            ? "Доступ временно отключён стримером"
                            : "Доступ открыт"}
                      </p>
                    </div>
                    {i.status === "pending" && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => act({ action: "accept", owner: i.owner })}
                          disabled={busy}
                          className="px-4 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
                        >
                          Принять приглашение
                        </button>
                        <button
                          onClick={() => act({ action: "decline", owner: i.owner })}
                          disabled={busy}
                          className="px-3 py-2 text-xs text-red-400 border border-red-900/50 rounded-lg hover:bg-red-950/40 transition-colors disabled:opacity-50"
                        >
                          Отклонить
                        </button>
                      </div>
                    )}
                    {i.status === "accepted" && !i.suspended && i.token && (
                      <div className="flex items-center gap-2">
                        <a
                          href={`${origin}/panel?room=${i.token}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-4 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors"
                        >
                          Открыть панель ↗
                        </a>
                        <button
                          onClick={() => act({ action: "decline", owner: i.owner })}
                          disabled={busy}
                          className="px-3 py-2 text-xs text-red-400 border border-red-900/50 rounded-lg hover:bg-red-950/40 transition-colors disabled:opacity-50"
                        >
                          Отклонить
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* модераторы собственной панели этого аккаунта */}
            <h2 className="text-sm text-gray-500 uppercase tracking-wide mb-3">Модераторы моей панели</h2>
            {!inv?.roomToken ? (
              <p className="text-sm text-gray-500">
                Сначала сгенерируйте ссылки во вкладке «Мои ссылки» — панель должна существовать.
              </p>
            ) : (
              <>
                <p className="text-xs text-gray-600 mb-3 break-all">
                  Ссылка для приглашённых: <span className="text-gray-400">{origin}/panel?room={inv.roomToken}</span>
                </p>
                <div className="flex gap-2 mb-2">
                  <input
                    value={inviteNick}
                    onChange={(e) => setInviteNick(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") doInvite(); }}
                    placeholder="Ник Twitch (например, jettle_)"
                    className="flex-1 px-3 py-2 bg-bg border border-border rounded-lg text-sm"
                  />
                  <button
                    onClick={doInvite}
                    disabled={busy || !inviteNick.trim()}
                    className="px-4 py-2 bg-accent hover:bg-violet-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
                  >
                    Пригласить
                  </button>
                </div>
                {invError && <p className="text-xs text-red-400 mb-3">{invError}</p>}
                <div className="space-y-2">
                  {inv.moderators.length === 0 && (
                    <p className="text-sm text-gray-500">Модераторов ещё нет. Пригласите по нику или отправьте ссылку — приглашение появится, когда модератор войдёт.</p>
                  )}
                  {inv.moderators.map((m) => (
                    <div key={m.login} className="flex items-center justify-between gap-3 bg-panel border border-border rounded-lg px-3 py-2 flex-wrap">
                      <div>
                        <p className="text-sm text-gray-200">{m.login}</p>
                        <p className={`text-xs ${statusCls(m)}`}>{statusText(m)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {m.status === "accepted" && (
                          <button
                            onClick={() => act({ action: m.suspended ? "resume" : "suspend", login: m.login })}
                            disabled={busy}
                            className="px-3 py-1.5 text-xs bg-border hover:bg-gray-600 text-gray-300 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {m.suspended ? "Включить" : "Отключить временно"}
                          </button>
                        )}
                        <button
                          onClick={() => act({ action: "revoke", login: m.login })}
                          disabled={busy}
                          className="px-3 py-1.5 text-xs text-red-400 border border-red-900/50 rounded-lg hover:bg-red-950/40 transition-colors disabled:opacity-50"
                        >
                          Забрать доступ
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      <footer className="max-w-3xl mx-auto px-6 pb-12 text-center">
        <a
          href="https://dalink.to/jettle_"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-border bg-panel hover:bg-border text-gray-200 text-sm font-medium transition-all hover:-translate-y-0.5"
        >
          💜 Поддержать проект
        </a>
        <p className="text-[11px] text-gray-600 mt-3">Ovrly развивается бесплатно — поддержка очень помогает</p>
      </footer>
    </main>
  );
}
