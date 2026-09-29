import { rebaseProjectEdits } from './domain.ts';
import type { Project } from './types.ts';

export function isWorkspaceBusy(state:{working:boolean;navigating:boolean;generating:boolean}):boolean {
  return state.working || state.navigating;
}

export function selectNewerProject<T extends {id:string;revision:number}>(current:T | null,incoming:T):T {
  return current?.id===incoming.id && current.revision>incoming.revision ? current : incoming;
}

export function mergeGenerationAcknowledgement(current:Project,incoming:Project,hasLocalEdits:boolean):Project {
  const newer=selectNewerProject(current,incoming);
  if (newer===current || current.id!==incoming.id || !hasLocalEdits) return newer;
  // A generation acknowledgement may arrive after editing has resumed, before autosave.
  return rebaseProjectEdits(current,incoming);
}
