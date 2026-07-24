const STORAGE_KEY = 'gpubnb.host.onboarding';
const SCHEMA_VERSION = 1;

type StoredOnboarding = {
  schemaVersion: number;
  introductionCompleted: boolean;
};

const defaultState = (): StoredOnboarding => ({
  schemaVersion: SCHEMA_VERSION,
  introductionCompleted: false,
});

export function readOnboardingState(): StoredOnboarding {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();

    const parsed: unknown = JSON.parse(raw);
    if (!isStoredOnboarding(parsed)) return defaultState();

    return parsed.schemaVersion === SCHEMA_VERSION ? parsed : migrate(parsed);
  } catch {
    return defaultState();
  }
}

export function completeIntroduction(): void {
  writeState({
    schemaVersion: SCHEMA_VERSION,
    introductionCompleted: true,
  });
}

export function resetOnboardingState(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A blocked storage API must never block the host application.
  }
}

function writeState(state: StoredOnboarding): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Preferences are optional. Security readiness is never stored here.
  }
}

function migrate(state: StoredOnboarding): StoredOnboarding {
  return {
    schemaVersion: SCHEMA_VERSION,
    introductionCompleted: Boolean(state.introductionCompleted),
  };
}

function isStoredOnboarding(value: unknown): value is StoredOnboarding {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredOnboarding>;
  return Number.isInteger(candidate.schemaVersion)
    && typeof candidate.introductionCompleted === 'boolean';
}
