export function isWorkspaceBusy(state:{working:boolean;navigating:boolean;generating:boolean}):boolean {
  return state.working || state.navigating;
}

export function selectNewerProject<T extends {id:string;revision:number}>(current:T | null,incoming:T):T {
  return current?.id===incoming.id && current.revision>incoming.revision ? current : incoming;
}
