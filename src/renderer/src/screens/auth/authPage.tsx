/// <reference path="../../../../vite-env.d.ts" />
import React from 'react';
import { DotLottieReact } from '@lottiefiles/dotlottie-react';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import vaartaLogoUrl from './vaarta-logo.lottie?url';
import dotlottieWasmUrl from './dotlottie-player.wasm?url';
import DeviceCodePanel from './DeviceCodePanel';

// Point the dotLottie WASM engine at the bundled copy instead of its CDN default.
DotLottie.setWasmUrl(dotlottieWasmUrl);

export function AuthPage() {
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loginState, setLoginState] = React.useState<LoginPipStatePayload | null>(null);

  // The window stays full-size until the verification link is opened, so the
  // code renders here first and only then moves into the PIP panel.
  React.useEffect(() => {
    const unsub = window.loginPipApi.onState((s) => setLoginState(s));
    return unsub;
  }, []);

  const handleLogin = React.useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      const tokens = await window.authApi.startLogin();
      window.authApi.onAuthSuccess(tokens.refreshToken, tokens.accessToken);
    } catch (authError) {
      const message = authError instanceof Error ? authError.message : String(authError);
      const isUserCancelled = /abort|cancel/i.test(message);
      if (!isUserCancelled) {
        setError(message);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  return (
    <>
    <style>{`
      @keyframes auth-fade-up {
        from { opacity: 0; transform: translateY(12px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .auth-stack { animation: auth-fade-up 0.45s ease both; }
      .auth-login-btn { transition: background 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease; }
      .auth-login-btn:hover:not(:disabled) {
        background: #1a4fe0 !important;
        box-shadow: 0 6px 20px rgba(33, 95, 255, 0.28);
      }
      .auth-login-btn:active:not(:disabled) { transform: translateY(1px); }
      .auth-signup-link { transition: color 0.15s ease; }
      .auth-signup-link:hover:not(:disabled) { color: #1a4fe0 !important; }
    `}</style>
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        background:
          'radial-gradient(1100px 560px at 50% -12%, #eef2ff 0%, rgba(252,252,252,0) 62%), #fcfcfc',
        fontFamily: 'Inter, "Segoe UI", sans-serif',
      }}
    >
      <div
        className="auth-stack"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          width: 'min(440px, calc(100vw - 48px))',
          padding: '32px 0',
        }}
      >
        {/* Animated vaarta lockup — same asset as the web app's sidebar */}
        <div style={{ width: 213, height: 55, marginBottom: 44 }}>
          <DotLottieReact src={vaartaLogoUrl} loop autoplay />
        </div>

        {/* Headline */}
        <h1
          style={{
            margin: '0 0 14px',
            fontSize: 'clamp(32px, 4.5vw, 42px)',
            fontWeight: 500,
            lineHeight: 1.15,
            letterSpacing: '-1px',
            color: '#1a1a1a',
          }}
        >
          Speak freely.
          <br />
          Notes write themselves.
        </h1>

        <p
          style={{
            margin: '0 0 40px',
            fontSize: 15,
            fontWeight: 400,
            lineHeight: '23px',
            color: '#6f6f6f',
            maxWidth: 360,
            textWrap: 'balance',
          }}
        >
          Vaarta listens to your conversations and turns them into structured notes – automatically.
        </p>

        {loginState?.type === 'code' ? (
          <DeviceCodePanel
            userCode={loginState.userCode}
            verificationUrl={loginState.verificationUrl}
            expiresAt={loginState.expiresAt}
          />
        ) : (
        /* CTA */
        <button
          type="button"
          className="auth-login-btn"
          onClick={() => void handleLogin()}
          disabled={isLoading}
          style={{
            width: 'min(320px, 100%)',
            padding: '12px 16px',
            border: 0,
            borderRadius: 10,
            background: isLoading ? '#93aef7' : '#215FFF',
            color: '#ffffff',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            fontSize: 15,
            fontWeight: 500,
            lineHeight: '22px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <span>{isLoading ? 'Waiting for login…' : 'Login'}</span>
          {!isLoading && (
            <svg
              aria-hidden
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          )}
        </button>
        )}

        {error ? (
          <div
            style={{
              marginTop: 18,
              padding: '10px 14px',
              borderRadius: 8,
              background: '#fdf1f0',
              border: '1px solid #f3d2ce',
              color: '#b3261e',
              fontSize: 13,
              lineHeight: '18px',
              wordBreak: 'break-word',
              maxWidth: 360,
            }}
          >
            {error}
          </div>
        ) : null}
      </div>
    </div>
    </>
  );
}

export default AuthPage;
