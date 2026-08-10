import { BrowserWindow, ipcMain } from 'electron';
import { captureError } from './sentryManager';

export function registerPdfIpcHandlers(): void {
  ipcMain.handle('print:htmlToPdf', async (_event, html: string) => {
    if (typeof html !== 'string' || !html) {
      throw new Error('print:htmlToPdf requires an HTML string');
    }

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        javascript: false,
        offscreen: true,
      },
    });

    try {
      const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf-8').toString('base64')}`;
      await win.loadURL(dataUrl);

      const pdf = await win.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        margins: { marginType: 'none' },
      });

      return pdf;
    } catch (error) {
      captureError(error, { domain: 'infra', component: 'pdf' });
      throw error;
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  });
}
