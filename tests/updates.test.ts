import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { app, updater } = vi.hoisted(() => ({ app: { isPackaged: true }, updater: { setFeedURL: vi.fn(), on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), autoDownload: true, autoInstallOnAppQuit: false, allowDowngrade: true, logger: {} } }));
vi.mock('electron', () => ({ app }));
vi.mock('electron-updater', () => ({ autoUpdater: updater }));
import { startUpdates } from '../desktop/updates';
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); app.isPackaged = true; delete process.env.PORTABLE_EXECUTABLE_FILE; updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true }); updater.downloadUpdate.mockResolvedValue([]); });
afterEach(() => { vi.useRealTimers(); delete process.env.PORTABLE_EXECUTABLE_FILE; });
it('uses the program feed and waits for mod transfers to finish', async () => {
  let busy = true;
  startUpdates(() => busy);
  expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'https://team-razka-program.team-razka-program.workers.dev/updates/' });
  await vi.advanceTimersByTimeAsync(30000);
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
  busy = false; await vi.advanceTimersByTimeAsync(30 * 60000);
  expect(updater.downloadUpdate).toHaveBeenCalledOnce();
  expect(updater.autoDownload).toBe(false);
  expect(updater.autoInstallOnAppQuit).toBe(true);
  expect(updater.allowDowngrade).toBe(false);
});
it('leaves portable and development copies unchanged', async () => {
  process.env.PORTABLE_EXECUTABLE_FILE = 'Team Razka Program.exe';
  startUpdates(() => false);
  await vi.advanceTimersByTimeAsync(3600000);
  expect(updater.setFeedURL).not.toHaveBeenCalled();
  delete process.env.PORTABLE_EXECUTABLE_FILE; app.isPackaged = false;
  startUpdates(() => false);
  expect(updater.setFeedURL).not.toHaveBeenCalled();
});
