import { describe, expect, it } from '@jest/globals';
import MarkdownIt from 'markdown-it';

import { headingAnchors } from '../heading-anchors';

describe("headings' anchors", () => {
  it('are the ones GitHub gives, from the text as written', () => {
    const tokens = MarkdownIt({ typographer: true }).use(headingAnchors)
      .parse('# The example.test cluster\n\n## 2. Run `build.sh` -- [now](x.md)\n\n## Setup\n\n## Setup\n', {});
    expect(tokens.filter((t) => t.type === 'heading_open').map((t) => t.attrGet('anchor')))
      .toEqual(['the-exampletest-cluster', '2-run-buildsh----now', 'setup', 'setup-1']);
  });
});
