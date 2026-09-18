export interface DshSessionRuntimeIdentity {
  mountedPresetId?: unknown
  model?: unknown
  subagentModel?: unknown
}

export function sessionRuntimeIdentityChanged(
  previous: DshSessionRuntimeIdentity | undefined,
  next: DshSessionRuntimeIdentity
): boolean {
  if (previous === undefined) return false
  return JSON.stringify(runtimeIdentity(previous)) !== JSON.stringify(runtimeIdentity(next))
}

function runtimeIdentity(snapshot: DshSessionRuntimeIdentity): DshSessionRuntimeIdentity {
  return {
    mountedPresetId: snapshot.mountedPresetId,
    model: snapshot.model,
    subagentModel: snapshot.subagentModel
  }
}
