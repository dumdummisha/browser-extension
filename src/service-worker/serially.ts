// Runs tasks one at a time, in the order they came: a failed one rejects its own promise and the next still runs.
export const serially = (): (<TResult>(task: () => Promise<TResult>) => Promise<TResult>) => {
  let tail: Promise<unknown> = Promise.resolve()

  return (task) => {
    const next = tail.then(task)
    tail = next.catch(() => undefined)

    return next
  }
}
