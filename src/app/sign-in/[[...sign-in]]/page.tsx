import { SignIn } from '@clerk/nextjs';

/* eslint-disable @next/next/no-img-element -- statyczny 60 px PNG, bez optymalizacji */
export default function SignInPage() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 24, padding: 24 }}>
      <div className="brand" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <img src="/logo-nav.png" alt="" width={28} height={28} style={{ display: 'block' }} />
        <b style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.03em' }}>AppSynth</b>
        <span className="eyebrow" style={{ fontSize: 11, paddingLeft: 10, borderLeft: '1px solid var(--line)' }}>Mailer</span>
      </div>
      <SignIn
        appearance={{
          variables: { colorPrimary: '#111512', colorBackground: '#ffffff', colorForeground: '#111512', colorMutedForeground: '#5b615a', colorNeutral: '#111512', colorInput: '#ffffff', colorInputForeground: '#111512', borderRadius: '6px', fontFamily: 'var(--sans)', fontSize: '15px' },
          elements: { cardBox: { boxShadow: 'var(--shadow-lg)', border: '1px solid var(--line)', borderRadius: '16px' }, formButtonPrimary: { borderRadius: '9999px', background: '#7ac29b', color: '#111512', fontWeight: 500, boxShadow: 'none', '&:hover': { background: '#6ab58c' } }, socialButtonsBlockButton: { borderRadius: '9999px', borderColor: 'var(--line)' } },
        }}
      />
    </div>
  );
}
