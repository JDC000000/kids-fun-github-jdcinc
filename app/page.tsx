import { ResultsShell } from './preview/_components/ResultsShell';

export default function Home() {
  return (
    <div className="kf">
      <div className="kf-page">
        <div className="kf-app">
          <header className="kf-hero">
            <p className="kf-hero__wordmark">KIDS FUN</p>
            <h1 className="kf-hero__title">See what’s on for your kids today.</h1>
            <p className="kf-hero__sub">
              First usable staging slice: mobile cards powered by the fixture-backed search API.
            </p>
          </header>
          <ResultsShell />
        </div>
      </div>
    </div>
  );
}
