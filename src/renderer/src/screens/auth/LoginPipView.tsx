/// <reference path="../../../../vite-env.d.ts" />
import React from 'react';
import ekaLogo from './eka-logo.svg';

type PipState = { type: 'waiting' } | { type: 'error'; message: string };

const DOT_ANIMATION = `
  @keyframes pip-dot-pulse {
    0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
    40%            { opacity: 1;   transform: scale(1); }
  }
`;

export function LoginPipView() {
  const [state, setState] = React.useState<PipState>({ type: 'waiting' });
  const [countdown, setCountdown] = React.useState(3);

  React.useEffect(() => {
    const unsub = window.loginPipApi.onState((s) => setState(s));
    return unsub;
  }, []);

  React.useEffect(() => {
    if (state.type !== 'error') return;
    setCountdown(3);
    const interval = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(interval);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [state]);

  const handleCancel = () => {
    window.loginPipApi.cancelLogin();
  };

  return (
    <>
      <style>{DOT_ANIMATION}</style>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          width: '100vw',
          height: '100vh',
          background: '#fcfcfc',
          fontFamily: 'Inter, "Segoe UI", sans-serif',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 12,
        }}
      >
        {/* Top bar — space for macOS traffic lights */}
        <div style={{ height: 48, flexShrink: 0 }} />

        {/* Back / cancel button */}
        <div style={{ paddingLeft: 20, marginBottom: 8 }}>
          <button
            onClick={handleCancel}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: '50%',
              border: '1px solid #e5e5e5',
              background: '#f5f5f5',
              cursor: 'pointer',
              color: '#1a1a1a',
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
            }}
            title="Cancel sign in"
          >
            ‹
          </button>
        </div>

        {/* Main content */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            justifyContent: 'flex-start',
            padding: '16px 28px 28px',
          }}
        >
          {/* Logo */}
          <img
            src={ekaLogo}
            alt="EkaScribe"
            style={{ width: 72, height: 72, marginBottom: 28 }}
          />

          {/* Heading */}
          <div
            style={{
              fontSize: 26,
              fontWeight: 600,
              color: '#1a1a1a',
              lineHeight: 1.3,
              marginBottom: 12,
              letterSpacing: '-0.3px',
            }}
          >
            Sign in to your EkaScribe account…
          </div>

          {/* Subtitle */}
          <div
            style={{
              fontSize: 15,
              color: '#767676',
              lineHeight: 1.5,
              marginBottom: 32,
            }}
          >
            EkaScribe needs to open your browser to sign you in. Complete the sign‑in there and this window will close automatically.
          </div>

          {/* State indicator */}
          {state.type === 'waiting' && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: '#215FFF',
                    animation: `pip-dot-pulse 1.4s ease-in-out ${i * 0.16}s infinite`,
                  }}
                />
              ))}
              <span style={{ fontSize: 13, color: '#767676', marginLeft: 8 }}>
                Waiting for browser…
              </span>
            </div>
          )}

          {state.type === 'error' && (
            <div
              style={{
                background: '#fff0f0',
                border: '1px solid #ffc9c9',
                borderRadius: 8,
                padding: '12px 16px',
                width: '100%',
                boxSizing: 'border-box',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: '#c0392b', marginBottom: 4 }}>
                Sign in failed
              </div>
              <div style={{ fontSize: 13, color: '#c0392b', lineHeight: 1.4 }}>
                {state.message}
              </div>
              {countdown > 0 && (
                <div style={{ fontSize: 12, color: '#aaa', marginTop: 8 }}>
                  This window closes in {countdown}s
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
