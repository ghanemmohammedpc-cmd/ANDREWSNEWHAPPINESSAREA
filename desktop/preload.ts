import { contextBridge, ipcRenderer } from 'electron';
import type { HubBridge } from '../shared/bridge';
const invoke = async (method: string, ...args: unknown[]) => {
  const result = await ipcRenderer.invoke('hub:call', { method, args });
  if (!result.ok) { const error = new Error(result.error.message) as Error & { code: string }; error.code = result.error.code; throw error; }
  return result.data;
};
const methods = ['bootstrap', 'connect', 'login', 'cancelLogin', 'logout', 'recheck', 'joinDiscord', 'request', 'image', 'settings', 'setLanguage', 'saveSettings', 'chooseModsFolder', 'openModsFolder', 'installed', 'install', 'cancelJob', 'uninstall', 'restore', 'pickFile', 'uploadMedia', 'uploadMod', 'favorites', 'favorite', 'jobs', 'diagnostics', 'window'];
const bridge: Record<string, unknown> = Object.fromEntries(methods.map(method => [method, (...args: unknown[]) => invoke(method, ...args)]));
bridge.onProgress = (callback: Function) => { const listener = (_event: unknown, value: unknown) => callback(value); ipcRenderer.on('hub:progress', listener); return () => ipcRenderer.removeListener('hub:progress', listener); };
bridge.onSession = (callback: Function) => { const listener = (_event: unknown, value: unknown) => callback(value); ipcRenderer.on('hub:session', listener); return () => ipcRenderer.removeListener('hub:session', listener); };
contextBridge.exposeInMainWorld('hub', Object.freeze(bridge) as unknown as HubBridge);
