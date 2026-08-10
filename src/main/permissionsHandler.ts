import { session, systemPreferences } from 'electron';

export function setupMediaPermissionHandler() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (!['media', 'display-capture'].includes(permission)) {
      callback(false);
      return;
    }

    // Display-capture permissions are satisfied by setDisplayMediaRequestHandler.
    // Do not route these through askForMediaAccess('microphone'), which can
    // surface unnecessary permission UX when system-audio capture is already granted.
    if (permission === 'display-capture') {
      callback(true);
      return;
    }

    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'granted') {
        callback(true);
        return;
      }
      if (status === 'denied' || status === 'restricted') {
        callback(false);
        return;
      }
      if (status === 'not-determined') {
        void systemPreferences.askForMediaAccess('microphone').then(callback);
        return;
      }

      // "unknown" can surface in some packaged/runtime scenarios.
      // Do not block here; renderer capture APIs remain authoritative.
      callback(true);
    } else {
      callback(true);
    }
  });
}

export function setupSystemAudioLoopbackHandler() {
  // macOS 26 supports audio-only loopback via the "System Audio Recording Only"
  // entitlement (NSAudioCaptureUsageDescription). No video source or Screen
  // Recording permission is required.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      callback({ audio: 'loopback' });
    },
    { useSystemPicker: false }
  );
}
