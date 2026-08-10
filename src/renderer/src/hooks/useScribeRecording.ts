import React from 'react';
import {
  fetchOutputBySessionId,
  getScribeStatus,
  setupAndStartScribeRecording,
  stopScribeRecording,
  pauseScribeRecording,
  resumeScribeRecording,
  subscribeToScribeStatus,
  ScribeRecordingStatus,
  type SetupAndStartOptions,
} from '../services/scribeRecordingFlow';

export function useScribeRecording(options?: SetupAndStartOptions) {
  const [recordingError, setRecordingError] = React.useState<string | null>(null);
  const [isStarting, setIsStarting] = React.useState(false);
  const [isRecording, setIsRecording] = React.useState(false);
  const [isStopping, setIsStopping] = React.useState(false);
  const [isPaused, setIsPaused] = React.useState(false);

  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  React.useEffect(() => {
    return subscribeToScribeStatus((status, sessionId) => {
      console.log('[useScribeRecording] status update', { status, sessionId });
      const recording =
        status === ScribeRecordingStatus.RECORDING ||
        status === ScribeRecordingStatus.RECORDING_PAUSED;
      const stopping =
        status === ScribeRecordingStatus.RECORDING_STOPPED ||
        status === ScribeRecordingStatus.ANALYZING;
      setIsRecording(recording);
      setIsStopping(stopping);
      setIsPaused(status === ScribeRecordingStatus.RECORDING_PAUSED);
      setIsStarting(status === ScribeRecordingStatus.INITIALIZING);
      if (recording) setIsStarting(false);
    });
  }, []);

  const startRecording = React.useCallback(async () => {
    console.log('[useScribeRecording] startRecording called');
    setRecordingError(null);
    setIsStarting(true);
    try {
      const result = await setupAndStartScribeRecording(optionsRef.current);
      console.log('[useScribeRecording] startRecording result', result);
      if (!result.success) {
        setRecordingError(result.error);
      }
      return result;
    } finally {
      setIsStarting(false);
    }
  }, []);

  const stopRecording = React.useCallback(async () => {
    console.log('[useScribeRecording] stopRecording called');
    setRecordingError(null);
    try {
      const result = await stopScribeRecording();
      console.log('[useScribeRecording] stopRecording result', result);
      if (!result.success) {
        setRecordingError(result.error);
      } else {
        const { sessionId } = getScribeStatus();
        console.log('[useScribeRecording] fetching output for sessionId', sessionId);
        if (sessionId) {
          void fetchOutputBySessionId(sessionId, {
            accessToken: optionsRef.current?.accessToken,
            env: optionsRef.current?.env,
          });
        }
      }
      return result;
    } finally {
      setIsStopping(false);
    }
  }, []);

  const pauseRecording = React.useCallback(() => {
    pauseScribeRecording();
  }, []);

  const resumeRecording = React.useCallback(() => {
    resumeScribeRecording();
  }, []);

  return {
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    recordingError,
    isStarting,
    isRecording,
    isStopping,
    isPaused,
  };
}
