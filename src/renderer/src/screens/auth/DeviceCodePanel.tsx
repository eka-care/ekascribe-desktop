import React from 'react';

/**
 * The code + verification link, shared by the full-size auth page and the PIP
 * panel. Opening the link is what shrinks the window, so both renders must
 * behave identically — hence one component rather than two copies.
 */
type Props = {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  /** `compact` is the PIP panel, which has ~340x440 to work with. */
  variant?: 'full' | 'compact';
};

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function CopyIcon() {
  return (
    <svg {...iconProps} aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg {...iconProps} aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg {...iconProps} aria-hidden>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

export function DeviceCodePanel({ userCode, verificationUrl, expiresAt, variant = 'full' }: Props) {
  const [copied, setCopied] = React.useState(false);
  const [remainingMs, setRemainingMs] = React.useState(expiresAt - Date.now());

  // Driven off the absolute deadline so a slow render or a sleeping machine
  // can't leave it showing more time than actually remains.
  React.useEffect(() => {
    const tick = () => setRemainingMs(expiresAt - Date.now());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  // Electron's native clipboard, not navigator.clipboard — the web API rejects
  // here without the clipboard-write permission, which failed silently.
  const handleCopy = async () => {
    try {
      await window.clipboardApi.write({ text: userCode });
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (copyError) {
      console.error('[auth] failed copying device code', copyError);
    }
  };

  const handleOpen = () => {
    void window.systemApi.openExternal(verificationUrl);
    // Hand the screen to the browser; the panel floats above it with the code.
    window.loginPipApi.shrinkToPip();
  };

  const compact = variant === 'compact';

  return (
    <div style={{ width: '100%', maxWidth: compact ? undefined : 420 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: compact ? '12px 14px' : '16px 20px',
          borderRadius: 12,
          border: '1px solid #e5e5e5',
          background: '#f7f8fa',
        }}
      >
        <span
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: compact ? 24 : 32,
            fontWeight: 600,
            letterSpacing: '3px',
            color: '#1a1a1a',
            userSelect: 'text',
          }}
        >
          {userCode}
        </span>
        <button
          onClick={() => void handleCopy()}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            border: '1px solid #e5e5e5',
            background: '#ffffff',
            borderRadius: 8,
            padding: 0,
            color: copied ? '#1a7f3c' : '#4a4a4a',
            borderColor: copied ? '#b7e0c4' : '#e5e5e5',
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'color 0.15s ease, border-color 0.15s ease',
          }}
          title={copied ? 'Copied' : 'Copy code'}
          aria-label={copied ? 'Code copied' : 'Copy code'}
        >
          {copied ? <TickIcon /> : <CopyIcon />}
        </button>
      </div>

      <button
        onClick={handleOpen}
        style={{
          marginTop: compact ? 14 : 20,
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: compact ? '10px 12px' : '12px 16px',
          border: 0,
          borderRadius: 10,
          background: '#215FFF',
          color: '#ffffff',
          fontSize: compact ? 13 : 15,
          fontWeight: 500,
          cursor: 'pointer',
        }}
      >
        Continue in browser
        <ExternalIcon />
      </button>

      <div
        style={{
          fontSize: 13,
          color: '#767676',
          marginTop: 10,
          lineHeight: 1.5,
          textAlign: 'center',
        }}
      >
        Enter this code there to approve the sign-in.
      </div>

      <div style={{ fontSize: 12, color: '#aaa', marginTop: 10, textAlign: 'center' }}>
        {remainingMs > 0
          ? `Code expires in ${formatRemaining(remainingMs)}`
          : 'Code expired — cancel and try again'}
      </div>
    </div>
  );
}

export default DeviceCodePanel;
