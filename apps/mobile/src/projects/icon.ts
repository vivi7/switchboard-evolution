import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

import { attachmentName, MAX_ATTACHMENT_BYTES, TOO_LARGE } from '@/sessions/attachments';
import { request } from '@/store/connection';

// A project's picture, chosen on the phone: the file goes to the computer as it
// is (import-project-icon), which resizes and crops it and tells every screen.

const ICON_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'];
const ICON_NAME = /\.(png|jpe?g|svg)$/i;
const EXTENSION_OF: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };
// An 8 MB upload over a slow network.
const UPLOAD_TIMEOUT_MS = 120_000;

export type PickedFile = { uri: string; name: string; mimeType?: string; size?: number };

export type IconIO = {
  pick: () => Promise<PickedFile | null>;
  readFile: (uri: string) => { size: number; base64(): Promise<string> };
  request: <T = any>(method: string, params?: unknown[], options?: { timeoutMs?: number }) => Promise<T>;
};

const deviceIO: IconIO = {
  pick: async () => {
    // Copied to the cache so expo-file-system can read it right away.
    const result = await DocumentPicker.getDocumentAsync({ type: ICON_TYPES, multiple: false, copyToCacheDirectory: true });
    return result.canceled ? null : result.assets[0] ?? null;
  },
  readFile: (uri) => new File(uri),
  request,
};

/** The file's name as the computer reads its kind: with the extension of its type when it has none. */
export function iconFileName({ name, mimeType }: Pick<PickedFile, 'name' | 'mimeType'>): string | null {
  if (ICON_NAME.test(name)) return attachmentName(name);
  const extension = mimeType ? EXTENSION_OF[mimeType] : undefined;
  return extension ? attachmentName(`${name || 'icon'}.${extension}`) : null;
}

/** Pick a file in the phone's file browser and make it the project's picture. False when cancelled. */
export async function chooseProjectIcon(projectId: string, io: IconIO = deviceIO): Promise<boolean> {
  const picked = await io.pick();
  if (!picked) return false;
  const name = iconFileName(picked);
  if (!name) throw new Error('Choose a PNG, JPG or SVG image.');
  if ((picked.size ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error(TOO_LARGE);
  const file = io.readFile(picked.uri);
  // The size can be unknown to the picker: the file says.
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(TOO_LARGE);
  if (!file.size) throw new Error('The file is empty');
  const answer = await io.request<{ ok?: boolean; error?: string }>('import-project-icon', [projectId, name, await file.base64()], { timeoutMs: UPLOAD_TIMEOUT_MS });
  if (!answer?.ok) throw new Error(answer?.error || 'The computer did not save the icon');
  return true;
}
