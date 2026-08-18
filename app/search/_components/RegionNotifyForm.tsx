'use client';

// RegionNotifyForm — the "email me when this area is live" capture that sits inside /search's
// sparse-coverage notice (app/search/_lib/coverage-notice.ts).
//
// WHY IT IS PART OF THE HONEST STATE RATHER THAN A PROMOTION ATTACHED TO IT. The notice above it
// tells a parent something genuinely unhelpful — we have almost nothing here and no change to
// their search will fix that. This is the one useful thing left to offer, and it offers exactly
// that: to be told, once, when the answer changes. It makes no other claim, asks for nothing
// else, and is not a newsletter (see supabase/migrations/0032 for what is actually stored).
//
// NO OPTIMISTIC ACKNOWLEDGEMENT, deliberately, and this is the difference from the "Report wrong
// info" control (lib/corrections/client.ts), which shows its thanks whether or not the write
// landed. A correction is a gift — losing it costs the parent nothing they were promised. This
// says "we will email you", so it may only say so once the server has confirmed the address is
// on the list. POST /api/notify/region returns a real error on a failed write for the same
// reason; a cheerful confirmation over a row that does not exist is the quiet substitution this
// whole surface exists to end.
//
// Styling uses the canonical primitives (components/ui) so the control stays token-driven, and
// the muted `.kf-coverage` palette so it reads as part of the honest notice rather than as an
// ad interrupting it.
import { useState, type FormEvent } from 'react';
import { Button, Input } from '@/components/ui';

interface RegionNotifyFormProps {
  /**
   * The sparsely-covered areas currently selected — signed up for together.
   *
   * A list because area chips are multi-select: a parent with both thin municipalities on has
   * asked about both, and capturing one of them would silently drop the other. See the
   * per-region POST loop below for how a partial failure is handled.
   */
  regions: { chipId: string; regionName: string }[];
}

type Phase = 'idle' | 'sending' | 'done' | 'error';

export function RegionNotifyForm({ regions }: RegionNotifyFormProps) {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');

  const areaLabel = regions.map((r) => r.regionName).join(' and ');
  // Distinct per area selection, so the field is labelled correctly when a parent changes chips
  // and React reuses this instance rather than remounting it.
  const inputId = `kf-notify-${regions.map((r) => r.chipId).join('-')}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === 'sending') return;
    setPhase('sending');
    setMessage('');

    try {
      // One request per area. A PARTIAL FAILURE IS REPORTED AS A FAILURE — the parent asked
      // about both areas, so "we saved one of them" is not the thing they asked for and a
      // success message would overstate it. Retrying is safe and cheap: the endpoint dedupes on
      // (area, email), so the area that already landed is not written twice.
      for (const region of regions) {
        const res = await fetch('/api/notify/region', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ region: region.chipId, email }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setPhase('error');
          setMessage(data?.error ?? `Couldn’t save that (${res.status}).`);
          return;
        }
      }
      setPhase('done');
    } catch {
      setPhase('error');
      setMessage('Network error — please try again.');
    }
  }

  if (phase === 'done') {
    return (
      <p className="kf-coverage__done" role="status">
        {/* Only what we can actually keep: what is stored is one address against one area
            (migration 0032) and nothing is attached to it — no digest, no campaign. */}
        Thanks — we’ll email you when we have {areaLabel} covered. That is the only thing your
        address is kept for.
      </p>
    );
  }

  return (
    <form className="kf-coverage__form" onSubmit={submit}>
      <label className="kf-coverage__label" htmlFor={inputId}>
        Email me when {areaLabel} is live
      </label>
      <div className="kf-coverage__row">
        <Input
          id={inputId}
          className="kf-coverage__input"
          type="email"
          name="email"
          value={email}
          autoComplete="email"
          placeholder="you@example.com"
          required
          aria-describedby={phase === 'error' ? `${inputId}-err` : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={phase === 'sending'} aria-busy={phase === 'sending'}>
          {phase === 'sending' ? 'Saving…' : 'Notify me'}
        </Button>
      </div>
      {phase === 'error' && (
        <p className="kf-coverage__err" id={`${inputId}-err`} role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
