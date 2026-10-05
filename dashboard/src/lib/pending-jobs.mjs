// Jobs belong to workspaces, independently of which workspace is being viewed.
export function pendingJobsReducer(jobs, action) {
  if (action.type === "accepted") {
    return {
      ...jobs,
      [action.root]: {
        requestedAt: action.alreadyRunning ? 0 : action.requestedAt,
        acceptedAt: action.acceptedAt,
      },
    };
  }
  if (jobs[action.root]?.acceptedAt !== action.acceptedAt) return jobs;
  const next = { ...jobs };
  delete next[action.root];
  return next;
}

export function pendingJobOutcome(pending, job, readStartedAt) {
  if (!pending || readStartedAt < pending.acceptedAt) return null;
  if (job?.finishedAt && !job.running && job.startedAt >= pending.requestedAt)
    return job.error ? "failed" : "complete";
  if (job === null && readStartedAt > pending.acceptedAt) return "missing";
  return null;
}
