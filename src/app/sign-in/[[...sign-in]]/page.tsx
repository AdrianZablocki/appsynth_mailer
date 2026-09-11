import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontWeight: 800, color: '#086633', fontSize: 18 }}>AppSynth mailer</div>
      <SignIn />
    </div>
  );
}
