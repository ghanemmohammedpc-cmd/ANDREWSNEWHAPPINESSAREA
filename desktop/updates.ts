import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

export function startUpdates(busy: () => boolean) {
  if (!app.isPackaged || process.platform !== 'win32' || process.env.PORTABLE_EXECUTABLE_FILE) return;
  autoUpdater.setFeedURL({ provider: 'generic', url: 'https://team-razka-program.team-razka-program.workers.dev/updates/' });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;
  autoUpdater.on('error', () => {});
  let checking = false;
  let downloaded = false;
  autoUpdater.on('update-downloaded', () => { downloaded = true; });
  const check = async () => {
    if (checking || downloaded || busy()) return;
    checking = true;
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result?.isUpdateAvailable && !busy()) await autoUpdater.downloadUpdate();
    } catch {} finally { checking = false; }
  };
  setTimeout(() => { void check(); }, 30000).unref();
  setInterval(() => { void check(); }, 30 * 60000).unref();
}
