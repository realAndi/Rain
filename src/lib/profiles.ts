// Shell profiles for Rain terminal.
// Allows users to define named profiles with pre-set shell, CWD, and environment.

export interface ShellProfile {
  id: string;
  name: string;
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  icon?: string;
  color?: string;
}

const PROFILES_STORAGE_KEY = "rain-profiles";
const ACTIVE_PROFILE_STORAGE_KEY = "rain-active-profile-id";

const DEFAULT_PROFILES: ShellProfile[] = [
  {
    id: "default",
    name: "Default",
    icon: "terminal",
  },
];

let _profiles: ShellProfile[] = [];
let _activeProfileId = "default";

function normalizeProfile(profile: ShellProfile): ShellProfile {
  const env = profile.env
    ? Object.fromEntries(
        Object.entries(profile.env)
          .map(([key, value]) => [key.trim(), String(value)])
          .filter(([key]) => key.length > 0),
      )
    : undefined;
  return {
    ...profile,
    name: profile.name?.trim() || "Profile",
    shell: profile.shell?.trim() || undefined,
    cwd: profile.cwd?.trim() || undefined,
    env: env && Object.keys(env).length > 0 ? env : undefined,
  };
}

function ensureDefaultProfile(profiles: ShellProfile[]): ShellProfile[] {
  if (profiles.some((profile) => profile.id === "default")) {
    return profiles.map(normalizeProfile);
  }
  return [...DEFAULT_PROFILES, ...profiles.map(normalizeProfile)];
}

function loadActiveProfileId() {
  try {
    const raw = localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY);
    if (raw && raw.trim().length > 0) {
      _activeProfileId = raw.trim();
      return;
    }
  } catch {
    // ignore
  }
  _activeProfileId = "default";
}

export function loadProfiles(): ShellProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ShellProfile[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        _profiles = ensureDefaultProfile(parsed);
        loadActiveProfileId();
        if (!_profiles.some((profile) => profile.id === _activeProfileId)) {
          _activeProfileId = "default";
        }
        return _profiles;
      }
    }
  } catch {
    // ignore
  }
  _profiles = ensureDefaultProfile([...DEFAULT_PROFILES]);
  loadActiveProfileId();
  if (!_profiles.some((profile) => profile.id === _activeProfileId)) {
    _activeProfileId = "default";
  }
  return _profiles;
}

export function saveProfiles(profiles: ShellProfile[]): void {
  _profiles = ensureDefaultProfile(profiles);
  if (!_profiles.some((profile) => profile.id === _activeProfileId)) {
    _activeProfileId = "default";
  }
  try {
    localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(_profiles));
    localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, _activeProfileId);
  } catch {
    // ignore
  }
}

export function getProfiles(): ShellProfile[] {
  if (_profiles.length === 0) return loadProfiles();
  return _profiles;
}

export function getProfile(id: string): ShellProfile | undefined {
  return getProfiles().find((p) => p.id === id);
}

export function addProfile(profile: Omit<ShellProfile, "id">): ShellProfile {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const newProfile: ShellProfile = normalizeProfile({ id, ...profile });
  const profiles = [...getProfiles(), newProfile];
  saveProfiles(profiles);
  return newProfile;
}

export function updateProfile(id: string, updates: Partial<ShellProfile>): void {
  const profiles = getProfiles().map((p) =>
    p.id === id ? normalizeProfile({ ...p, ...updates }) : p,
  );
  saveProfiles(profiles);
}

export function deleteProfile(id: string): void {
  if (id === "default") return; // Can't delete default
  const profiles = getProfiles().filter((p) => p.id !== id);
  if (_activeProfileId === id) {
    _activeProfileId = "default";
  }
  saveProfiles(profiles);
}

export function getActiveProfileId(): string {
  if (_profiles.length === 0) loadProfiles();
  if (!_profiles.some((profile) => profile.id === _activeProfileId)) {
    _activeProfileId = "default";
  }
  return _activeProfileId;
}

export function setActiveProfileId(profileId: string): void {
  if (_profiles.length === 0) loadProfiles();
  _activeProfileId = _profiles.some((profile) => profile.id === profileId)
    ? profileId
    : "default";
  try {
    localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, _activeProfileId);
  } catch {
    // ignore
  }
}

export function getActiveProfile(): ShellProfile {
  const id = getActiveProfileId();
  return getProfile(id) ?? getProfile("default") ?? DEFAULT_PROFILES[0];
}

// Initialize
loadProfiles();
