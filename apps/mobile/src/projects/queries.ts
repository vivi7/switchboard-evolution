import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { request, useConnection } from '@/store/connection';
import type { Project, ProjectPlan } from './model';

/** get-project-tree, shared by every screen that shows projects. */
export function useProjectTree() {
  const online = useConnection((s) => s.status.state === 'online');
  return useQuery({
    queryKey: ['project-tree'],
    queryFn: () => request<{ projects: Project[] }>('get-project-tree', [false]),
    enabled: online,
  });
}

export function useProject(id: string | undefined) {
  const tree = useProjectTree();
  return { ...tree, project: tree.data?.projects.find((p) => p.id === id) };
}

export function useProjectPlan(id: string | undefined) {
  const online = useConnection((s) => s.status.state === 'online');
  return useQuery({
    queryKey: ['project-plan', id],
    queryFn: () => request<ProjectPlan & { error?: string }>('get-project-plan', [id]),
    enabled: online && !!id,
  });
}

/**
 * A project's own picture as a data: URL, asked for once per version of it;
 * null while it has none, or until it arrives.
 */
export function useProjectIcon({ id, icon }: Pick<Project, 'id' | 'icon'>): string | null {
  const online = useConnection((s) => s.status.state === 'online');
  const query = useQuery({
    queryKey: ['project-icon', id, icon],
    queryFn: async () => {
      const result = await act<{ icon: string | null; dataUrl: string | null }>('get-project-icon', [id]);
      // Changed meanwhile: not the picture of this version. The tree brings the new one.
      if (result.icon !== icon) throw new Error('The project icon changed');
      return result.dataUrl;
    },
    enabled: online && !!icon,
    gcTime: Infinity,
  });
  return icon ? query.data ?? null : null;
}

/** Call the computer; a returned { error } becomes a thrown one. `timeoutMs` for a call known to be slow. */
export async function act<T = any>(method: string, params: unknown[], options?: { timeoutMs?: number }): Promise<T> {
  const result: any = await request(method, params, options);
  if (result && typeof result === 'object' && result.error) throw new Error(result.error);
  if (result && typeof result === 'object' && result.ok === false) throw new Error(result.error || 'That did not work');
  return result;
}

/** The time, again every minute: a snooze ends without anything else changing. */
export function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
