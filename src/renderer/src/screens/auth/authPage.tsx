/// <reference path="../../../../vite-env.d.ts" />
import React from 'react';
import ekaLogo from './eka-logo.svg';
import doctorOnboardingImage from './doctor_onboarding_image.png';
import quoteMarks from './quote-marks.svg';
import doc1 from './doc1.png';
import doc2 from './doc2.png';
import doc3 from './doc3.png';
import doc4 from './doc4.png';
import doc5 from './doc5.png';
import doc6 from './doc6.png';
import doc7 from './doc7.png';
import doc8 from './doc8.png';
import doc9 from './doc9.png';

const TESTIMONIALS = [
  {
    quote: '"EkaScribe has been a game-changer for our practice. It captures complete consultations accurately, even across English and regional languages."',
    name: 'Dr. Nemichandra S.C.',
    specialty: 'Neurologist · Mysore',
    avatar: doc1,
  },
  {
    quote: '"I love how quick and effortless EkaScribe makes prescription writing. No more typing... It honestly feels like I\'ve got a smart assistant sitting beside me."',
    name: 'Dr. Kiran K.K.',
    specialty: 'Nephrologist · Mysore',
    avatar: doc2,
  },
  {
    quote: '"It\'s a complete game-changer. It has cut down my history-taking and typing time by more than half, which means I finally have the freedom to focus more on my patients."',
    name: 'Dr. Abhishek Gohel',
    specialty: 'Epileptologist · Ahmedabad',
    avatar: doc3,
  },
  {
    quote: '"My psychiatric consultations often run over an hour, and EkaScribe handles every minute without missing a beat. Over a thousand sessions in, the transcription is still consistently accurate."',
    name: 'Dr. H.S. Aditya',
    specialty: 'Psychiatrist · Manasa Hospital',
    avatar: doc4,
  },
  {
    quote: '"I crossed 500 sessions in under a month — that tells you how seamlessly EkaScribe fits into my workflow. The experience is clean, and the way it sits within the EMR just feels natural."',
    name: 'Dr. Arindam Roy',
    specialty: 'Rheumatologist · Hyderabad',
    avatar: doc5,
  },
  {
    quote: '"I\'ve done over 2800 sessions on EkaScribe, and what\'s kept me here is how consistently the product has improved. Every update has been meaningful — it genuinely gets better."',
    name: 'Dr. Lalji Patel',
    specialty: 'Gastroenterologist · Indore',
    avatar: doc6,
  },
  {
    quote: '"EkaScribe is simply the best voice scribe available in India right now. The multilingual transcription is remarkable; it picks up three or four languages mid-consultation without missing a beat."',
    name: 'Dr. Devashish Ruikar',
    specialty: 'Neuro Specialist · Latur',
    avatar: doc7,
  },
  {
    quote: '"The improvement that I see in EkaScribe with every update is significant. Custom templates, direct Rx creation, WhatsApp sharing — it\'s a much fuller product now."',
    name: 'Dr. Rakesh K.R.',
    specialty: 'General Physician · Preventify.Me',
    avatar: doc8,
  },
  {
    quote: '"EkaScribe is part of almost every consultation I run. The interface is comfortable, the workflow is smooth — I have no general complaints about how it functions day to day."',
    name: 'Dr. Naresh Trehan',
    specialty: 'Cardiologist · Gurugram',
    avatar: doc9,
  },
];

const VISIBLE_DOTS = 5;
const AUTO_ADVANCE_MS = 5000;
const FADE_DURATION_MS = 200;

export function AuthPage() {
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [isTransitioning, setIsTransitioning] = React.useState(false);

  // Ref so interval/goTo can always read the latest index without deps
  const activeIndexRef = React.useRef(0);
  const transitionTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const goTo = React.useCallback((index: number) => {
    if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current);
    setIsTransitioning(true);
    transitionTimeoutRef.current = setTimeout(() => {
      activeIndexRef.current = index;
      setActiveIndex(index);
      setIsTransitioning(false);
    }, FADE_DURATION_MS);
  }, []);

  // Auto-advance
  React.useEffect(() => {
    const timer = setInterval(() => {
      goTo((activeIndexRef.current + 1) % TESTIMONIALS.length);
    }, AUTO_ADVANCE_MS);
    return () => clearInterval(timer);
  }, [goTo]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current);
    };
  }, []);

  const prev = () => goTo((activeIndexRef.current + TESTIMONIALS.length - 1) % TESTIMONIALS.length);
  const next = () => goTo((activeIndexRef.current + 1) % TESTIMONIALS.length);

  const handleLogin = React.useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      const oidcResult = await window.authApi.startOidcLogin();
      await window.authApi.onAuthSuccess(oidcResult.refreshToken, oidcResult.accessToken);
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

  const active = TESTIMONIALS[activeIndex];

  // Windowed 5-dot indicator centred around activeIndex
  const windowStart = Math.max(0, Math.min(activeIndex - Math.floor(VISIBLE_DOTS / 2), TESTIMONIALS.length - VISIBLE_DOTS));
  const visibleDots = Array.from({ length: VISIBLE_DOTS }, (_, i) => windowStart + i);

  return (
    <>
    <style>{`
      @keyframes pill-fill {
        from { transform: scaleX(0); }
        to   { transform: scaleX(1); }
      }
      .left-scroll::-webkit-scrollbar { display: none; }
    `}</style>
    <div
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        background: '#fcfcfc',
        fontFamily: 'Inter, "Segoe UI", sans-serif',
      }}
    >
        {/* Left scrollable panel */}
        <div
          className="left-scroll"
          style={{
            position: 'absolute',
            left: 'max(20px, 8vw)',
            top: 0,
            bottom: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            scrollbarWidth: 'none',
          }}
        >
          {/* Logo */}
          <div style={{ paddingTop: 48, height: 32, width: 192, marginBottom: 48 }}>
            <img src={ekaLogo} alt="eka.scribe" style={{ width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'left' }} />
          </div>

          {/* Left column: video + text */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 48,
              paddingBottom: 140,
            }}
          >
            <div
              style={{
                border: '1px solid #d1d1d1',
                width: 'min(640px, calc(58.34vw - 56px))',
                aspectRatio: '640/380',
                borderRadius: 8,
                overflow: 'hidden',
                background: '#eef1fb',
              }}
            >
              <img
                src={doctorOnboardingImage}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ margin: 0, fontSize: 44, fontWeight: 400, lineHeight: '48px', letterSpacing: '-0.9px', color: '#1a1a1a' }}>
                  Less time on notes.
                </p>
                <p style={{ margin: 0, fontSize: 44, fontWeight: 400, lineHeight: '48px', letterSpacing: '-0.9px', color: '#1a1a1a' }}>
                  More time with patients.
                </p>
              </div>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 300, lineHeight: '22px', textWrap: 'balance', color: '#767676', width: 347 }}>
                EkaScribe listens to your consultations and writes structured notes for you – automatically.
              </p>
            </div>
        </div>
      </div>

        {/* Bottom gradient — always anchored to screen edge */}
      <div
        style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            height: 140,
            background: 'linear-gradient(to bottom, rgba(252,252,252,0) 0%, rgba(252,252,252,1) 40%)',
            pointerEvents: 'none',
          }}
        />

        {/* CTA buttons */}
        <div
          style={{
            position: 'fixed',
            left: 'max(20px, 8vw)',
            bottom: 'clamp(2vh, calc(10vh - 40px), 10vh)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
        }}
      >
        <button
          type="button"
          onClick={() => void handleLogin()}
          disabled={isLoading}
          style={{
            width: 240,
            padding: '8px 12px',
            border: 0,
            borderRadius: 8,
            background: isLoading ? '#5377d4' : '#215FFF',
            color: '#ffffff',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            fontSize: 14,
            fontWeight: 500,
            lineHeight: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
          }}
        >
          <span style={{ padding: '0 4px' }}>{isLoading ? 'Logging in…' : 'Login with eka.care'}</span>
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
          <p style={{ margin: 0, fontSize: 12, lineHeight: '16px', color: '#767676', width: 240, textAlign: 'center' }}>
          Don&apos;t have an account?{' '}
          <button
            type="button"
            onClick={() => void handleLogin()}
            disabled={isLoading}
            style={{
              padding: 0,
              border: 0,
              background: 'transparent',
              color: '#215fff',
              fontSize: 12,
              lineHeight: '16px',
              fontWeight: 400,
              cursor: isLoading ? 'not-allowed' : 'pointer',
              textDecoration: 'underline',
            }}
          >
            Sign up.
          </button>
        </p>
        {error ? (
          <div style={{ color: '#cf2f1f', fontSize: 12, wordBreak: 'break-word', maxWidth: 240 }}>{error}</div>
        ) : null}
      </div>

      {/* Testimonial card */}
      <div
        style={{
          position: 'absolute',
          left: 'calc(66.67% + 6px)',
          top: 128,
          width: 286,
          height: 326,
          background: '#f5f5f5',
          border: '1px solid #d1d1d1',
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Fading content wrapper */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            opacity: isTransitioning ? 0 : 1,
            transition: `opacity ${FADE_DURATION_MS}ms ease`,
          }}
        >
          {/* Quote text */}
          <div style={{ flex: 1, padding: 16, position: 'relative', overflow: 'hidden' }}>
            <div
              style={{
                position: 'absolute',
                right: -7,
                top: 190,
                width: 103,
                height: 78,
                transform: 'rotate(180deg)',
                pointerEvents: 'none',
              }}
            >
              <img src={quoteMarks} alt="" style={{ width: '100%', height: '100%' }} />
            </div>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 400, lineHeight: '24px', color: '#767676' }}>
              {active.quote}
            </p>
          </div>

          {/* Doctor info */}
          <div
            style={{
              borderTop: '1px solid #d1d1d1',
              padding: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <img
              src={active.avatar}
              alt={active.name}
              style={{ width: 48, height: 48, borderRadius: '50%', flexShrink: 0, objectFit: 'cover' }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px', color: '#1a1a1a' }}>
                {active.name}
              </p>
              <p style={{ margin: 0, fontSize: 12, fontWeight: 400, lineHeight: '16px', color: '#1a1a1a', opacity: 0.6 }}>
                {active.specialty}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Carousel controls */}
      <div
        style={{
          position: 'absolute',
          left: 'calc(66.67% + 6px)',
          top: 466,
          width: 286,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <button
          onClick={prev}
          style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 0, cursor: 'pointer', padding: 0, flexShrink: 0 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>

        {/* Windowed 5 dots */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {visibleDots.map((dotIndex) => {
            const isActive = dotIndex === activeIndex;
            return (
              <button
                key={dotIndex}
                onClick={() => goTo(dotIndex)}
                style={{
                  position: 'relative',
                  width: isActive ? 28 : 6,
                  height: 6,
                  borderRadius: 3,
                  background: '#d1d1d1',
                  border: 0,
                  padding: 0,
                  cursor: 'pointer',
                  flexShrink: 0,
                  overflow: 'hidden',
                  transition: 'width 0.3s ease',
                }}
              >
                {isActive && (
                  <div
                    key={activeIndex}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background: '#215FFF',
                      transformOrigin: 'left',
                      animation: `pill-fill ${AUTO_ADVANCE_MS}ms linear forwards`,
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>

        <button
          onClick={next}
          style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 0, cursor: 'pointer', padding: 0, flexShrink: 0 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>
    </div>
    </>
  );
}

export default AuthPage;
