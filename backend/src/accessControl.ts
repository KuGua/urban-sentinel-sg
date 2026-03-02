import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

export type AuthScope = {
  isGlobal: boolean;
  planningAreas: string[];
};

export type AuthProfile = {
  userId: number;
  username: string;
  displayName: string;
  departmentCode: string;
  departmentName: string;
  role: string;
  scope: AuthScope;
};

type Department = {
  id: number;
  code: string;
  name: string;
  isGlobal: boolean;
};

type StaffUser = {
  id: number;
  username: string;
  password: string;
  displayName: string;
  role: string;
  departmentId: number;
  isActive: boolean;
};

type Session = {
  token: string;
  userId: number;
  createdAt: number;
  expiresAt: number;
};

type AccessControlStore = {
  departments: Department[];
  departmentPlanningAreas: Array<{ departmentId: number; planningArea: string }>;
  staffUsers: StaffUser[];
  sessions: Session[];
};

const STORE_PATH = path.resolve(__dirname, "../data/access-control.runtime.json");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function nowMs(): number {
  return Date.now();
}

function normalizePlanningArea(name: string): string {
  return String(name || "").trim().toUpperCase();
}

function normalizeUsername(username: string): string {
  return String(username || "").trim().toLowerCase();
}

function ensureStoreDir(): void {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function defaultStore(): AccessControlStore {
  return {
    departments: [],
    departmentPlanningAreas: [],
    staffUsers: [],
    sessions: [],
  };
}

function readStore(): AccessControlStore {
  ensureStoreDir();
  if (!fs.existsSync(STORE_PATH)) {
    return defaultStore();
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as AccessControlStore;
    return {
      departments: Array.isArray(parsed.departments) ? parsed.departments : [],
      departmentPlanningAreas: Array.isArray(parsed.departmentPlanningAreas)
        ? parsed.departmentPlanningAreas
        : [],
      staffUsers: Array.isArray(parsed.staffUsers) ? parsed.staffUsers : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return defaultStore();
  }
}

function writeStore(store: AccessControlStore): void {
  ensureStoreDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function nextId(rows: Array<{ id: number }>): number {
  let max = 0;
  for (const row of rows) {
    if (row.id > max) {
      max = row.id;
    }
  }
  return max + 1;
}

function seedIfEmpty(store: AccessControlStore): AccessControlStore {
  if (store.departments.length > 0) {
    return store;
  }

  const departments: Department[] = [];
  const departmentPlanningAreas: Array<{ departmentId: number; planningArea: string }> = [];
  const staffUsers: StaffUser[] = [];

  const addDept = (code: string, name: string, isGlobal: boolean): Department => {
    const dept: Department = {
      id: nextId(departments),
      code,
      name,
      isGlobal,
    };
    departments.push(dept);
    return dept;
  };

  const police = addDept("POLICE", "Singapore Police Force", false);
  const fire = addDept("FIRE", "Singapore Civil Defence Force", false);
  const hospital = addDept("HOSPITAL", "Hospital Operations", false);
  const gov = addDept("GOV", "Government Command", true);

  const addArea = (departmentId: number, planningArea: string): void => {
    const normalized = normalizePlanningArea(planningArea);
    if (
      departmentPlanningAreas.some(
        (item) => item.departmentId === departmentId && item.planningArea === normalized
      )
    ) {
      return;
    }
    departmentPlanningAreas.push({ departmentId, planningArea: normalized });
  };

  for (const name of ["KALLANG", "GEYLANG"]) addArea(police.id, name);
  for (const name of ["KALLANG", "MARINE PARADE"]) addArea(fire.id, name);
  for (const name of ["KALLANG", "TOA PAYOH"]) addArea(hospital.id, name);

  const addUser = (
    username: string,
    password: string,
    displayName: string,
    role: string,
    departmentId: number
  ): void => {
    staffUsers.push({
      id: nextId(staffUsers),
      username: normalizeUsername(username),
      password,
      displayName,
      role,
      departmentId,
      isActive: true,
    });
  };

  addUser("police.kallang", "Pass@123", "Kallang Police Ops", "department_staff", police.id);
  addUser("fire.kallang", "Pass@123", "Kallang Fire Ops", "department_staff", fire.id);
  addUser("hospital.kallang", "Pass@123", "Kallang Hospital Ops", "department_staff", hospital.id);
  addUser("gov.command", "Pass@123", "Gov Command Center", "global_staff", gov.id);

  return {
    departments,
    departmentPlanningAreas,
    staffUsers,
    sessions: [],
  };
}

function cleanupExpiredSessions(store: AccessControlStore): AccessControlStore {
  const now = nowMs();
  const nextSessions = store.sessions.filter((session) => session.expiresAt > now);
  if (nextSessions.length === store.sessions.length) {
    return store;
  }
  return { ...store, sessions: nextSessions };
}

function buildProfileFromUserId(store: AccessControlStore, userId: number): AuthProfile | null {
  const user = store.staffUsers.find((item) => item.id === userId && item.isActive);
  if (!user) return null;
  const dept = store.departments.find((item) => item.id === user.departmentId);
  if (!dept) return null;

  const planningAreas = dept.isGlobal
    ? []
    : store.departmentPlanningAreas
        .filter((item) => item.departmentId === dept.id)
        .map((item) => normalizePlanningArea(item.planningArea))
        .sort((a, b) => a.localeCompare(b));

  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    departmentCode: dept.code,
    departmentName: dept.name,
    role: user.role,
    scope: {
      isGlobal: dept.isGlobal,
      planningAreas,
    },
  };
}

export function initAccessControlDb(): void {
  const store = readStore();
  const seeded = seedIfEmpty(store);
  const cleaned = cleanupExpiredSessions(seeded);
  writeStore(cleaned);
}

export function loginWithPassword(
  username: string,
  password: string
): { token: string; profile: AuthProfile } | null {
  let store = cleanupExpiredSessions(readStore());
  const normalizedUsername = normalizeUsername(username);
  const rawPassword = String(password || "");

  const user = store.staffUsers.find(
    (item) => item.isActive && item.username === normalizedUsername && item.password === rawPassword
  );
  if (!user) {
    writeStore(store);
    return null;
  }

  const profile = buildProfileFromUserId(store, user.id);
  if (!profile) {
    writeStore(store);
    return null;
  }

  const token = randomUUID();
  const createdAt = nowMs();
  const expiresAt = createdAt + SESSION_TTL_MS;
  store = {
    ...store,
    sessions: [...store.sessions, { token, userId: user.id, createdAt, expiresAt }],
  };
  writeStore(store);
  return { token, profile };
}

export function getProfileByToken(token: string): AuthProfile | null {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) {
    return null;
  }

  let store = cleanupExpiredSessions(readStore());
  const session = store.sessions.find((item) => item.token === normalizedToken);
  writeStore(store);
  if (!session) {
    return null;
  }

  return buildProfileFromUserId(store, session.userId);
}

export function deleteSession(token: string): void {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) {
    return;
  }
  const store = readStore();
  const nextSessions = store.sessions.filter((item) => item.token !== normalizedToken);
  if (nextSessions.length === store.sessions.length) {
    return;
  }
  writeStore({ ...store, sessions: nextSessions });
}

export function filterPlanningAreaRowsByScope<T extends Record<string, unknown>>(
  rows: T[],
  scope: AuthScope
): T[] {
  if (scope.isGlobal) {
    return rows;
  }
  const allowed = new Set(scope.planningAreas.map((item) => normalizePlanningArea(item)));
  return rows.filter((row) => allowed.has(normalizePlanningArea(String(row.pln_area_n || ""))));
}
