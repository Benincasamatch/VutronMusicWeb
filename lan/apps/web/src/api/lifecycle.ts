export type EnvironmentEvents = {
  // Every visibility transition, so the store can measure how long the page was away.
  visibility: (state: 'visible' | 'hidden') => void
  online: () => void
  offline: () => void
}
export type WatchEnvironment = (events: EnvironmentEvents) => () => void

// A sleeping phone can leave a socket half-open: the peer never learns it is gone, no close frame
// ever arrives, and the page keeps its last state. These browser signals are the only evidence that
// the page was away or that the network changed, so the store listens to them rather than trusting
// the socket. Nothing here talks to the server; the store decides what to do with each transition.
export const watchEnvironment: WatchEnvironment = (events) => {
  const onVisibility = () => events.visibility(document.visibilityState === 'hidden' ? 'hidden' : 'visible')
  const onOnline = () => events.online()
  const onOffline = () => events.offline()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  // Report where the page already is. A page that loads while hidden would otherwise never record
  // when it went away, so its first return would look like an ordinary tab switch and be skipped.
  onVisibility()
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  }
}
