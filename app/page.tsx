export default function Home() {
  const env = process.env.NEXT_PUBLIC_APP_ENV ?? 'development';
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem', maxWidth: 640 }}>
      <h1>KIDS FUN</h1>
      <p>Foundation deploy is live. Environment: <strong>{env}</strong>.</p>
      <p>Metro Vancouver kids-activity index — Milestone M0 platform bring-up.</p>
    </main>
  );
}
