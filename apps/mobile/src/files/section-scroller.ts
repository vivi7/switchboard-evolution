/** A heading on screen, as far as it is needed to scroll to it. */
type Measurable<Body> = {
  measureLayout(relativeTo: Body, onSuccess: (x: number, y: number) => void, onFail?: () => void): void;
};

/**
 * Where the headings of a formatted file are, to scroll to the section a link
 * names. It is given the scroll view, the view the text is in and each heading
 * by its anchor; `opening` is the section to show once the text is first laid
 * out.
 */
export function sectionScroller<Body>(opening?: string) {
  let scroller: { scrollTo(to: { y: number }): void } | null = null;
  let body: Body | null = null;
  const headings = new Map<string, Measurable<Body>>();
  let waiting = opening;
  const show = (anchor: string) => {
    const heading = headings.get(anchor.toLowerCase());
    if (heading && body) heading.measureLayout(body, (_x, y) => scroller?.scrollTo({ y }), () => {});
  };
  return {
    setScroller(view: typeof scroller) { scroller = view; },
    setBody(view: Body | null) { body = view; },
    setHeading(anchor: string, view: Measurable<Body> | null) {
      if (view) headings.set(anchor, view);
      else headings.delete(anchor);
    },
    show,
    laidOut() {
      const wanted = waiting;
      waiting = undefined;
      if (wanted) show(wanted);
    },
  };
}
