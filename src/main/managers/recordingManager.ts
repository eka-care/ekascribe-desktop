import { ipcMain, systemPreferences } from 'electron';
import { ErrorTypes, RecordingError } from '../errors/recordingErrors';

export type StartRecordingResult = { granted: true } | { granted: false; error: string; errorType: string };

export function registerRecordingIpcHandlers() {
  ipcMain.handle('recording:start', startRecording);
}

async function startRecording(): Promise<StartRecordingResult> {
  try {
    await getMicrophonePermissions();
    return { granted: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const errorType = err instanceof RecordingError ? err.type : ErrorTypes.ERROR_ASKING_FOR_MICROPHONE_ACCESS;
    return { granted: false, error: message, errorType };
  }
}

async function getMicrophonePermissions(): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      console.log('[recordingManager] microphone access status:', status);
      if (status === 'granted') {
        return;
      }

      if (status === 'denied' || status === 'restricted') {
        throw new RecordingError(
          `Microphone access is ${status}`,
          ErrorTypes.MICROPHONE_ACCESS_DENIED
        );
      }

      // Prompt only once when macOS has not asked yet. Re-prompting for other
      // states can cause repeated false-negative UX in packaged builds.
      if (status === 'not-determined') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        console.log('[recordingManager] microphone access granted:', granted);
        if (!granted) {
          throw new RecordingError(
            'User denied microphone access',
            ErrorTypes.MICROPHONE_ACCESS_DENIED
          );
        }
        return;
      }

      // Some packaged/runtime combinations can report "unknown" even when
      // capture works. Let renderer getUserMedia() remain authoritative.
      console.warn('[recordingManager] microphone permission status is non-blocking:', status);
      return;
    } catch (error) {
      if (error instanceof RecordingError) {
        throw error;
      }
      const message =
        error instanceof Error ? error.message : 'Unknown error asking for microphone access';
      throw new RecordingError(
        message,
        ErrorTypes.ERROR_ASKING_FOR_MICROPHONE_ACCESS
      );
    }
  }

  // On Windows and Linux there is no main-process API to trigger
  // a per-app microphone permission dialog; permissions are managed
  // by the OS and enforced when audio is actually captured.
  return;
}