import { ResultsShell } from './_components/ResultsShell';

// Landing / Today dashboard (Screen 1) — an East Van parent lands and, in <30s,
// sees real things to do today near them. Server component; the interactive
// results surface is a client island. Fixture-backed (Track E, backend-optional).

export default function PreviewPage() {
  return (
    <>
      <header className="kf-hero">
        <p className="kf-hero__wordmark">KIDS FUN</p>
        <h1 className="kf-hero__title">See what&apos;s on for your kids today.</h1>
        <p className="kf-hero__sub">Search by age, time, area, and booking status — with the source and last-checked date on every card.</p>
      </header>
      <ResultsShell />
    </>
  );
}
