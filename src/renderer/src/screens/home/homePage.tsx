import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useScribeRecording } from '../../hooks/useScribeRecording';

export function HomePage() {
  const navigate = useNavigate();
  const [ekascribeWebUrl, setEkascribeWebUrl] = useState<string | null>(null);
  const [webLaunchError, setWebLaunchError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [setupPayload, setSetupPayload] = useState<{ accessToken: string | null; refreshToken?: string | null } | null>(null);
  const {
    startRecording,
    stopRecording,
    recordingError,
    isStarting,
    isRecording,
    isStopping,
  } = useScribeRecording();

  useEffect(() => {
    const handleIframeMessage = (event: MessageEvent) => {
      const msg = event.data as { type?: string; data?: unknown } | null;
      if (msg?.type === 'scribe:appointments') {
        (window.scribeApi as { sendAppointments?: (data: unknown) => void } | undefined)?.sendAppointments?.(msg.data);
      }
    };
    window.addEventListener('message', handleIframeMessage);
    return () => window.removeEventListener('message', handleIframeMessage);
  }, []);

  useEffect(() => {
    const forward = (type: string) => () => {
      iframeRef.current?.contentWindow?.postMessage({ type }, '*');
    };
    const unsubStart = window.scribeApi?.onStartRequest?.(forward('scribe:start'));
    const unsubStop = window.scribeApi?.onStopRequest?.(forward('scribe:stop'));
    const unsubPause = window.scribeApi?.onPauseRequest?.(forward('scribe:pause'));
    const unsubResume = window.scribeApi?.onResumeRequest?.(forward('scribe:resume'));
    const unsubStartWithAppt = (window.scribeApi as { onStartWithAppointmentRequest?: (cb: (data: unknown) => void) => () => void } | undefined)
      ?.onStartWithAppointmentRequest?.((data) => {
        iframeRef.current?.contentWindow?.postMessage({ type: 'scribe:start-with-appointment', data }, '*');
      });
    const unsubSetup = window.scribeApi?.onSetupScribeApp?.((payload) => {
      // Only update iframeSrc state on the FIRST token arrival.
      // Subsequent refreshes must go via postMessage only — updating setupPayload
      // re-renders the iframe gate, which would cause a full iframe reload.
      setSetupPayload((prev) => prev ?? payload);
      // Always forward to iframe for in-memory token update (no reload).
      iframeRef.current?.contentWindow?.postMessage({ type: 'scribe:setup', payload }, '*');
    });
    return () => {
      unsubStart?.();
      unsubStop?.();
      unsubPause?.();
      unsubResume?.();
      unsubStartWithAppt?.();
      unsubSetup?.();
    };
  }, []);

  // Re-send token whenever the iframe navigates internally (SPA route changes)
  const handleIframeLoad = () => {
    if (setupPayload) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'scribe:setup', payload: setupPayload }, '*');
    }
  };

  const handleStartRecording = async () => {
    const result = await startRecording();
    if (result?.success) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'scribe:start' }, '*');
    }
  };

  const logout = async () => {
    await window.authApi.logout();
    navigate('/', { replace: true });
  };

  useEffect(() => {
    let mounted = true;

    const bootEkascribeWeb = async () => {
      try {
        const url = await window.ekascribeWebApi.start();
        if (mounted) {
          setEkascribeWebUrl(url);
          setWebLaunchError(null);
        }
      } catch (error) {
        if (mounted) {
          const message = error instanceof Error ? error.message : 'Failed to start ekascribe-web';
          setWebLaunchError(message);
        }
      }
    };

    void bootEkascribeWeb();

    return () => {
      mounted = false;
    };
  }, []);

  const iframeSrc = ekascribeWebUrl && setupPayload
    ? ekascribeWebUrl
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', gap: 8, padding: 12 }}>
        <button onClick={logout}>Logout</button>
      {!isRecording ? (
        <button onClick={handleStartRecording} disabled={isStarting}>
          {isStarting ? 'Starting…' : 'Start Recording'}
        </button>
      ) : (
        <button onClick={stopRecording} disabled={isStopping}>
          {isStopping ? 'Stopping…' : 'Stop Recording'}
        </button>
      )}
      </div>
      {recordingError && <p role="alert">{recordingError}</p>}
      {webLaunchError && <p role="alert">{webLaunchError}</p>}
      {iframeSrc ? (
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          title="Ekascribe Web"
          style={{ border: 'none', width: '100%', flex: 1 }}
          onLoad={handleIframeLoad}
        />
      ) : (
        <div style={{ padding: 12 }}>Launching ekascribe-web...</div>
      )}
    </div>
  );
}
