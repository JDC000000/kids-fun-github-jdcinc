import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, Input, Card, Badge, cx } from '../index';

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
