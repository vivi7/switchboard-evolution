import { router } from 'expo-router';
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { Alert } from 'react-native';

import { act } from '@/projects/queries';
import { stripLocation } from '@/sessions/file-refs';
import { useCapability } from '@/store/connection';

type OpenFile = (path: string, section?: string) => void;

const OpenFileContext = createContext<OpenFile | null>(null);

/** How the chat opens a file it mentions; null when the computer cannot find files for the phone (an older desktop). */
export function useOpenFile(): OpenFile | null {
  return useContext(OpenFileContext);
}

/** Lets the chat inside open the files it mentions, a relative path from the session's folder `cwd`. */
export function OpenFileProvider({ cwd, children }: { cwd?: string; children: ReactNode }) {
  const can = useCapability('locate-file');
  const open = useCallback((path: string, section?: string) => { openPath(path, cwd, section); }, [cwd]);
  return <OpenFileContext.Provider value={can ? open : null}>{children}</OpenFileContext.Provider>;
}

type Located = { root: string; relativePath: string; type: 'file' | 'directory' };

/**
 * Ask the computer where a path is, then open it: a file in the file viewer
 * (Markdown formatted, at `section` when a link names one), a folder in the
 * file list. Says so when it is not found or not in a folder the phone may read.
 */
export async function openPath(ref: string, cwd?: string, section?: string) {
  const path = stripLocation(ref.trim());
  const name = path.split('/').filter(Boolean).pop() || path;
  try {
    const found = await act<Located>('locate-file', cwd ? [path, cwd] : [path]);
    if (found.type === 'directory') router.push({ pathname: '/files', params: { root: found.root, path: found.relativePath, title: name } });
    else router.push({ pathname: '/file', params: { root: found.root, path: found.relativePath, ...(section ? { section } : {}) } });
  } catch (err: any) {
    Alert.alert(`Could not open ${name}`, err?.message || String(err));
  }
}
