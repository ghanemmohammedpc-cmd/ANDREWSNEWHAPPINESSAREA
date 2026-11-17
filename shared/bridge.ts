import type { Mod, Progress, Settings, UploadInput, User } from './schema';
import type { Installed } from '../desktop/installer';
export type Selection = { id: string; name: string; size: number };
export type Bootstrap = { connected: boolean; configured: boolean; user: User | null; serverUrl: string; language: 'ar' | 'en'; adminLanguage: 'ar' | 'en'; inviteUrl: string; error?: string; version: string };
export type Action = 'mods:list' | 'mods:favorites' | 'mods:detail' | 'mods:versions' | 'mods:reviews' | 'mods:review' | 'mods:deleteReview' | 'announcements:list' | 'admin:stats' | 'admin:mods' | 'admin:update' | 'admin:publish' | 'admin:unpublish' | 'admin:delete' | 'admin:media' | 'admin:audit' | 'admin:announcements' | 'admin:announce' | 'admin:deleteAnnouncement' | 'admin:storage' | 'admin:imports';
export interface HubBridge {
  bootstrap(): Promise<Bootstrap>;
  connect(url: string): Promise<Bootstrap>;
  login(): Promise<User>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  recheck(): Promise<User>;
  joinDiscord(): Promise<void>;
  request<T = any>(action: Action, payload?: unknown): Promise<T>;
  image(id: string): Promise<string>;
  settings(): Promise<Settings>;
  setLanguage(language: 'ar' | 'en', area: 'app' | 'admin'): Promise<void>;
  saveSettings(value: Partial<Pick<Settings, 'language' | 'parallelDownloads'>>): Promise<Settings>;
  chooseModsFolder(): Promise<Settings>;
  openModsFolder(): Promise<void>;
  installed(): Promise<Record<string, Installed & { present: boolean; modified: boolean }>>;
  install(modId: string, replace?: boolean): Promise<{ id: string }>;
  cancelJob(id: string): Promise<void>;
  uninstall(modId: string): Promise<void>;
  restore(modId: string): Promise<void>;
  pickFile(kind: 'zip' | 'image'): Promise<Selection | null>;
  uploadMedia(id: string): Promise<{ id: string }>;
  uploadMod(id: string, input: Omit<UploadInput, 'filename' | 'size' | 'sha256'>): Promise<{ id: string }>;
  favorites(): Promise<string[]>;
  favorite(id: string, enabled: boolean): Promise<string[]>;
  jobs(): Promise<Progress[]>;
  diagnostics(): Promise<void>;
  window(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  onProgress(callback: (value: Progress) => void): () => void;
  onSession(callback: (value: User | null) => void): () => void;
}
declare global { interface Window { hub: HubBridge; } }
