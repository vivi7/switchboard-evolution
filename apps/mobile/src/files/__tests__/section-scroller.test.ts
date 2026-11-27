import { describe, expect, it } from '@jest/globals';

import { sectionScroller } from '../section-scroller';

function setup(opening?: string) {
  const sections = sectionScroller<string>(opening);
  const scrolled: number[] = [];
  sections.setScroller({ scrollTo: ({ y }) => scrolled.push(y) });
  sections.setBody('body');
  const heading = (y: number) => ({ measureLayout: (_body: string, done: (x: number, y: number) => void) => done(0, y) });
  sections.setHeading('start', heading(0));
  sections.setHeading('set-up', heading(420));
  return { sections, scrolled };
}

describe('sections of a formatted file', () => {
  it('scrolls to the heading a link names, and nowhere for a name no heading has', () => {
    const { sections, scrolled } = setup();
    sections.show('Set-Up');
    sections.show('nothing');
    sections.setHeading('start', null);
    sections.show('start');
    expect(scrolled).toEqual([420]);
  });

  it('shows the section the file was opened at once, when first laid out', () => {
    const { sections, scrolled } = setup('set-up');
    sections.laidOut();
    sections.laidOut();
    expect(scrolled).toEqual([420]);
  });
});
