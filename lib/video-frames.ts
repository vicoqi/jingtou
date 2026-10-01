import type { Project, Shot, VideoCandidate } from './types.ts';

export function getVideoFrameContext(project: Project, shot: Shot) {
  const index = project.shots.findIndex(item => item.id === shot.id);
  const previousShot = index > 0 ? project.shots[index - 1] : null;
  return {
    index,
    previousShot,
    previousFrame: previousShot?.candidates.find(candidate => candidate.id === previousShot.selectedCandidateId) ?? null,
    currentFrame: shot.candidates.find(candidate => candidate.id === shot.selectedCandidateId) ?? null,
    endFrame: shot.candidates.find(candidate => candidate.id === shot.selectedEndCandidateId) ?? null,
  };
}

// Shared by the editor and the PUT endpoint, including the period before the
// generation acknowledgement reaches the browser. Legacy tasks use only their own image.
export function videoFrameEditConflict(current: Project, proposed: Project): string | null {
  for (const shot of current.shots) {
    if (shot.video.status !== 'generating') continue;
    const next = proposed.shots.find(item => item.id === shot.id);
    if (!next) return '视频生成期间不能删除正在生成的镜头，请等待生成完成。';
    if (shot.description !== next.description) return '视频生成期间不能修改画面描述，请等待生成完成。';
    const before = getVideoFrameContext(current, shot);
    const after = getVideoFrameContext(proposed, next);
    if (shot.selectedCandidateId !== next.selectedCandidateId || before.currentFrame?.url !== after.currentFrame?.url) {
      return '视频生成期间不能更换参与生成的画面，请等待生成完成。';
    }
    if (shot.video.source?.sourceMode === 'independent'
      && ((shot.selectedEndCandidateId ?? null) !== (next.selectedEndCandidateId ?? null) || before.endFrame?.url !== after.endFrame?.url)) {
      return '视频生成期间不能更换或移除尾帧，请等待生成完成。';
    }
    if (shot.video.source?.sourcePreviousShotId !== undefined) {
      if (before.previousShot?.id !== after.previousShot?.id) return '视频生成期间不能改变该镜头与前一镜头的顺序关系，请等待生成完成。';
      if (before.previousShot?.selectedCandidateId !== after.previousShot?.selectedCandidateId || before.previousFrame?.url !== after.previousFrame?.url) {
        return '这张画面正作为后一镜头的首帧，视频生成完成后才能更换或删除。';
      }
    }
  }
  return null;
}

export function isVideoFrameLocked(project: Project, shotId: string): boolean {
  return project.shots.some(shot => shot.video.status === 'generating'
    && (shot.id === shotId || shot.video.source?.sourcePreviousShotId === shotId));
}

export function videoFirstFrameUrl(project: Project, shot: Shot, video?: VideoCandidate): string | undefined {
  const candidate = video ?? shot.video.candidates.find(item=>item.id===shot.video.selectedVideoId);
  if (!candidate) return undefined;
  const sourceShot = candidate.sourcePreviousShotId
    ? project.shots.find(item=>item.id===candidate.sourcePreviousShotId) : shot;
  return sourceShot?.candidates.find(item=>item.id===candidate.sourceFirstFrameId)?.url;
}
