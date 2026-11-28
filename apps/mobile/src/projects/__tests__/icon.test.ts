import { describe, expect, it, jest } from '@jest/globals';

import { chooseProjectIcon, iconFileName, type IconIO, type PickedFile } from '@/projects/icon';

jest.mock('@/store/connection', () => ({ request: jest.fn() }));

function io(picked: PickedFile | null, { size = 4, answer = { ok: true } as { ok?: boolean; error?: string } } = {}) {
  const request = jest.fn(async (..._args: unknown[]) => answer);
  const device: IconIO = {
    pick: async () => picked,
    readFile: () => ({ size, base64: async () => 'PHN2Zy8+' }),
    request: request as unknown as IconIO['request'],
  };
  return { device, request };
}

describe('iconFileName', () => {
  it('keeps a PNG, JPG or SVG name', () => {
    expect(iconFileName({ name: 'logo.SVG' })).toBe('logo.SVG');
    expect(iconFileName({ name: 'photo.jpeg', mimeType: 'image/jpeg' })).toBe('photo.jpeg');
  });

  it('adds the extension of the type to a name without one', () => {
    expect(iconFileName({ name: 'document:42', mimeType: 'image/png' })).toBe('document:42.png');
    expect(iconFileName({ name: '', mimeType: 'image/svg+xml' })).toBe('icon.svg');
  });

  it('refuses anything else', () => {
    expect(iconFileName({ name: 'anim.gif', mimeType: 'image/gif' })).toBeNull();
    expect(iconFileName({ name: 'notes' })).toBeNull();
  });
});

describe('chooseProjectIcon', () => {
  it('sends the picked file to the computer', async () => {
    const { device, request } = io({ uri: 'file:///cache/logo.svg', name: 'logo.svg' });
    await expect(chooseProjectIcon('p1', device)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith('import-project-icon', ['p1', 'logo.svg', 'PHN2Zy8+'], { timeoutMs: 120_000 });
  });

  it('does nothing when the file browser is closed', async () => {
    const { device, request } = io(null);
    await expect(chooseProjectIcon('p1', device)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a file of another kind, too large or empty, before sending it', async () => {
    const cases: [PickedFile, number, RegExp][] = [
      [{ uri: 'u', name: 'a.gif' }, 4, /PNG, JPG or SVG/],
      [{ uri: 'u', name: 'a.png', size: 9 * 1024 * 1024 }, 4, /Too large/],
      [{ uri: 'u', name: 'a.png' }, 9 * 1024 * 1024, /Too large/],
      [{ uri: 'u', name: 'a.png' }, 0, /empty/],
    ];
    for (const [picked, size, message] of cases) {
      const { device, request } = io(picked, { size });
      await expect(chooseProjectIcon('p1', device)).rejects.toThrow(message);
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('throws what the computer says', async () => {
    const { device } = io({ uri: 'u', name: 'a.png' }, { answer: { error: 'Could not read this image.' } });
    await expect(chooseProjectIcon('p1', device)).rejects.toThrow('Could not read this image.');
  });
});
