import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, Input, Textarea, Card, Badge, Chip, cx } from '../index';

// Node-env test (no jsdom): render the primitives to static markup and assert on
// the produced HTML. Assertions avoid CSS-module class hashing — they check the
// semantic element, the data-variant hook, forwarded native props, and that a
// caller-supplied className is passed through — so they hold in every environment.

describe('cx', () => {
  it('joins truthy strings and drops falsy values', () => {
    expect(cx('a', 'b')).toBe('a b');
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
    expect(cx(false, null, undefined)).toBe('');
  });

  it('supports conditional class composition', () => {
    const active = true;
    const disabled = false;
    expect(cx('base', active && 'on', disabled && 'off', 'end')).toBe('base on end');
  });
});

describe('Button', () => {
  it('renders a <button>, defaults type=button and variant=primary', () => {
    const html = renderToStaticMarkup(<Button>Search</Button>);
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    expect(html).toContain('data-variant="primary"');
    expect(html).toContain('Search');
  });

  it('honours variant and type=submit and forwards native props', () => {
    const html = renderToStaticMarkup(
      <Button variant="secondary" type="submit" disabled aria-label="Go">
        Go
      </Button>,
    );
    expect(html).toContain('data-variant="secondary"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled');
    expect(html).toContain('aria-label="Go"');
  });

  it('passes through a caller className', () => {
    const html = renderToStaticMarkup(<Button className="kf-home__search-btn">Search</Button>);
    expect(html).toContain('kf-home__search-btn');
  });

  it('supports the danger variant for destructive actions', () => {
    const html = renderToStaticMarkup(<Button variant="danger">Delete my account</Button>);
    expect(html).toContain('data-variant="danger"');
    expect(html).toContain('Delete my account');
  });

  it('forwards onClick-style usage props for client consumers (name/value/form)', () => {
    const html = renderToStaticMarkup(
      <Button name="action" value="save" form="savebar" fullWidth>
        Save search
      </Button>,
    );
    expect(html).toContain('name="action"');
    expect(html).toContain('value="save"');
    expect(html).toContain('form="savebar"');
  });

  it('defaults to size=md and honours the compact size=sm', () => {
    expect(renderToStaticMarkup(<Button>Go</Button>)).toContain('data-size="md"');
    const sm = renderToStaticMarkup(
      <Button size="sm" variant="secondary">
        Open
      </Button>,
    );
    expect(sm).toContain('data-size="sm"');
    expect(sm).toContain('data-variant="secondary"');
  });

  it('renders a real anchor via as="a" (keeps navigation semantics) with no button type', () => {
    const html = renderToStaticMarkup(
      <Button as="a" href="/account" variant="secondary" size="sm">
        Open
      </Button>,
    );
    expect(html).toMatch(/^<a/);
    expect(html).toContain('href="/account"');
    expect(html).toContain('data-variant="secondary"');
    expect(html).toContain('data-size="sm"');
    // A polymorphic anchor must NOT inherit the <button> type="button" default.
    expect(html).not.toContain('type="button"');
  });

  it('still renders a native <button> (type=button) when as is omitted', () => {
    const html = renderToStaticMarkup(<Button>Search</Button>);
    expect(html).toMatch(/^<button/);
    expect(html).toContain('type="button"');
  });
});

describe('Textarea', () => {
  it('renders a <textarea> and forwards name/rows/placeholder/aria', () => {
    const html = renderToStaticMarkup(
      <Textarea name="filters" rows={2} placeholder="e.g. under $20" aria-label="Filters" />,
    );
    expect(html).toContain('<textarea');
    expect(html).toContain('name="filters"');
    expect(html).toContain('rows="2"');
    expect(html).toContain('placeholder="e.g. under $20"');
    expect(html).toContain('aria-label="Filters"');
  });

  it('passes through a caller className and forwards native props / defaultValue', () => {
    const html = renderToStaticMarkup(
      <Textarea className="kf-saved__textarea" name="filters" defaultValue="under $20" disabled />,
    );
    expect(html).toContain('kf-saved__textarea');
    expect(html).toContain('name="filters"');
    expect(html).toContain('disabled');
    expect(html).toContain('under $20'); // defaultValue renders as textarea content
  });
});

describe('Input', () => {
  it('renders an <input> and forwards name/type/placeholder/aria', () => {
    const html = renderToStaticMarkup(
      <Input type="search" name="q" placeholder="family swim" aria-label="Search" />,
    );
    expect(html).toContain('<input');
    expect(html).toContain('type="search"');
    expect(html).toContain('name="q"');
    expect(html).toContain('placeholder="family swim"');
    expect(html).toContain('aria-label="Search"');
  });

  it('defaults to type=text and passes through a caller className', () => {
    const html = renderToStaticMarkup(<Input className="kf-home__search-input" />);
    expect(html).toContain('type="text"');
    expect(html).toContain('kf-home__search-input');
  });
});

describe('Card', () => {
  it('renders a <div> by default with its children', () => {
    const html = renderToStaticMarkup(<Card>Body</Card>);
    expect(html).toMatch(/^<div/);
    expect(html).toContain('Body');
  });

  it('renders the polymorphic element from `as`', () => {
    const html = renderToStaticMarkup(
      <Card as="li" className="trust">
        Item
      </Card>,
    );
    expect(html).toContain('<li');
    expect(html).toContain('trust');
    expect(html).toContain('Item');
  });
});

describe('Badge', () => {
  it('renders a labelled <span> with the semantic variant (never colour-only)', () => {
    const html = renderToStaticMarkup(<Badge variant="confirmed">Confirmed</Badge>);
    expect(html).toContain('<span');
    expect(html).toContain('data-variant="confirmed"');
    expect(html).toContain('Confirmed'); // the text label is always present
  });

  it('defaults to the neutral variant', () => {
    const html = renderToStaticMarkup(<Badge>Info</Badge>);
    expect(html).toContain('data-variant="neutral"');
  });
});

describe('Chip', () => {
  it('renders a <button>, defaults type=button, variant=rail, size=md', () => {
    const html = renderToStaticMarkup(<Chip>Today</Chip>);
    expect(html).toMatch(/^<button/);
    expect(html).toContain('type="button"');
    expect(html).toContain('data-variant="rail"');
    expect(html).toContain('data-size="md"');
    expect(html).toContain('Today');
  });

  it('renders the ✓ and data-selected when a rail chip is selected (fill AND check, never colour-only)', () => {
    const html = renderToStaticMarkup(<Chip selected>Free</Chip>);
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('✓');
    expect(html).toContain('aria-hidden="true"'); // the check span is decorative
  });

  it('renders NO ✓ and no data-selected when a rail chip is unselected', () => {
    const html = renderToStaticMarkup(<Chip>Free</Chip>);
    expect(html).not.toContain('data-selected');
    expect(html).not.toContain('✓');
  });

  it('preserves the caller aria selection semantics (never invents them)', () => {
    // radio-like group → aria-current; the primitive must forward exactly what it is given.
    const current = renderToStaticMarkup(
      <Chip selected aria-current="true">
        Soonest
      </Chip>,
    );
    expect(current).toContain('aria-current="true"');
    expect(current).not.toContain('aria-pressed');
    // multi-select toggle → aria-pressed.
    const pressed = renderToStaticMarkup(
      <Chip selected aria-pressed>
        Include unknown cost
      </Chip>,
    );
    expect(pressed).toContain('aria-pressed="true"');
    expect(pressed).not.toContain('aria-current');
  });

  it('segmented variant: sets data-variant, shows the on-state WITHOUT a ✓ (fill + aria-pressed)', () => {
    const on = renderToStaticMarkup(
      <Chip variant="segmented" selected aria-pressed>
        List
      </Chip>,
    );
    expect(on).toContain('data-variant="segmented"');
    expect(on).toContain('data-selected="true"');
    expect(on).toContain('aria-pressed="true"');
    expect(on).not.toContain('✓'); // the segmented on-state is fill-only, not a checkmark
    expect(on).not.toContain('data-size'); // size is a rail-only concern
  });

  it('honours the compact rail size=sm (sort/cost density)', () => {
    const html = renderToStaticMarkup(
      <Chip size="sm" selected aria-current="true">
        Nearest
      </Chip>,
    );
    expect(html).toContain('data-size="sm"');
    expect(html).toContain('data-variant="rail"');
  });

  it('renders a real anchor via as="a" (URL-driven filter) with href and NO button type', () => {
    const html = renderToStaticMarkup(
      <Chip as="a" href="/search?when=today" selected aria-current="true">
        Today
      </Chip>,
    );
    expect(html).toMatch(/^<a/);
    expect(html).toContain('href="/search?when=today"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('✓'); // rail selected → check even as an anchor
    expect(html).not.toContain('type="button"');
  });

  it('renders a static, non-interactive indicator via as="span" (e.g. "Near you")', () => {
    const html = renderToStaticMarkup(
      <Chip as="span" selected aria-current="true">
        Near you
      </Chip>,
    );
    expect(html).toMatch(/^<span/);
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('✓');
    expect(html).not.toContain('type="button"');
  });

  it('supports the action affordance and forwards disabled / aria-busy / className', () => {
    const html = renderToStaticMarkup(
      <Chip action disabled aria-busy className="kf-nearme">
        Near me
      </Chip>,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('kf-nearme'); // caller className passes through
    expect(html).not.toContain('data-selected'); // an action chip is not a selected state
  });
});
