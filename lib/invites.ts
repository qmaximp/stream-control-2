import fs from "fs";
import path from "path";
import { readLinks } from "@/lib/links";

// Инвайты на доступ к панели: у каждой комнаты (владелец = логин в links.json)
// свой список модераторов со статусами.
//   pending  — приглашён (по нику или через визит по ссылке), но ещё не принял
//   accepted — доступ открыт; suspended=true — временно отключён стримером
// Токен в записи модератора НЕ хранится: ссылка всегда строится из АКТУАЛЬНОГО
// токена владельца, поэтому после «Сгенерировать заново» ссылка у модератора меняется сама.

const DATA_DIR = path.join(process.cwd(), "data");
const INVITES_FILE = path.join(DATA_DIR, "invites.json");

export type InviteStatus = "pending" | "accepted";

export type ModeratorEntry = {
  status: InviteStatus;
  suspended: boolean;
  invitedAt: string;
  visitedAt?: string; // модератор уже открывал ссылку, войдя под своим аккаунтом
  acceptedAt?: string;
};

export type InvitesData = Record<string, { moderators: Record<string, ModeratorEntry> }>;

export function readInvites(): InvitesData {
  try {
    return JSON.parse(fs.readFileSync(INVITES_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeInvites(data: InvitesData) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INVITES_FILE, JSON.stringify(data, null, 2));
}

// владелец комнаты по токену ссылки
export function findOwnerByToken(token: string): string | null {
  const links = readLinks();
  const entry = Object.entries(links).find(([, e]) => e.token === token);
  return entry?.[0] ?? null;
}

export function getInviteStatus(owner: string, login: string): ModeratorEntry | null {
  return readInvites()[owner]?.moderators?.[login] ?? null;
}

// приглашение в статусе pending: создаётся при визите модератора по ссылке
// или при приглашении по нику из кабинета. Принятый доступ не сбрасываем.
export function ensurePendingInvite(owner: string, login: string): ModeratorEntry {
  const data = readInvites();
  data[owner] = data[owner] ?? { moderators: {} };
  const mods = data[owner].moderators;
  const now = new Date().toISOString();
  const prev = mods[login];
  const entry: ModeratorEntry =
    prev && prev.status === "accepted"
      ? { ...prev, visitedAt: now }
      : {
          status: "pending",
          suspended: false,
          invitedAt: prev?.invitedAt ?? now,
          visitedAt: now,
        };
  mods[login] = entry;
  writeInvites(data);
  return entry;
}

export function acceptInvite(owner: string, login: string) {
  const data = readInvites();
  const entry = data[owner]?.moderators?.[login];
  if (!entry) return;
  entry.status = "accepted";
  entry.suspended = false;
  entry.acceptedAt = new Date().toISOString();
  writeInvites(data);
}

export function setModeratorSuspended(owner: string, login: string, suspended: boolean) {
  const data = readInvites();
  const entry = data[owner]?.moderators?.[login];
  if (!entry) return;
  entry.suspended = suspended;
  writeInvites(data);
}

export function removeModerator(owner: string, login: string) {
  const data = readInvites();
  if (data[owner]?.moderators?.[login]) {
    delete data[owner].moderators[login];
    writeInvites(data);
  }
}

// все модераторы, приглашённые владельцем
export function listModerators(owner: string): Array<ModeratorEntry & { login: string }> {
  const mods = readInvites()[owner]?.moderators ?? {};
  return Object.entries(mods)
    .map(([login, entry]) => ({ login, ...entry }))
    .sort((a, b) => (a.invitedAt < b.invitedAt ? 1 : -1));
}

// все доступы/приглашения, выданные аккаунту другими стримерами
export function listInvitesFor(login: string): Array<{ owner: string; entry: ModeratorEntry }> {
  const data = readInvites();
  const out: Array<{ owner: string; entry: ModeratorEntry }> = [];
  for (const [owner, rec] of Object.entries(data)) {
    const entry = rec.moderators?.[login];
    if (entry) out.push({ owner, entry });
  }
  return out;
}
